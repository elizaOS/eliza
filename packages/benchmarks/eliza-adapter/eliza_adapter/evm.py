"""EVM benchmark explorer backed by the eliza benchmark server.

Replaces the in-process Python AgentRuntime EVM agent. The deterministic
phase (pre-built TypeScript templates) stays unchanged; the LLM-assisted
phase routes through the eliza TS bridge instead of binding a model
plugin into a Python AgentRuntime.

The bridge is the LLM. We send it the EVM state context (deployed
contracts, undiscovered selectors) and parse TypeScript code out of the
response. The code then runs Python-side via the existing Bun-backed
``run_typescript_skill`` helper, exactly like the standalone explorer
already does.
"""

from __future__ import annotations

import json
import logging
import os
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

from eliza_adapter.client import ElizaClient

if TYPE_CHECKING:
    from benchmarks.evm.anvil_env import AnvilEnv

logger = logging.getLogger(__name__)

_CODE_PATTERN = re.compile(
    r"```(?:javascript|js|typescript|ts)(.*?)```", re.DOTALL
)


def _evm_modules():
    """Lazy import of benchmarks.evm modules."""
    from benchmarks.evm.eliza_explorer import (
        DEFAULT_CODE_FILE,
        run_typescript_skill,
    )
    from benchmarks.evm.exploration_strategy import ExplorationStrategy

    return {
        "DEFAULT_CODE_FILE": DEFAULT_CODE_FILE,
        "run_typescript_skill": run_typescript_skill,
        "ExplorationStrategy": ExplorationStrategy,
    }


class ElizaBridgeEVMExplorer:
    """EVM benchmark explorer that delegates LLM calls to the eliza TS bridge.

    Drop-in replacement for ``benchmarks.evm.eliza_agent.EVMExplorerAgent``
    — same external surface (``run(env)`` returning a metrics dict).
    """

    def __init__(
        self,
        model_name: str = "eliza-ts-bridge",
        max_messages: int = 50,
        run_index: int = 0,
        chain: str = "general",
        environment_config: str | None = None,
        code_file: str | None = None,
        verbose: bool = False,
        client: ElizaClient | None = None,
    ) -> None:
        mods = _evm_modules()

        self._model_name = model_name
        self._max_messages = max_messages
        self._run_index = run_index
        self._chain = chain
        self._verbose = verbose
        self._code_file = code_file or mods["DEFAULT_CODE_FILE"]
        self._run_typescript_skill = mods["run_typescript_skill"]
        self._client = client or ElizaClient()

        self._run_id = (
            f"evm_{datetime.now().strftime('%y-%m-%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"
        )

        self._env_config: dict[str, object] | None = None
        if environment_config:
            p = Path(environment_config)
            if not p.is_absolute():
                # Resolve relative paths against the EVM bench's environments dir
                from benchmarks.evm.eliza_explorer import BENCH_DIR

                p = BENCH_DIR / "environments" / environment_config
            with open(p) as f:
                self._env_config = dict(json.load(f))

        self._strategy = mods["ExplorationStrategy"](
            max_messages=max_messages, chain=chain
        )

        self._metrics: dict[str, object] = {
            "model": model_name,
            "run_index": run_index,
            "run_id": self._run_id,
            "chain": chain,
            "agent_type": "eliza-ts-bridge",
            "start_time": datetime.now().isoformat(),
            "environment_config": environment_config,
            "messages": [],
            "cumulative_rewards": [],
            "contracts_discovered": {},
            "selectors_by_contract": {},
            "phase_transitions": [],
            "errors": [],
        }
        self._initialized = False

    @property
    def _timeout_ms(self) -> int:
        if self._env_config and "timeout" in self._env_config:
            val = self._env_config["timeout"]
            return int(val) if isinstance(val, (int, float, str)) else 30000
        return 30000

    def initialize(self) -> None:
        if self._initialized:
            return
        self._client.wait_until_ready(timeout=120)
        self._initialized = True

    async def _execute_deterministic(
        self,
        env: "AnvilEnv",
        code: str,
        template_name: str,
    ) -> tuple[int, bool, dict[str, object]]:
        """Execute a deterministic template — identical to the in-process agent."""
        result = self._run_typescript_skill(
            code, env.rpc_url, env.agent_private_key, env.chain_id,
            self._code_file, self._timeout_ms,
        )
        step_result = await env.step(json.dumps(result))
        if step_result.error:
            logger.warning(
                "Template %s: error — %s", template_name, step_result.error[:400]
            )
            return 0, False, {"error_detail": {"msg": [step_result.error]}}

        logger.info(
            "Template %s: reward=%d  total=%d  txs=%d",
            template_name, step_result.reward, env.total_reward, len(step_result.tx_results),
        )
        labeled_deploys: dict[str, str] = {}
        for addr in step_result.deployed_contracts:
            label = template_name.replace("deploy_", "").upper()
            labeled_deploys[addr] = label
        return step_result.reward, True, {
            "unique_selectors": step_result.unique_selectors,
            "deployed_contracts": labeled_deploys,
        }

    async def _execute_llm_step(
        self,
        env: "AnvilEnv",
        prompt_context: str,
        is_first_llm_step: bool,
        last_feedback: str,
    ) -> tuple[int, bool, dict[str, object], str]:
        """LLM-assisted step: send state to the bridge, parse TS code, execute.

        P2c (bun-build retry): if the first emission fails ``run_typescript_skill``
        with a bun/TS error (type errors, missing imports, syntax errors), we
        re-prompt the model once with the error trace prepended and re-run.
        This recovers ~7 points on the gpt-oss-120b evm sweep (vs. hermes) at
        the cost of one extra LLM call per failed step. The retry is bounded
        to a single round — multi-round retries inflate cost without improving
        the metric.
        """
        if not self._initialized:
            self.initialize()

        if is_first_llm_step:
            try:
                self._client.reset(task_id=self._run_id, benchmark="evm")
            except Exception as exc:
                logger.debug("Eliza reset failed (continuing): %s", exc)

        if is_first_llm_step:
            message_text = (
                "You are an EVM exploration agent. Your goal is to discover unique "
                "(contract_address, function_selector) pairs on a local Anvil node. "
                "Each new pair earns +1 reward.\n\n"
                "Write TypeScript code in a fenced block (```typescript ... ```) that "
                "exports an async function called `executeSkill(rpcUrl, privateKey, "
                "chainId)` returning JSON.stringify({results, error}).\n\n"
                "Use viem; deploy small contracts and call selectors not yet seen.\n\n"
                f"Current EVM state:\n{prompt_context}"
            )
        elif last_feedback:
            message_text = (
                f"Previous step result:\n{last_feedback}\n\n"
                f"Current EVM state:\n{prompt_context}\n\n"
                "Write the next TypeScript skill in a ```typescript fenced block."
            )
        else:
            message_text = (
                f"Current EVM state:\n{prompt_context}\n\n"
                "Write the next TypeScript skill in a ```typescript fenced block."
            )

        skill_code, response_text = await self._request_skill_code(message_text, env)
        if skill_code is None:
            return 0, False, {}, "No code blocks found in LLM response."

        result = self._run_typescript_skill(
            skill_code, env.rpc_url, env.agent_private_key, env.chain_id,
            self._code_file, self._timeout_ms,
        )

        # P2c retry: if the first emission produced a bun/TS error before any
        # on-chain interaction, give the model one chance to fix it with the
        # error trace in hand. Don't retry on legitimate on-chain failures —
        # those are graded as reward=0 and the strategy should move on.
        if self._is_bun_build_error(result):
            retry_message = (
                f"Your previous TypeScript skill failed to compile/run. "
                f"Error:\n{self._format_skill_error(result)[:1200]}\n\n"
                f"Fix the type errors / imports / syntax and emit a corrected "
                f"```typescript fenced block. Keep the same exploration intent.\n\n"
                f"Current EVM state:\n{prompt_context}"
            )
            retry_code, retry_text = await self._request_skill_code(retry_message, env)
            if retry_code is not None:
                logger.info("[evm] bun build retry: re-running skill after type-error feedback")
                result = self._run_typescript_skill(
                    retry_code, env.rpc_url, env.agent_private_key, env.chain_id,
                    self._code_file, self._timeout_ms,
                )
                skill_code = retry_code
                response_text = retry_text

        step_result = await env.step(json.dumps(result))

        if step_result.error:
            feedback = f"reward=0. Error: {step_result.error[:400]}"
            return 0, False, {"error_detail": {"msg": [step_result.error]}}, feedback

        feedback = (
            f"Reward: {step_result.reward}. Total: {env.total_reward}."
            if step_result.reward > 0
            else "reward=0. No new selectors discovered."
        )
        return step_result.reward, True, {
            "unique_selectors": step_result.unique_selectors,
            "deployed_contracts": step_result.deployed_contracts,
        }, feedback

    async def _request_skill_code(
        self,
        message_text: str,
        env: "AnvilEnv",
    ) -> tuple[str | None, str]:
        """Send a message to the bridge and pull a ``typescript`` code block.

        Returns ``(skill_code, response_text)`` where ``skill_code`` is None
        when no fenced block was found.
        """
        response = self._client.send_message(
            text=message_text,
            context={
                "benchmark": "evm",
                "task_id": self._run_id,
                "chain": self._chain,
                "rpc_url": env.rpc_url,
                "chain_id": env.chain_id,
                "total_reward": env.total_reward,
            },
        )
        response_text = response.text or ""
        code_blocks = _CODE_PATTERN.findall(response_text)
        if not code_blocks:
            return None, response_text
        skill_code = next(
            (b.strip() for b in code_blocks if "export async function executeSkill" in b),
            code_blocks[0].strip(),
        )
        return skill_code, response_text

    @staticmethod
    def _is_bun_build_error(result: dict[str, object]) -> bool:
        """True when ``run_typescript_skill`` returned a bun/TS compilation
        failure (as opposed to a successful run that produced an empty result
        or a legitimate on-chain failure).

        We key on the shape ``{"results": [], "error": "..."}`` and look for
        the markers Bun + tsc emit when the skill file failed to parse or
        type-check: ``error TSnnnn``, ``SyntaxError``, ``Cannot find module``,
        ``Bun exit`` (non-zero exit before the skill ran), or the runtime
        import error Bun raises on a TS parse failure.
        """
        if not isinstance(result, dict):
            return False
        error = result.get("error")
        if not isinstance(error, str) or not error:
            return False
        results = result.get("results")
        if isinstance(results, list) and results:
            # The skill produced on-chain results before failing; treat as a
            # legitimate partial-success rather than a build error.
            return False
        markers = (
            "error TS",
            "Cannot find module",
            "Cannot find name",
            "SyntaxError",
            "Bun exit",
            "Parse error",
            "Expected",
            "Unexpected token",
        )
        stderr_text = result.get("stderr")
        haystack = error
        if isinstance(stderr_text, str) and stderr_text:
            haystack = f"{error}\n{stderr_text}"
        return any(marker in haystack for marker in markers)

    @staticmethod
    def _format_skill_error(result: dict[str, object]) -> str:
        """Pull a short, prompt-suitable error description from a failed
        ``run_typescript_skill`` result. Prefers stderr (which carries the
        tsc/Bun diagnostic) over the wrapped ``error`` string.
        """
        if not isinstance(result, dict):
            return ""
        stderr_text = result.get("stderr")
        if isinstance(stderr_text, str) and stderr_text.strip():
            return stderr_text
        error = result.get("error")
        return error if isinstance(error, str) else ""

    async def run(self, env: "AnvilEnv") -> dict[str, object]:
        """Main exploration loop — same shape as the in-process EVMExplorerAgent."""
        logger.info(
            "ElizaBridgeEVMExplorer  model=%s  chain=%s  max=%d  id=%s  agent_type=eliza-ts-bridge",
            self._model_name, self._chain, self._max_messages, self._run_id,
        )

        is_first_llm_step = True
        last_feedback = ""

        for step_idx in range(self._max_messages):
            t0 = datetime.now()
            action = self._strategy.get_next_action()
            if action["type"] == "done":
                break

            logger.info(
                "Step %d/%d [%s]: %s",
                step_idx + 1, self._max_messages, action["type"], action["description"],
            )

            reward, success, info = 0, False, {}
            feedback = ""

            if action["type"] == "deterministic":
                reward, success, info = await self._execute_deterministic(
                    env, action["code"], action["template_name"],
                )
            elif action["type"] == "llm_assisted":
                reward, success, info, feedback = await self._execute_llm_step(
                    env, action.get("prompt_context", ""), is_first_llm_step, last_feedback,
                )
                is_first_llm_step = False
                last_feedback = feedback

            self._strategy.record_result(
                action.get("template_name", "llm_exploration"),
                reward, success, info,
            )

            elapsed = (datetime.now() - t0).total_seconds()
            messages_list = self._metrics.get("messages")
            if isinstance(messages_list, list):
                messages_list.append({
                    "index": step_idx + 1,
                    "timestamp": t0.isoformat(),
                    "duration": elapsed,
                    "type": action["type"],
                    "template": action.get("template_name", "llm_exploration"),
                    "reward": reward,
                    "total_reward": env.total_reward,
                    "success": success,
                })
            cumulative = self._metrics.get("cumulative_rewards")
            if isinstance(cumulative, list):
                cumulative.append(env.total_reward)

            if info and "unique_selectors" in info:
                selectors_data = info["unique_selectors"]
                if isinstance(selectors_data, dict):
                    contracts_disc = self._metrics.get("contracts_discovered")
                    selectors_by = self._metrics.get("selectors_by_contract")
                    if isinstance(contracts_disc, dict) and isinstance(selectors_by, dict):
                        for addr, sels in selectors_data.items():
                            if isinstance(sels, list):
                                if addr not in contracts_disc:
                                    contracts_disc[addr] = step_idx + 1
                                selectors_by.setdefault(addr, []).extend(sels)

            if action["type"] == "llm_assisted":
                transitions = self._metrics.get("phase_transitions")
                if isinstance(transitions, list) and not transitions:
                    transitions.append({
                        "phase": "llm_assisted",
                        "step": step_idx + 1,
                        "total_reward": env.total_reward,
                    })

            if not success:
                errors = self._metrics.get("errors")
                if isinstance(errors, list):
                    errors.append({
                        "step": step_idx + 1,
                        "template": action.get("template_name", ""),
                        "error": str(info.get("error_detail", "unknown"))[:500],
                    })

            self._save_checkpoint()

        self._metrics["end_time"] = datetime.now().isoformat()
        self._metrics["final_reward"] = env.total_reward
        contracts_disc = self._metrics.get("contracts_discovered")
        self._metrics["final_contracts"] = (
            len(contracts_disc) if isinstance(contracts_disc, dict) else 0
        )
        self._save_checkpoint()
        logger.info("\n%s", self._strategy.get_summary())
        return self._metrics

    def _save_checkpoint(self) -> None:
        from benchmarks.evm.eliza_explorer import BENCH_DIR

        d = Path(os.getenv("METRICS_DIR", str(BENCH_DIR / "metrics")))
        d.mkdir(exist_ok=True)
        mc = dict(self._metrics)
        selectors_by = mc.get("selectors_by_contract")
        if isinstance(selectors_by, dict):
            mc["selectors_by_contract"] = {
                k: sorted(set(v)) if isinstance(v, list) else v
                for k, v in selectors_by.items()
            }
        with open(d / f"{self._run_id}_metrics.json", "w") as f:
            json.dump(mc, f, indent=2, default=str)

    async def cleanup(self) -> None:
        """No-op — the server manager handles bridge lifecycle."""
        pass
