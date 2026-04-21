"""
Eliza-powered Solana benchmark agent using the full ElizaOS runtime.

Two-phase exploration:
  Phase 1 (Deterministic): pre-built TypeScript templates executed directly
    through execute_solana_skill (shared action logic). No LLM needed.
  Phase 2 (LLM-Assisted): messages routed through
    runtime.message_service.handle_message() with EXECUTE_CODE action and
    SOLANA_CONTEXT provider.

Usage:
    surfpool start -u https://api.mainnet-beta.solana.com --no-tui
    USE_EXTERNAL_SURFPOOL=true python -m benchmarks.solana.eliza_agent
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import uuid
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

from dotenv import load_dotenv

from elizaos import AgentRuntime
from elizaos.types import Plugin
from elizaos.types.agent import Character
from elizaos.types.memory import Memory
from elizaos.types.primitives import Content, as_uuid, string_to_uuid

from benchmarks.solana.exploration_strategy import ExplorationStrategy
from benchmarks.solana.plugin import solana_bench_plugin
from benchmarks.solana.plugin.actions.execute_code import execute_solana_skill

GYM_ENV_DIR = Path(__file__).parent / "solana-gym-env"
sys.path.insert(0, str(GYM_ENV_DIR))

if TYPE_CHECKING:
    from voyager.surfpool_env import SurfpoolEnv

load_dotenv()
load_dotenv(GYM_ENV_DIR / ".env", override=False)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Message handler template for LLM-assisted Phase 2
# ---------------------------------------------------------------------------

SOLANA_MESSAGE_TEMPLATE = (
    "<task>Generate dialog and actions for the character {{agentName}}.</task>\n"
    "\n"
    "<providers>\n"
    "{{providers}}\n"
    "</providers>\n"
    "\n"
    "<instructions>\n"
    "You are a Solana expert exploring program interactions on a local validator.\n"
    "Your goal is to discover unique (program_id, first_byte_of_instruction_data)\n"
    "pairs for maximum reward.\n"
    "\n"
    "Available actions:\n"
    "- EXECUTE_CODE (required param: code) — TypeScript code to execute against Solana\n"
    "\n"
    "CRITICAL RULES:\n"
    "- Write TypeScript with: export async function executeSkill(blockhash: string): Promise<string>\n"
    "- Return a base64-encoded serialized transaction\n"
    "- Use @solana/web3.js and @solana/spl-token\n"
    "- Max ~60 instructions per transaction (Surfpool limit)\n"
    "- Transaction size limit: 1232 bytes\n"
    "- Use partialSign() for new Keypairs\n"
    "- Token-2022 extensions MUST be initialized BEFORE InitializeMint2\n"
    "\n"
    "REWARD: +1 per unique (program_id, first_byte_of_instruction_data) pair.\n"
    "\n"
    "STRATEGY:\n"
    "- Review the SOLANA_CONTEXT provider for undiscovered programs and discriminators\n"
    "- Target EASY discriminators first\n"
    "- Pack multiple instructions per transaction for efficiency\n"
    "- If a transaction fails, analyze the error and adjust\n"
    "</instructions>\n"
    "\n"
    "<output>\n"
    "Respond using XML format:\n"
    "<response>\n"
    "  <thought>Plan for what to explore next</thought>\n"
    "  <actions>REPLY,EXECUTE_CODE</actions>\n"
    "  <providers>SOLANA_CONTEXT</providers>\n"
    "  <text>Brief description of exploration</text>\n"
    "  <params>\n"
    "    <EXECUTE_CODE>\n"
    "      <code>\n"
    "import { Transaction, PublicKey } from '@solana/web3.js';\n"
    "\n"
    "export async function executeSkill(blockhash: string): Promise<string> {\n"
    "    const tx = new Transaction();\n"
    "    // ... build transaction ...\n"
    "    tx.recentBlockhash = blockhash;\n"
    "    tx.feePayer = new PublicKey('AGENT_PUBKEY');\n"
    "    return tx.serialize({ requireAllSignatures: false, verifySignatures: false })"
    ".toString('base64');\n"
    "}\n"
    "      </code>\n"
    "    </EXECUTE_CODE>\n"
    "  </params>\n"
    "</response>\n"
    "</output>"
)


# ---------------------------------------------------------------------------
# Model plugin helper
# ---------------------------------------------------------------------------


def _get_model_plugin(model_name: str) -> Plugin:
    """Get a model provider plugin for LLM calls.

    Checks available API keys in order:
      1. ANTHROPIC_API_KEY → try elizaos_plugin_anthropic
      2. OPENAI_API_KEY → use elizaos_plugin_openai
      3. OPENROUTER_API_KEY → use elizaos_plugin_openai with OpenRouter base URL
    """
    clean_model = model_name.split("/")[-1] if "/" in model_name else model_name
    openai_base_url = os.getenv("OPENAI_BASE_URL", "").strip()

    anthropic_key = os.getenv("ANTHROPIC_API_KEY", "")
    openai_key = os.getenv("OPENAI_API_KEY", "")
    openrouter_key = os.getenv("OPENROUTER_API_KEY", "")

    # Try Anthropic plugin first if key available
    if anthropic_key:
        try:
            from elizaos_plugin_anthropic import get_anthropic_plugin

            os.environ.setdefault("ANTHROPIC_SMALL_MODEL", clean_model)
            os.environ.setdefault("ANTHROPIC_LARGE_MODEL", clean_model)
            logger.info("Model plugin: Anthropic (%s)", clean_model)
            return get_anthropic_plugin()
        except ImportError:
            logger.info(
                "elizaos_plugin_anthropic not found, falling back to OpenAI plugin"
            )

    # Configure OpenAI or OpenRouter
    if openrouter_key and not openai_key:
        os.environ["OPENAI_API_KEY"] = openrouter_key
        os.environ.setdefault("OPENAI_BASE_URL", "https://openrouter.ai/api/v1")
        # OpenRouter uses full model names (e.g. "anthropic/claude-sonnet-4")
        os.environ.setdefault("OPENAI_SMALL_MODEL", model_name)
        os.environ.setdefault("OPENAI_LARGE_MODEL", model_name)
        logger.info("Model plugin: OpenRouter (%s)", model_name)
    elif openai_key:
        openai_model = model_name if (openai_base_url and "/" in model_name) else clean_model
        os.environ.setdefault("OPENAI_SMALL_MODEL", openai_model)
        os.environ.setdefault("OPENAI_LARGE_MODEL", openai_model)
        logger.info("Model plugin: OpenAI (%s)", openai_model)
    elif anthropic_key:
        # Anthropic key without plugin — cannot proceed
        raise RuntimeError(
            "ANTHROPIC_API_KEY found but elizaos_plugin_anthropic not installed. "
            "Either install it or use OPENAI_API_KEY / OPENROUTER_API_KEY."
        )
    else:
        raise RuntimeError(
            "Phase 2 requires an LLM API key. Set one of: "
            "ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY"
        )

    try:
        from elizaos_plugin_openai import get_openai_plugin

        return get_openai_plugin()
    except ImportError:
        raise RuntimeError(
            "elizaos_plugin_openai not found. Install with:\n"
            "  pip install elizaos-plugin-openai"
        )


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------


class SolanaElizaAgent:
    """
    Solana benchmark agent using the full ElizaOS runtime.

    Phase 1 (Deterministic):
        Pre-built templates executed directly through :func:`execute_solana_skill`.
        No LLM calls are needed — the templates are known-good TypeScript
        skills that exercise specific program discriminators.

    Phase 2 (LLM-Assisted):
        Messages routed through ``runtime.message_service.handle_message()``.
        The ``EXECUTE_CODE`` action is invoked by the runtime when the LLM
        generates code, and the ``SOLANA_CONTEXT`` provider feeds discovery
        state into the model's context window.
    """

    def __init__(
        self,
        model_name: str = "anthropic/claude-sonnet-4",
        max_messages: int = 50,
        run_index: int = 0,
        environment_config: str | None = None,
        code_file: str | None = None,
    ) -> None:
        self.model_name = model_name
        self.max_messages = max_messages
        self.run_index = run_index
        self.code_file = code_file or str(
            GYM_ENV_DIR / "voyager" / "skill_runner" / "eliza_skill.ts"
        )
        self.run_id = (
            f"eliza_{datetime.now().strftime('%y-%m-%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"
        )

        self.env_config: dict[str, int | str | float | dict[str, list[str]]] | None = (
            None
        )
        if environment_config:
            p = (
                Path(environment_config)
                if Path(environment_config).is_absolute()
                else GYM_ENV_DIR / environment_config
            )
            with open(p) as f:
                self.env_config = json.load(f)

        self.strategy = ExplorationStrategy(max_messages=max_messages)
        self._runtime: AgentRuntime | None = None

        self.metrics: dict[str, object] = {
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
        }

    # -- Properties ------------------------------------------------------

    @property
    def _timeout_ms(self) -> int:
        if self.env_config and "timeout" in self.env_config:
            val = self.env_config["timeout"]
            return int(val) if isinstance(val, (int, float, str)) else 30000
        return 30000

    # -- Runtime initialisation ------------------------------------------

    async def _initialize_runtime(self) -> AgentRuntime:
        """Create and initialise the full ElizaOS runtime with plugins."""
        character = Character(
            name="SolanaExplorer",
            username="solana_explorer",
            bio=(
                "A Solana exploration agent that discovers unique program "
                "interactions and transaction patterns on a local validator."
            ),
            system=(
                "You are a Solana expert. Generate TypeScript code to interact "
                "with Solana programs on a local validator. Discover unique "
                "program interactions and transaction patterns. Use the "
                "EXECUTE_CODE action to run code and earn rewards for each "
                "unique (program_id, discriminator) pair discovered."
            ),
            settings={
                "extra": {
                    "CHECK_SHOULD_RESPOND": False,  # Benchmark mode
                    "ACTION_PLANNING": True,
                },
            },
            templates={
                "messageHandlerTemplate": SOLANA_MESSAGE_TEMPLATE,
            },
        )

        model_plugin = _get_model_plugin(self.model_name)

        runtime = AgentRuntime(
            character=character,
            plugins=[model_plugin, solana_bench_plugin],
            disable_basic_capabilities=False,
            check_should_respond=False,
            action_planning=True,
            log_level="INFO",
        )

        await runtime.initialize()

        logger.info(
            "ElizaOS runtime initialised: %d actions, %d providers",
            len(runtime.actions),
            len(runtime.providers),
        )
        return runtime

    # -- Main loop -------------------------------------------------------

    async def run(self, env: SurfpoolEnv) -> dict[str, object]:
        """Run the two-phase exploration loop and return metrics."""
        if self._runtime is None:
            self._runtime = await self._initialize_runtime()

        # Inject settings for the plugin actions and providers
        self._runtime.set_setting("SURFPOOL_ENV", env)
        self._runtime.set_setting("EXPLORATION_STRATEGY", self.strategy)
        self._runtime.set_setting("CODE_FILE", self.code_file)
        self._runtime.set_setting("TIMEOUT_MS", self._timeout_ms)

        room_id = string_to_uuid(f"solana-bench-{self.run_id}")
        user_id = string_to_uuid("benchmark-harness")

        logger.info(
            "Solana Agent  model=%s  max=%d  id=%s",
            self.model_name,
            self.max_messages,
            self.run_id,
        )

        last_feedback = ""

        for step_idx in range(self.max_messages):
            t0 = datetime.now()
            agent_pubkey = str(env.agent_keypair.pubkey())
            action = self.strategy.get_next_action(agent_pubkey)

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
                reward, success, info, last_feedback = await self._execute_llm_step(
                    self._runtime,
                    action,
                    room_id,
                    user_id,
                    last_feedback,
                )

            self.strategy.record_result(
                action.get("template_name", "unknown"),
                reward,
                success,
                info or None,
            )

            elapsed = (datetime.now() - t0).total_seconds()
            self._record_metrics(
                step_idx, t0, elapsed, action, reward, success, info, env
            )
            self._save_checkpoint()

        self.metrics["end_time"] = datetime.now().isoformat()
        self.metrics["final_reward"] = env.total_reward
        programs_disc = self.metrics.get("programs_discovered")
        self.metrics["final_programs"] = (
            len(programs_disc) if isinstance(programs_disc, dict) else 0
        )
        self._save_checkpoint()
        logger.info("\n%s", self.strategy.get_summary())
        return self.metrics

    # -- Phase 1: deterministic templates --------------------------------

    async def _execute_deterministic(
        self,
        env: SurfpoolEnv,
        code: str,
        template_name: str,
    ) -> tuple[int, bool, dict[str, object]]:
        """Execute a deterministic template directly (Phase 1 — no LLM)."""
        reward, success, info = await execute_solana_skill(
            code=code,
            env=env,
            code_file=self.code_file,
            timeout_ms=self._timeout_ms,
        )
        if not success:
            logger.warning(
                "Template %s: failed — %s", template_name, str(info)[:400]
            )
        else:
            logger.info(
                "Template %s: reward=%d  total=%d",
                template_name,
                reward,
                env.total_reward,
            )
        return reward, success, info

    # -- Phase 2: LLM-assisted exploration via handle_message ------------

    async def _execute_llm_step(
        self,
        runtime: AgentRuntime,
        action: dict[str, str | int],
        room_id: str,
        user_id: str,
        last_feedback: str,
    ) -> tuple[int, bool, dict[str, object], str]:
        """Execute an LLM-assisted step through handle_message (Phase 2)."""
        prompt_context = str(action.get("prompt_context", ""))

        if last_feedback:
            message_text = (
                f"Previous result: {last_feedback}\n\n"
                f"Current state:\n{prompt_context}\n\n"
                f"Generate TypeScript code with executeSkill to discover "
                f"new program interactions."
            )
        else:
            message_text = (
                f"Explore Solana programs. Current state:\n\n{prompt_context}\n\n"
                f"Write TypeScript code with "
                f"`export async function executeSkill(blockhash: string): "
                f"Promise<string>` to discover new unique "
                f"(program_id, discriminator) pairs. Use the EXECUTE_CODE action."
            )

        message = Memory(
            id=as_uuid(str(uuid.uuid4())),
            entity_id=user_id,
            room_id=room_id,
            content=Content(text=message_text),
            created_at=int(datetime.now().timestamp() * 1000),
        )

        # Clear any previous execution result
        runtime.set_setting("LAST_EXECUTION_RESULT", None)

        callback_results: list[Content] = []

        async def action_callback(content: Content) -> list[Memory]:
            callback_results.append(content)
            return []

        await runtime.message_service.handle_message(
            runtime, message, action_callback
        )

        # -- Collect feedback text from action callbacks -----------------
        feedback_parts: list[str] = []
        for content in callback_results:
            if content.text:
                feedback_parts.append(content.text)
        feedback_text = "\n\n".join(feedback_parts).strip()

        # -- Extract structured result (set by EXECUTE_CODE handler) -----
        reward = 0
        success = False
        info: dict[str, object] = {}

        exec_result = runtime.get_setting("LAST_EXECUTION_RESULT")
        if exec_result and isinstance(exec_result, dict):
            raw_reward = exec_result.get("reward", 0)
            reward = int(raw_reward) if isinstance(raw_reward, (int, float)) else 0

            raw_success = exec_result.get("success", False)
            success = bool(raw_success)

            raw_info = exec_result.get("info", {})
            info = dict(raw_info) if isinstance(raw_info, dict) else {}

        elif not callback_results:
            # The LLM didn't generate an EXECUTE_CODE action
            feedback_text = (
                "No EXECUTE_CODE action was generated. "
                "Please write TypeScript code using EXECUTE_CODE."
            )
            info = {"error": "no_action_generated"}

        return reward, success, info, feedback_text

    # -- Metrics ---------------------------------------------------------

    def _record_metrics(
        self,
        step_idx: int,
        t0: datetime,
        elapsed: float,
        action: dict[str, str | int],
        reward: int,
        success: bool,
        info: dict[str, object],
        env: SurfpoolEnv,
    ) -> None:
        """Append step metrics to ``self.metrics``."""
        messages_list = self.metrics.get("messages")
        if isinstance(messages_list, list):
            messages_list.append(
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

        cumulative = self.metrics.get("cumulative_rewards")
        if isinstance(cumulative, list):
            cumulative.append(env.total_reward)

        if info and "unique_instructions" in info:
            progs_disc = self.metrics.get("programs_discovered")
            ix_by_prog = self.metrics.get("instructions_by_program")
            if isinstance(progs_disc, dict) and isinstance(ix_by_prog, dict):
                unique_ix = info["unique_instructions"]
                if isinstance(unique_ix, dict):
                    for prog_id, discs in unique_ix.items():
                        if isinstance(discs, list):
                            if prog_id not in progs_disc:
                                progs_disc[prog_id] = step_idx + 1
                            ix_by_prog.setdefault(prog_id, []).extend(discs)

        if action["type"] == "llm_assisted":
            transitions = self.metrics.get("phase_transitions")
            if isinstance(transitions, list) and not transitions:
                transitions.append(
                    {
                        "phase": "llm_assisted",
                        "step": step_idx + 1,
                        "total_reward": env.total_reward,
                    }
                )

        if not success:
            errors = self.metrics.get("errors")
            if isinstance(errors, list):
                error_str = (
                    str(info.get("error", "unknown"))[:500] if info else "unknown"
                )
                errors.append(
                    {
                        "step": step_idx + 1,
                        "template": action.get("template_name", ""),
                        "error": error_str,
                    }
                )

    def _save_checkpoint(self) -> None:
        """Persist current metrics to disk."""
        d = GYM_ENV_DIR / "metrics"
        d.mkdir(exist_ok=True)

        mc = dict(self.metrics)
        ix_by_prog = mc.get("instructions_by_program")
        if isinstance(ix_by_prog, dict):
            mc["instructions_by_program"] = {
                k: sorted(set(v)) if isinstance(v, list) else v
                for k, v in ix_by_prog.items()
            }

        with open(d / f"{self.run_id}_metrics.json", "w") as f:
            json.dump(mc, f, indent=2, default=str)

    async def cleanup(self) -> None:
        """Stop the ElizaOS runtime and release resources."""
        if self._runtime is not None:
            await self._runtime.stop()
            self._runtime = None


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


async def main() -> None:
    """Run the Solana benchmark with a real ElizaOS agent."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s  %(levelname)-7s  %(message)s",
        force=True,
        handlers=[logging.StreamHandler(sys.stdout)],
    )

    model_name = os.getenv("MODEL_NAME", "anthropic/claude-sonnet-4")
    max_messages = int(os.getenv("MAX_MESSAGES", "50"))
    run_index = int(os.getenv("RUN_INDEX", "0"))
    environment_config = os.getenv("ENVIRONMENT_CONFIG")
    use_external = os.getenv("USE_EXTERNAL_SURFPOOL", "false").lower() == "true"

    logger.info(
        "Model: %s  Messages: %d  Env: %s  External: %s",
        model_name,
        max_messages,
        environment_config or "basic",
        use_external,
    )

    from voyager.surfpool_env import SurfpoolEnv, _surfpool_validator

    agent = SolanaElizaAgent(
        model_name=model_name,
        max_messages=max_messages,
        run_index=run_index,
        environment_config=environment_config,
        code_file=os.getenv("CODE_FILE"),
    )

    allowed: list[str] = []
    if agent.env_config and "reward_config" in agent.env_config:
        rc = agent.env_config["reward_config"]
        if isinstance(rc, dict):
            ap = rc.get("allowed_programs", [])
            if isinstance(ap, list):
                allowed = [str(p) for p in ap]

    async def go(env: SurfpoolEnv) -> None:
        await env.reset()
        logger.info("Agent: %s", env.agent_keypair.pubkey())
        m = await agent.run(env)
        logger.info(
            "=== FINAL ===  reward=%d  programs=%d",
            m.get("final_reward", 0),
            m.get("final_programs", 0),
        )
        await env.close()
        await agent.cleanup()

    if use_external:
        await go(
            SurfpoolEnv(allowed_programs=allowed, use_external_surfpool=True)
        )
    else:
        async with _surfpool_validator("https://api.mainnet-beta.solana.com"):
            await go(
                SurfpoolEnv(allowed_programs=allowed, use_external_surfpool=True)
            )


if __name__ == "__main__":
    asyncio.run(main())
