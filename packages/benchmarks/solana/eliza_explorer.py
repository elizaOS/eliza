"""
Eliza-powered Solana benchmark explorer.

Routes LLM calls through runtime.message_service.handle_message() — the real
Eliza agent processing pipeline (state composition, model call, action execution).

Usage:
    surfpool start -u https://api.mainnet-beta.solana.com --no-tui
    USE_EXTERNAL_SURFPOOL=true python -m benchmarks.solana.eliza_explorer
"""

import asyncio
import base64
import json
import logging
import os
import re
import subprocess
import sys
import uuid
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv

GYM_ENV_DIR = Path(__file__).parent / "solana-gym-env"
sys.path.insert(0, str(GYM_ENV_DIR))

from voyager.surfpool_env import SurfpoolEnv, _surfpool_validator
from solders.transaction import Transaction as SoldersTransaction

from benchmarks.solana.exploration_strategy import ExplorationStrategy

load_dotenv()
load_dotenv(GYM_ENV_DIR / ".env", override=False)
# Load Eliza .env for API keys
load_dotenv(Path(__file__).parent.parent.parent / "eliza" / ".env", override=False)

logger = logging.getLogger(__name__)

ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-opus-4-6")


def run_typescript_skill(code: str, agent_pubkey: str, blockhash: str,
                         code_file: str, timeout_ms: int = 30000) -> dict:
    """Write code to file, run via Bun's runSkill.ts, return parsed JSON result."""
    with open(code_file, "w") as f:
        f.write(code)

    runner = str(GYM_ENV_DIR / "voyager" / "skill_runner" / "runSkill.ts")
    completed = subprocess.run(
        ["bun", runner, code_file, str(timeout_ms), agent_pubkey, blockhash],
        capture_output=True, text=True, encoding="utf-8", cwd=str(GYM_ENV_DIR),
    )

    stdout_lines = (completed.stdout or "").strip().split("\n")
    last_line = stdout_lines[-1] if stdout_lines else ""

    if completed.returncode == 0:
        return json.loads(last_line)

    if last_line:
        parsed = json.loads(last_line)
        if completed.stderr:
            parsed["stderr"] = completed.stderr[:2000]
        return parsed

    return {"serialized_tx": None, "error": f"Bun exit {completed.returncode}",
            "stderr": (completed.stderr or "")[:2000]}


async def _create_eliza_runtime():
    """Create and initialize an Eliza AgentRuntime with Anthropic model handler."""
    from elizaos.runtime import AgentRuntime
    from elizaos.types.agent import Character
    from benchmarks.solana.eliza_model_plugin import anthropic_model_plugin

    character = Character(
        name="SolanaExplorer",
        bio="Expert Solana blockchain developer. Discovers unique program instructions by writing TypeScript that compiles and executes correctly.",
        system=(
            "You are an expert Solana developer. Your goal is to write TypeScript code that discovers "
            "unique Solana program instructions.\n\n"
            "CRITICAL: Your <text> response MUST contain a ```typescript code block with:\n"
            "  export async function executeSkill(blockhash: string): Promise<string>\n"
            "The code MUST compile under Bun. Return base64 serialized transaction.\n"
            "Max ~60 instructions per tx. partialSign() for new Keypair accounts.\n"
            "Token-2022 extensions init BEFORE InitializeMint2.\n"
            "CONNECTION: http://localhost:8899\n"
            "PACKAGES: @solana/web3.js @solana/spl-token @coral-xyz/anchor bs58 bn.js\n"
            "REWARD: +1 per unique (program_id, first_byte_of_instruction_data).\n"
            "If code fails, you get the error and must fix it. Write correct code first time."
        ),
    )

    runtime = AgentRuntime(
        character=character,
        plugins=[anthropic_model_plugin],
        log_level="INFO",
        check_should_respond=False,  # always respond (benchmark mode)
    )
    await runtime.initialize()
    logger.info("Eliza runtime initialized: model=%s, character=%s", ANTHROPIC_MODEL, character.name)
    return runtime


class ElizaExplorer:
    """
    Phase 1 (Deterministic): pre-built templates, no LLM needed.
    Phase 2 (LLM via Eliza runtime): calls runtime.message_service.handle_message().
    """

    def __init__(self, model_name: str = "claude-opus-4-6", max_messages: int = 50,
                 run_index: int = 0, environment_config: str | None = None,
                 code_file: str | None = None):
        self.model_name = model_name
        self.max_messages = max_messages
        self.run_index = run_index
        self.code_file = code_file or str(GYM_ENV_DIR / "voyager" / "skill_runner" / "eliza_skill.ts")
        self.run_id = f"eliza_{datetime.now().strftime('%y-%m-%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"

        self.env_config: dict | None = None
        if environment_config:
            p = Path(environment_config) if Path(environment_config).is_absolute() else GYM_ENV_DIR / environment_config
            with open(p) as f:
                self.env_config = json.load(f)

        self.strategy = ExplorationStrategy(max_messages=max_messages)
        self._runtime = None  # lazy init
        self.code_pattern = re.compile(r"```(?:javascript|js|typescript|ts)(.*?)```", re.DOTALL)
        self.metrics: dict = {
            "model": model_name, "run_index": run_index, "run_id": self.run_id,
            "start_time": datetime.now().isoformat(), "environment_config": environment_config,
            "messages": [], "cumulative_rewards": [], "programs_discovered": {},
            "instructions_by_program": {}, "phase_transitions": [], "errors": [],
        }

    @property
    def _timeout_ms(self) -> int:
        return (self.env_config or {}).get("timeout", 30000)

    async def _ensure_runtime(self):
        if self._runtime is None:
            self._runtime = await _create_eliza_runtime()
        return self._runtime

    async def _execute_deterministic(self, env: SurfpoolEnv, code: str, template_name: str) -> tuple[int, bool, dict]:
        blockhash = str((await env.client.get_latest_blockhash()).value.blockhash)
        agent_pubkey = str(env.agent_keypair.pubkey())
        result = run_typescript_skill(code, agent_pubkey, blockhash, self.code_file, self._timeout_ms)

        tx_data = result.get("serialized_tx")
        if not tx_data:
            logger.warning("Template %s: no tx — %s", template_name, str(result)[:400])
            return 0, False, {"error": str(result)[:1000]}

        tx = SoldersTransaction.from_bytes(base64.b64decode(tx_data))
        signed = env._partial_sign_transaction(bytes(tx), [env.agent_keypair])
        obs, reward, _, _, info = await env.step(signed)
        logger.info("Template %s: reward=%d  total=%d  programs=%s",
                     template_name, reward, env.total_reward, info.get("programs_interacted", []))
        return reward, True, info

    MAX_COMPILE_RETRIES = 4

    async def _generate_code(self, runtime, prompt: str) -> str:
        """Call the LLM through runtime.use_model (Eliza model dispatch) for code generation."""
        from elizaos.types.model import ModelType
        return await runtime.use_model(
            ModelType.TEXT_LARGE,
            {"prompt": prompt, "system": runtime.character.system, "temperature": 0.7, "max_tokens": 8192},
        )

    async def _execute_llm_step(self, env: SurfpoolEnv, prompt_context: str) -> tuple[int, bool, dict]:
        """Generate code via runtime.use_model, compile-test-fix loop, then submit."""
        runtime = await self._ensure_runtime()
        agent_pubkey = str(env.agent_keypair.pubkey())

        prompt = (
            f"Discover new Solana program instructions.\n\n"
            f"Agent pubkey: {agent_pubkey}\n"
            f"Connection: http://localhost:8899\n\n"
            f"{prompt_context}\n\n"
            "Write a COMPLETE ```typescript block with:\n"
            "  export async function executeSkill(blockhash: string): Promise<string>\n"
            "Return base64 serialized transaction. Respond with ONLY the code block."
        )

        logger.info("LLM generate via runtime.use_model (model=%s)...", ANTHROPIC_MODEL)
        response_text = await self._generate_code(runtime, prompt)

        for attempt in range(self.MAX_COMPILE_RETRIES):
            code_blocks = self.code_pattern.findall(response_text)
            if not code_blocks:
                if attempt < self.MAX_COMPILE_RETRIES - 1:
                    logger.info("Attempt %d: no code blocks, retrying...", attempt + 1)
                    response_text = await self._generate_code(runtime,
                        "Your response had no ```typescript code blocks. "
                        "Respond with ONLY a ```typescript block containing executeSkill.")
                    continue
                return 0, False, {"error": "no_code_blocks_after_retries"}

            skill_code = next(
                (b.strip() for b in code_blocks if "export async function executeSkill" in b),
                code_blocks[0].strip(),
            )

            blockhash = str((await env.client.get_latest_blockhash()).value.blockhash)
            bun_result = run_typescript_skill(skill_code, agent_pubkey, blockhash, self.code_file, self._timeout_ms)

            tx_data = bun_result.get("serialized_tx")
            if tx_data:
                logger.info("Attempt %d: compiled OK, tx=%d bytes", attempt + 1, len(tx_data))
                break

            error_msg = bun_result.get("error", "Unknown")
            stderr = bun_result.get("stderr", "")
            details = bun_result.get("details", "")
            error_context = f"{error_msg}\n{details}\n{stderr}"[:1500]

            if attempt < self.MAX_COMPILE_RETRIES - 1:
                logger.info("Attempt %d: compile error, asking LLM to fix...", attempt + 1)
                response_text = await self._generate_code(runtime,
                    f"Your TypeScript failed. Fix the error.\n\n"
                    f"ERROR:\n{error_context}\n\n"
                    f"CODE:\n```typescript\n{skill_code}\n```\n\n"
                    "Return ONLY the corrected ```typescript block.")
            else:
                logger.warning("Exhausted %d compile retries", self.MAX_COMPILE_RETRIES)
                return 0, False, {"error": f"compile_failed: {error_context[:300]}"}
        else:
            return 0, False, {"error": "no_valid_code"}

        # Fix base64 padding if needed (LLM-generated code sometimes drops trailing =)
        padded = tx_data + "=" * (-len(tx_data) % 4)
        tx = SoldersTransaction.from_bytes(base64.b64decode(padded))
        signed = env._partial_sign_transaction(bytes(tx), [env.agent_keypair])
        obs, reward, _, _, info = await env.step(signed)
        logger.info("LLM step: reward=%d  total=%d  (attempt %d)", reward, env.total_reward, attempt + 1)
        return reward, True, info

    async def run(self, env: SurfpoolEnv) -> dict:
        logger.info("Eliza Explorer  model=%s  max=%d  id=%s", self.model_name, self.max_messages, self.run_id)

        for step_idx in range(self.max_messages):
            t0 = datetime.now()
            action = self.strategy.get_next_action(str(env.agent_keypair.pubkey()))
            if action["type"] == "done":
                break

            logger.info("\n%s\nStep %d/%d [%s]: %s\n%s",
                        "=" * 60, step_idx + 1, self.max_messages,
                        action["type"], action["description"], "=" * 60)

            reward, success, info = 0, False, {}
            if action["type"] == "deterministic":
                reward, success, info = await self._execute_deterministic(env, action["code"], action["template_name"])
            elif action["type"] == "llm_assisted":
                reward, success, info = await self._execute_llm_step(env, action["prompt_context"])

            self.strategy.record_result(action.get("template_name", "unknown"), reward, success, info)

            elapsed = (datetime.now() - t0).total_seconds()
            self.metrics["messages"].append({
                "index": step_idx + 1, "timestamp": t0.isoformat(), "duration": elapsed,
                "type": action["type"], "template": action.get("template_name", "llm"),
                "reward": reward, "total_reward": env.total_reward, "success": success,
            })
            self.metrics["cumulative_rewards"].append(env.total_reward)

            if info and "unique_instructions" in info:
                for prog_id, discs in info["unique_instructions"].items():
                    if prog_id not in self.metrics["programs_discovered"]:
                        self.metrics["programs_discovered"][prog_id] = step_idx + 1
                    self.metrics["instructions_by_program"].setdefault(prog_id, []).extend(discs)

            if action["type"] == "llm_assisted" and not self.metrics["phase_transitions"]:
                self.metrics["phase_transitions"].append(
                    {"phase": "llm_assisted", "step": step_idx + 1, "total_reward": env.total_reward})

            if not success:
                self.metrics["errors"].append({
                    "step": step_idx + 1, "template": action.get("template_name", ""),
                    "error": str(info.get("error", "unknown"))[:500]})

            self._save_checkpoint()

        self.metrics["end_time"] = datetime.now().isoformat()
        self.metrics["final_reward"] = env.total_reward
        self.metrics["final_programs"] = len(self.metrics["programs_discovered"])
        self._save_checkpoint()
        logger.info("\n%s", self.strategy.get_summary())
        return self.metrics

    def _save_checkpoint(self) -> None:
        d = GYM_ENV_DIR / "metrics"
        d.mkdir(exist_ok=True)
        mc = dict(self.metrics)
        mc["instructions_by_program"] = {k: sorted(set(v)) for k, v in mc.get("instructions_by_program", {}).items()}
        with open(d / f"{self.run_id}_metrics.json", "w") as f:
            json.dump(mc, f, indent=2)


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-7s  %(message)s",
                        force=True, handlers=[logging.StreamHandler(sys.stdout)])

    model_name = os.getenv("MODEL_NAME", "claude-opus-4-6")
    max_messages = int(os.getenv("MAX_MESSAGES", "50"))
    run_index = int(os.getenv("RUN_INDEX", "0"))
    environment_config = os.getenv("ENVIRONMENT_CONFIG")
    use_external = os.getenv("USE_EXTERNAL_SURFPOOL", "false").lower() == "true"

    logger.info("Model: %s  Messages: %d  Env: %s  External: %s",
                model_name, max_messages, environment_config or "basic", use_external)

    explorer = ElizaExplorer(model_name=model_name, max_messages=max_messages,
                             run_index=run_index, environment_config=environment_config,
                             code_file=os.getenv("CODE_FILE"))

    allowed = []
    if explorer.env_config and "reward_config" in explorer.env_config:
        allowed = explorer.env_config["reward_config"].get("allowed_programs", [])

    async def go(env: SurfpoolEnv) -> None:
        await env.reset()
        logger.info("Agent: %s", env.agent_keypair.pubkey())
        m = await explorer.run(env)
        logger.info("=== FINAL ===  reward=%d  programs=%d", m["final_reward"], m["final_programs"])
        await env.close()

    if use_external:
        await go(SurfpoolEnv(allowed_programs=allowed, use_external_surfpool=True))
    else:
        async with _surfpool_validator("https://api.mainnet-beta.solana.com"):
            await go(SurfpoolEnv(allowed_programs=allowed, use_external_surfpool=True))


if __name__ == "__main__":
    asyncio.run(main())
