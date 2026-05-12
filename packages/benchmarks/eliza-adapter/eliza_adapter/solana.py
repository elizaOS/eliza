"""Solana benchmark explorer backed by the eliza benchmark server.

Drop-in replacement for the LLM-driven part of
``benchmarks.solana.eliza_explorer.ElizaExplorer``. Same external
interface (``run(env)``) returning the metrics dict, but the
"generate code" call goes through ``ElizaClient.send_message`` instead
of an in-process ``elizaos.AgentRuntime``.

The deterministic exploration phase (template-driven, no LLM) is
unchanged — it runs the same TypeScript skill builder via Bun. Only
the LLM-assisted compile-fix loop is rerouted.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from eliza_adapter.client import ElizaClient

if TYPE_CHECKING:
    from voyager.surfpool_env import SurfpoolEnv


def _solana_imports():
    """Lazy imports so the adapter loads even when benchmarks/solana isn't on sys.path."""
    from benchmarks.solana.eliza_explorer import GYM_ENV_DIR, run_typescript_skill
    from benchmarks.solana.exploration_strategy import ExplorationStrategy
    from solders.transaction import Transaction as SoldersTransaction

    return GYM_ENV_DIR, run_typescript_skill, ExplorationStrategy, SoldersTransaction


logger = logging.getLogger(__name__)


_CODE_PATTERN = re.compile(r"```(?:javascript|js|typescript|ts)(.*?)```", re.DOTALL)
_MAX_COMPILE_RETRIES = 4


def _extract_skill_code(response_text: str) -> str | None:
    """Pull the first executeSkill TypeScript block out of an LLM response."""
    blocks = _CODE_PATTERN.findall(response_text or "")
    if not blocks:
        return None
    for b in blocks:
        if "export async function executeSkill" in b:
            return b.strip()
    return blocks[0].strip()


class ElizaBridgeSolanaExplorer:
    """Solana benchmark explorer that delegates LLM calls to the eliza TS bridge.

    Mirrors the public surface of ``benchmarks.solana.eliza_explorer.ElizaExplorer``:

      - ``run(env) -> metrics_dict``
      - writes ``metrics/{run_id}_metrics.json`` checkpoints

    Internally the deterministic + LLM-assisted exploration loop remains
    identical; only ``_execute_llm_step`` is reimplemented to send the
    code-generation prompt through ``ElizaClient.send_message``.
    """

    def __init__(
        self,
        model_name: str = "claude-opus-4-7",
        max_messages: int = 50,
        run_index: int = 0,
        environment_config: str | None = None,
        code_file: str | None = None,
        client: ElizaClient | None = None,
    ) -> None:
        GYM_ENV_DIR, _, ExplorationStrategy, _ = _solana_imports()

        self.model_name = model_name
        self.max_messages = max_messages
        self.run_index = run_index
        self.code_file = code_file or str(
            GYM_ENV_DIR / "voyager" / "skill_runner" / "eliza_skill.ts"
        )
        self.run_id = (
            f"eliza_bridge_{datetime.now().strftime('%y-%m-%d_%H%M%S')}"
            f"_{uuid.uuid4().hex[:8]}"
        )

        self.env_config: dict | None = None
        if environment_config:
            p = Path(environment_config)
            if not p.is_absolute():
                p = GYM_ENV_DIR / environment_config
            with open(p) as f:
                self.env_config = json.load(f)

        self.strategy = ExplorationStrategy(max_messages=max_messages)
        self._client = client or ElizaClient()
        self._initialized = False
        self._server_mgr = None
        self.metrics: dict = {
            "model": model_name,
            "run_index": run_index,
            "run_id": self.run_id,
            "start_time": datetime.now().isoformat(),
            "environment_config": environment_config,
            "messages": [],
            "cumulative_rewards": [],
            "programs_discovered": {},
            "instructions_by_program": {},
            "phase_transitions": [],
            "errors": [],
            "transport": "eliza-bridge",
        }

    @property
    def _timeout_ms(self) -> int:
        return (self.env_config or {}).get("timeout", 30000)

    def _ensure_ready(self) -> None:
        if not self._initialized:
            if not os.environ.get("ELIZA_BENCH_URL"):
                from eliza_adapter.server_manager import ElizaServerManager

                self._server_mgr = ElizaServerManager()
                self._server_mgr.start()
                os.environ["ELIZA_BENCH_TOKEN"] = self._server_mgr.token
                os.environ.setdefault(
                    "ELIZA_BENCH_URL", f"http://localhost:{self._server_mgr.port}"
                )
                self._client = self._server_mgr.client
            self._client.wait_until_ready(timeout=120)
            try:
                self._client.reset(task_id=self.run_id, benchmark="solana")
            except Exception as exc:
                logger.debug("[eliza-solana] reset failed (continuing): %s", exc)
            self._initialized = True

    async def _generate_code(self, prompt: str) -> str:
        """Forward the prompt to the eliza TS bridge and return the response text."""
        self._ensure_ready()
        response = self._client.send_message(
            text=prompt,
            context={
                "benchmark": "solana",
                "task_id": self.run_id,
                "model_name": self.model_name,
                "phase": "llm_exploration",
            },
        )
        return response.text or ""

    async def _execute_deterministic(
        self, env: "SurfpoolEnv", code: str, template_name: str
    ) -> tuple[int, bool, dict]:
        _, run_typescript_skill, _, SoldersTransaction = _solana_imports()
        blockhash = str((await env.client.get_latest_blockhash()).value.blockhash)
        agent_pubkey = str(env.agent_keypair.pubkey())
        result = run_typescript_skill(
            code, agent_pubkey, blockhash, self.code_file, self._timeout_ms
        )
        tx_data = result.get("serialized_tx")
        if not tx_data:
            logger.warning(
                "[eliza-solana] template %s: no tx — %s", template_name, str(result)[:400]
            )
            return 0, False, {"error": str(result)[:1000]}

        tx = SoldersTransaction.from_bytes(base64.b64decode(tx_data))
        signed = env._partial_sign_transaction(bytes(tx), [env.agent_keypair])
        _, reward, _, _, info = await env.step(signed)
        logger.info(
            "[eliza-solana] template %s: reward=%d total=%d", template_name, reward, env.total_reward
        )
        return reward, True, info

    async def _execute_llm_step(
        self, env: "SurfpoolEnv", prompt_context: str
    ) -> tuple[int, bool, dict]:
        _, run_typescript_skill, _, SoldersTransaction = _solana_imports()
        agent_pubkey = str(env.agent_keypair.pubkey())

        prompt = (
            "Discover new Solana program instructions.\n\n"
            f"Agent pubkey: {agent_pubkey}\n"
            "Connection: http://localhost:8899\n\n"
            f"{prompt_context}\n\n"
            "Write a COMPLETE ```typescript block with:\n"
            "  export async function executeSkill(blockhash: string): Promise<string>\n"
            "Return base64 serialized transaction. Respond with ONLY the code block."
        )

        logger.info("[eliza-solana] LLM generate via bridge (model=%s)...", self.model_name)
        response_text = await self._generate_code(prompt)

        skill_code: str | None = None
        tx_data: str | None = None
        attempt = 0
        for attempt in range(_MAX_COMPILE_RETRIES):
            skill_code = _extract_skill_code(response_text)
            if skill_code is None:
                if attempt < _MAX_COMPILE_RETRIES - 1:
                    response_text = await self._generate_code(
                        "Your response had no ```typescript code blocks. "
                        "Respond with ONLY a ```typescript block containing executeSkill."
                    )
                    continue
                return 0, False, {"error": "no_code_blocks_after_retries"}

            blockhash = str((await env.client.get_latest_blockhash()).value.blockhash)
            bun_result = run_typescript_skill(
                skill_code, agent_pubkey, blockhash, self.code_file, self._timeout_ms
            )
            tx_data = bun_result.get("serialized_tx")
            if tx_data:
                logger.info(
                    "[eliza-solana] attempt %d compiled OK, tx=%d bytes",
                    attempt + 1,
                    len(tx_data),
                )
                break

            error_msg = bun_result.get("error", "Unknown")
            stderr = bun_result.get("stderr", "")
            details = bun_result.get("details", "")
            error_context = f"{error_msg}\n{details}\n{stderr}"[:1500]

            if attempt < _MAX_COMPILE_RETRIES - 1:
                response_text = await self._generate_code(
                    "Your TypeScript failed. Fix the error.\n\n"
                    f"ERROR:\n{error_context}\n\n"
                    f"CODE:\n```typescript\n{skill_code}\n```\n\n"
                    "Return ONLY the corrected ```typescript block."
                )
            else:
                logger.warning(
                    "[eliza-solana] exhausted %d compile retries", _MAX_COMPILE_RETRIES
                )
                return 0, False, {"error": f"compile_failed: {error_context[:300]}"}

        if not tx_data:
            return 0, False, {"error": "no_valid_code"}

        # Fix base64 padding if needed
        padded = tx_data + "=" * (-len(tx_data) % 4)
        tx = SoldersTransaction.from_bytes(base64.b64decode(padded))
        signed = env._partial_sign_transaction(bytes(tx), [env.agent_keypair])
        _, reward, _, _, info = await env.step(signed)
        logger.info(
            "[eliza-solana] LLM step: reward=%d total=%d (attempt %d)",
            reward,
            env.total_reward,
            attempt + 1,
        )
        return reward, True, info

    async def run(self, env: "SurfpoolEnv") -> dict:
        self._ensure_ready()
        logger.info(
            "[eliza-solana] explorer model=%s max=%d id=%s",
            self.model_name,
            self.max_messages,
            self.run_id,
        )

        for step_idx in range(self.max_messages):
            t0 = datetime.now()
            action = self.strategy.get_next_action(str(env.agent_keypair.pubkey()))
            if action["type"] == "done":
                break

            logger.info(
                "\n%s\nStep %d/%d [%s]: %s\n%s",
                "=" * 60,
                step_idx + 1,
                self.max_messages,
                action["type"],
                action["description"],
                "=" * 60,
            )

            reward, success, info = 0, False, {}
            if action["type"] == "deterministic":
                reward, success, info = await self._execute_deterministic(
                    env, action["code"], action["template_name"]
                )
            elif action["type"] == "llm_assisted":
                reward, success, info = await self._execute_llm_step(
                    env, action["prompt_context"]
                )

            self.strategy.record_result(
                action.get("template_name", "unknown"), reward, success, info
            )

            elapsed = (datetime.now() - t0).total_seconds()
            self.metrics["messages"].append(
                {
                    "index": step_idx + 1,
                    "timestamp": t0.isoformat(),
                    "duration": elapsed,
                    "type": action["type"],
                    "template": action.get("template_name", "llm"),
                    "reward": reward,
                    "total_reward": env.total_reward,
                    "success": success,
                }
            )
            self.metrics["cumulative_rewards"].append(env.total_reward)

            if info and "unique_instructions" in info:
                for prog_id, discs in info["unique_instructions"].items():
                    if prog_id not in self.metrics["programs_discovered"]:
                        self.metrics["programs_discovered"][prog_id] = step_idx + 1
                    self.metrics["instructions_by_program"].setdefault(
                        prog_id, []
                    ).extend(discs)

            if action["type"] == "llm_assisted" and not self.metrics["phase_transitions"]:
                self.metrics["phase_transitions"].append(
                    {
                        "phase": "llm_assisted",
                        "step": step_idx + 1,
                        "total_reward": env.total_reward,
                    }
                )

            if not success:
                self.metrics["errors"].append(
                    {
                        "step": step_idx + 1,
                        "template": action.get("template_name", ""),
                        "error": str(info.get("error", "unknown"))[:500],
                    }
                )

            self._save_checkpoint()

        self.metrics["end_time"] = datetime.now().isoformat()
        self.metrics["final_reward"] = env.total_reward
        self.metrics["final_programs"] = len(self.metrics["programs_discovered"])
        self._save_checkpoint()
        logger.info("\n%s", self.strategy.get_summary())
        return self.metrics

    def _save_checkpoint(self) -> None:
        GYM_ENV_DIR, *_ = _solana_imports()
        d = GYM_ENV_DIR / "metrics"
        d.mkdir(exist_ok=True)
        mc = dict(self.metrics)
        mc["instructions_by_program"] = {
            k: sorted(set(v)) for k, v in mc.get("instructions_by_program", {}).items()
        }
        with open(d / f"{self.run_id}_metrics.json", "w") as f:
            json.dump(mc, f, indent=2)
