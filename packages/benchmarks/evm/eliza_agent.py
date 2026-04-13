"""
Canonical ElizaOS Agent for the EVM Benchmark.

This agent uses the full ElizaOS runtime with message_service.handle_message(),
actions, providers, and evaluators — NO LangChain bypass.

Two-phase exploration:
  Phase 1 (Deterministic): pre-built TypeScript templates, no LLM needed.
  Phase 2 (LLM-Assisted):  routed through the Eliza agent pipeline with
                            EXECUTE_CODE action and EVM_CONTEXT provider.

Usage:
    # Start Anvil (or use auto-managed):
    anvil --port 8545 --chain-id 31337

    # Run benchmark:
    USE_EXTERNAL_NODE=true python -m benchmarks.evm.eliza_agent

    # For Groq model:
    MODEL_NAME=groq/qwen3-32b USE_EXTERNAL_NODE=true python -m benchmarks.evm.eliza_agent
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

from benchmarks.evm.anvil_env import AnvilEnv, anvil_node
from benchmarks.evm.eliza_explorer import run_typescript_skill
from benchmarks.evm.exploration_strategy import ExplorationStrategy
from benchmarks.evm.plugin import evm_bench_plugin

if TYPE_CHECKING:
    from benchmarks.evm.anvil_env import StepResult

load_dotenv()
_eliza_env = Path(__file__).parent.parent.parent / "eliza" / ".env"
if _eliza_env.exists():
    load_dotenv(_eliza_env, override=False)

logger = logging.getLogger(__name__)

BENCH_DIR = Path(__file__).parent
SKILL_RUNNER_DIR = BENCH_DIR / "skill_runner"
DEFAULT_CODE_FILE = str(SKILL_RUNNER_DIR / "evm_skill.ts")

# ---------------------------------------------------------------------------
# Provider → env-var mapping (reused from eliza_explorer for provider detect)
# ---------------------------------------------------------------------------

from benchmarks.evm.providers import PROVIDER_URLS as _PROVIDER_URLS
from benchmarks.evm.providers import PROVIDER_KEY_VARS as _PROVIDER_KEY_VARS
from benchmarks.evm.providers import detect_provider as _detect_provider


# ---------------------------------------------------------------------------
# Message-handler template for the EVM exploration agent
# ---------------------------------------------------------------------------

EVM_MESSAGE_HANDLER_TEMPLATE = """<task>Generate dialog and actions for the character {{agentName}}.</task>

<providers>
{{providers}}
</providers>

<instructions>
You are an EVM expert discovering unique (contract_address, function_selector) pairs.
Each new pair = +1 reward. Check EVM_CONTEXT for what's already discovered.

Use the EXECUTE_CODE action with TypeScript code. The code runs via Bun on Anvil.

REQUIRED CODE STRUCTURE:
```
import { createPublicClient, createWalletClient, http, type Hex, type Address, parseAbi, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
export async function executeSkill(rpcUrl: string, privateKey: string, chainId: number = 31337): Promise<string> {
  const account = privateKeyToAccount(privateKey as Hex);
  const pub = createPublicClient({ chain: {...anvil, id: chainId}, transport: http(rpcUrl) });
  const wallet = createWalletClient({ account, chain: {...anvil, id: chainId}, transport: http(rpcUrl) });
  const results: Array<{txHash:string;to:string;selector:string;success:boolean;deployedAddress?:string}> = [];
  // Send txs, then: results.push({txHash, to, selector: data.slice(0,10), success: receipt.status==='success'})
  return JSON.stringify({ results, error: null });
}
```
Keep code under 100 lines. Do NOT inline large bytecodes.
</instructions>

<output>
Respond in this EXACT XML format:
<response>
  <thought>Brief plan for which NEW selectors to target</thought>
  <actions>EXECUTE_CODE</actions>
  <providers>EVM_CONTEXT</providers>
  <text>What I will do</text>
  <params>
    <EXECUTE_CODE>
      <code>YOUR TYPESCRIPT CODE HERE</code>
    </EXECUTE_CODE>
  </params>
</response>
</output>"""


# ---------------------------------------------------------------------------
# Model-provider plugin helper
# ---------------------------------------------------------------------------


def _get_model_plugin(model_name: str) -> Plugin:
    """
    Get the model provider plugin for the given model name.

    For OpenAI: uses the elizaos_plugin_openai directly.
    For Groq/OpenRouter: creates a lightweight plugin that calls the
    OpenAI-compatible API with the correct base URL and API key, bypassing
    the OpenAI plugin's sk- key validation.
    """
    import aiohttp
    from elizaos.types import ModelType

    provider = _detect_provider(model_name)

    # Strip provider prefix
    clean_model = model_name
    for prefix in ("groq/", "openai/", "openrouter/"):
        if clean_model.lower().startswith(prefix):
            clean_model = clean_model[len(prefix):]
            break

    if provider == "openai":
        # Use the official OpenAI plugin for OpenAI models
        os.environ["OPENAI_SMALL_MODEL"] = clean_model
        os.environ["OPENAI_LARGE_MODEL"] = clean_model
        logger.info("Model plugin: provider=openai  model=%s", clean_model)
        try:
            from elizaos_plugin_openai import get_openai_plugin
            return get_openai_plugin()
        except ImportError:
            raise RuntimeError("elizaos_plugin_openai not found. pip install elizaos-plugin-openai")

    # For Groq/OpenRouter: create a custom model handler
    base_url = _PROVIDER_URLS.get(provider, "https://api.openai.com/v1")
    key_var = _PROVIDER_KEY_VARS.get(provider, "OPENAI_API_KEY")
    api_key = os.getenv(key_var, "")
    if not api_key:
        raise RuntimeError(f"{key_var} not set. Required for provider '{provider}'.")

    logger.info("Model plugin: provider=%s  base_url=%s  model=%s", provider, base_url, clean_model)

    async def _chat_completion(
        runtime: object,
        params: dict[str, object],
    ) -> str:
        """Call OpenAI-compatible chat completion API."""
        prompt = params.get("prompt", "")
        system = params.get("system", "")
        temperature = params.get("temperature", 0.7)
        max_tokens = params.get("maxTokens", 4096)

        messages: list[dict[str, str]] = []
        if system:
            messages.append({"role": "system", "content": str(system)})
        if prompt:
            messages.append({"role": "user", "content": str(prompt)})
        if not messages:
            return ""

        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                    "Accept-Encoding": "identity",
                },
                json={
                    "model": clean_model,
                    "messages": messages,
                    "max_tokens": int(max_tokens) if max_tokens else 4096,
                    "temperature": float(temperature) if temperature else 0.7,
                },
            ) as resp:
                data = await resp.json()
                if "error" in data:
                    raise RuntimeError(f"API error: {data['error']}")
                text = data.get("choices", [{}])[0].get("message", {}).get("content", "")

                # Convert Qwen3 <think> to Eliza <thought> for XML parser compat
                import re
                think_match = re.search(r"<think>([\s\S]*?)</think>", text)
                if think_match:
                    think_content = think_match.group(1).strip()[:800]
                    text = re.sub(r"<think>[\s\S]*?</think>", "", text).strip()
                    # Inject <thought> if the remaining response doesn't have one
                    if "<thought>" not in text:
                        if "<response>" in text:
                            text = text.replace(
                                "<response>",
                                f"<response>\n  <thought>{think_content}</thought>",
                                1,
                            )
                        else:
                            text = f"<thought>{think_content}</thought>\n{text}"
                return text

    models = {
        ModelType.TEXT_LARGE: _chat_completion,
        ModelType.TEXT_SMALL: _chat_completion,
    }

    return Plugin(
        name=f"{provider}-model",
        description=f"{provider} model provider ({clean_model})",
        models=models,
    )


# ---------------------------------------------------------------------------
# EVMExplorerAgent — canonical Eliza agent for the EVM benchmark
# ---------------------------------------------------------------------------


class EVMExplorerAgent:
    """
    Canonical ElizaOS agent for the EVM benchmark.

    Phase 1 (Deterministic):
        Runs pre-built TypeScript templates directly — no LLM needed.
        Identical to the standalone ElizaExplorer for this phase.

    Phase 2 (LLM-Assisted):
        Routes every step through the full Eliza runtime:
        - EVM_CONTEXT provider injects discovery state and catalog.
        - message_service.handle_message() invokes the LLM.
        - The LLM responds with EXECUTE_CODE action + TypeScript code.
        - The EXECUTE_CODE handler writes code, runs via Bun, rewards.
        - Results feed back as the next message.
    """

    def __init__(
        self,
        model_name: str = "qwen/qwen3-32b",
        max_messages: int = 50,
        run_index: int = 0,
        chain: str = "general",
        environment_config: str | None = None,
        code_file: str | None = None,
        verbose: bool = False,
    ) -> None:
        self._model_name = model_name
        self._max_messages = max_messages
        self._run_index = run_index
        self._chain = chain
        self._code_file = code_file or DEFAULT_CODE_FILE
        self._verbose = verbose
        self._run_id = f"evm_{datetime.now().strftime('%y-%m-%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"

        self._env_config: dict[str, str | int | float] | None = None
        if environment_config:
            p = Path(environment_config)
            if not p.is_absolute():
                p = BENCH_DIR / "environments" / environment_config
            with open(p) as f:
                self._env_config = dict(json.load(f))

        self._strategy = ExplorationStrategy(max_messages=max_messages, chain=chain)
        self._runtime: AgentRuntime | None = None

        # Metrics — same schema as ElizaExplorer for compatibility
        self._metrics: dict[str, object] = {
            "model": model_name,
            "run_index": run_index,
            "run_id": self._run_id,
            "chain": chain,
            "agent_type": "eliza",
            "start_time": datetime.now().isoformat(),
            "environment_config": environment_config,
            "messages": [],
            "cumulative_rewards": [],
            "contracts_discovered": {},
            "selectors_by_contract": {},
            "phase_transitions": [],
            "errors": [],
        }

    @property
    def _timeout_ms(self) -> int:
        if self._env_config and "timeout" in self._env_config:
            val = self._env_config["timeout"]
            return int(val) if isinstance(val, (int, float, str)) else 30000
        return 30000

    # ---- Runtime initialisation ----

    async def _initialize_runtime(self) -> AgentRuntime:
        """Initialize the full ElizaOS runtime with character, plugins, etc."""
        character = Character(
            name="EVMExplorer",
            username="evm_explorer",
            bio=(
                "An EVM exploration agent that discovers smart contract interactions "
                "on a local Anvil node. Expert in Solidity, viem, and EVM internals."
            ),
            system=(
                "You are an EVM expert. Generate TypeScript code using viem to interact "
                "with smart contracts on a local Anvil node. Your goal is to discover "
                "as many unique (contract_address, function_selector) pairs as possible. "
                "Each unique pair earns +1 reward.\n\n"
                "Use the EXECUTE_CODE action to write and run code. Check EVM_CONTEXT "
                "for deployed contracts, undiscovered selectors, and strategy hints.\n"
                "Keep code short. Do NOT inline large bytecodes."
            ),
            settings={
                "extra": {
                    "CHECK_SHOULD_RESPOND": False,  # Always respond (benchmark mode)
                    "ACTION_PLANNING": True,         # Enable multi-action execution
                },
            },
            templates={
                "messageHandlerTemplate": EVM_MESSAGE_HANDLER_TEMPLATE,
            },
        )

        model_plugin = _get_model_plugin(self._model_name)

        runtime = AgentRuntime(
            character=character,
            plugins=[
                model_plugin,
                evm_bench_plugin,
            ],
            disable_basic_capabilities=False,
            enable_extended_capabilities=False,
            check_should_respond=False,
            action_planning=True,
            log_level="DEBUG" if self._verbose else "INFO",
        )

        await runtime.initialize()

        logger.info(
            "ElizaOS runtime initialised — %d actions, %d providers",
            len(runtime.actions),
            len(runtime.providers),
        )

        return runtime

    # ---- Phase 1: deterministic templates (no LLM) ----

    async def _execute_deterministic(
        self,
        env: AnvilEnv,
        code: str,
        template_name: str,
    ) -> tuple[int, bool, dict[str, dict[str, list[str]] | dict[str, str]]]:
        """Execute a deterministic template — identical to ElizaExplorer."""
        result = run_typescript_skill(
            code, env.rpc_url, env.agent_private_key, env.chain_id,
            self._code_file, self._timeout_ms,
        )

        step_result = await env.step(json.dumps(result))

        if step_result.error:
            logger.warning("Template %s: error — %s", template_name, step_result.error[:400])
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

    # ---- Phase 2: LLM-assisted via Eliza pipeline ----

    async def _execute_llm_step(
        self,
        env: AnvilEnv,
        prompt_context: str,
        room_id: str,
        user_id: str,
        last_feedback: str,
        is_first_llm_step: bool,
    ) -> tuple[int, bool, dict[str, dict[str, list[str]] | dict[str, str]], str]:
        """
        Execute a single LLM-assisted exploration step through the Eliza runtime.

        Returns (reward, success, info, feedback_text).
        """
        if self._runtime is None:
            self._runtime = await self._initialize_runtime()

        # Update runtime settings so providers/actions see current state
        self._runtime.set_setting("ANVIL_ENV", env)
        self._runtime.set_setting("EXPLORATION_STRATEGY", self._strategy)
        self._runtime.set_setting("CODE_FILE", self._code_file)
        self._runtime.set_setting("TIMEOUT_MS", self._timeout_ms)
        self._runtime.set_setting("LAST_STEP_RESULT", None)

        # Build the message text
        if is_first_llm_step:
            message_text = (
                "Begin EVM exploration. Check the EVM_CONTEXT provider for deployed "
                "contracts and undiscovered selectors. Use EXECUTE_CODE to write "
                "TypeScript code that discovers new (address, selector) pairs.\n\n"
                f"Current context:\n{prompt_context}"
            )
        elif last_feedback:
            message_text = (
                f"Previous step result:\n{last_feedback}\n\n"
                "Continue exploring. Check EVM_CONTEXT for remaining targets."
            )
        else:
            message_text = "Continue exploring. Use EXECUTE_CODE to discover more selectors."

        # Create the Memory
        message = Memory(
            id=as_uuid(str(uuid.uuid4())),
            entity_id=string_to_uuid(user_id),
            room_id=string_to_uuid(room_id),
            content=Content(text=message_text),
            created_at=int(datetime.now().timestamp() * 1000),
        )

        # Capture action callback results
        callback_results: list[Content] = []

        async def action_callback(content: Content) -> list[Memory]:
            callback_results.append(content)
            return []

        # Route through the canonical Eliza pipeline
        handle_result = await self._runtime.message_service.handle_message(
            self._runtime,
            message,
            action_callback,
        )

        if self._verbose:
            logger.debug("handle_message: did_respond=%s", handle_result.did_respond)

        # Extract feedback text from callbacks
        feedback_parts: list[str] = [c.text for c in callback_results if c.text]
        feedback_text = "\n\n".join(feedback_parts).strip()

        # Read the step result stored by the EXECUTE_CODE action
        step_result = self._runtime.get_setting("LAST_STEP_RESULT")

        if step_result is not None:
            reward = step_result.reward
            info: dict[str, dict[str, list[str]] | dict[str, str]] = {
                "unique_selectors": step_result.unique_selectors,
                "deployed_contracts": step_result.deployed_contracts,
            }
            return reward, True, info, feedback_text

        # No EXECUTE_CODE was triggered — LLM didn't produce code
        if not feedback_text:
            feedback_text = "No EXECUTE_CODE action was triggered. Please write TypeScript code."

        return 0, False, {}, feedback_text

    # ---- Main exploration loop ----

    async def run(self, env: AnvilEnv) -> dict[str, object]:
        """
        Main exploration loop.

        Phase 1: deterministic templates (direct execution, no LLM).
        Phase 2: LLM-assisted via the Eliza runtime pipeline.
        """
        logger.info(
            "EVMExplorerAgent  model=%s  chain=%s  max=%d  id=%s  agent_type=eliza",
            self._model_name, self._chain, self._max_messages, self._run_id,
        )

        room_id = f"evm-bench-{self._run_id}"
        user_id = "benchmark-harness"
        is_first_llm_step = True
        last_feedback = ""

        for step_idx in range(self._max_messages):
            t0 = datetime.now()
            action = self._strategy.get_next_action()
            if action["type"] == "done":
                break

            logger.info(
                "\n%s\nStep %d/%d [%s]: %s\n%s",
                "=" * 60, step_idx + 1, self._max_messages,
                action["type"], action["description"], "=" * 60,
            )

            reward, success, info = 0, False, {}
            feedback = ""

            if action["type"] == "deterministic":
                # Phase 1: direct template execution
                reward, success, info = await self._execute_deterministic(
                    env, action["code"], action["template_name"],
                )

            elif action["type"] == "llm_assisted":
                # Phase 2: full Eliza agent pipeline
                reward, success, info, feedback = await self._execute_llm_step(
                    env,
                    action.get("prompt_context", ""),
                    room_id,
                    user_id,
                    last_feedback,
                    is_first_llm_step,
                )
                is_first_llm_step = False
                last_feedback = feedback

            # Record in strategy
            self._strategy.record_result(
                action.get("template_name", "llm_exploration"), reward, success, info,
            )

            # ---- Metrics tracking (same as ElizaExplorer for compat) ----
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

        # Finalise metrics
        self._metrics["end_time"] = datetime.now().isoformat()
        self._metrics["final_reward"] = env.total_reward
        self._metrics["final_contracts"] = len(
            self._metrics.get("contracts_discovered", {})
            if isinstance(self._metrics.get("contracts_discovered"), dict)
            else {}
        )
        self._save_checkpoint()
        logger.info("\n%s", self._strategy.get_summary())
        return self._metrics

    # ---- Checkpoint persistence ----

    def _save_checkpoint(self) -> None:
        """Save current metrics to file."""
        d = BENCH_DIR / "metrics"
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

    # ---- Cleanup ----

    async def cleanup(self) -> None:
        """Clean up runtime resources."""
        if self._runtime is not None:
            await self._runtime.stop()
            self._runtime = None


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


async def main() -> None:
    """CLI entry point — same env-var interface as eliza_explorer.py."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s  %(levelname)-7s  %(message)s",
        force=True,
        handlers=[logging.StreamHandler(sys.stdout)],
    )

    model_name = os.getenv("MODEL_NAME", "qwen/qwen3-32b")
    max_messages = int(os.getenv("MAX_MESSAGES", "50"))
    run_index = int(os.getenv("RUN_INDEX", "0"))
    chain = os.getenv("CHAIN", "general")
    environment_config = os.getenv("ENVIRONMENT_CONFIG")
    use_external = os.getenv("USE_EXTERNAL_NODE", "false").lower() == "true"
    rpc_url = os.getenv("RPC_URL", "http://127.0.0.1:8545")
    chain_id = int(os.getenv("CHAIN_ID", "31337"))
    fork_url = os.getenv("FORK_URL", "")
    private_key = os.getenv("AGENT_PRIVATE_KEY", "")
    verbose = os.getenv("VERBOSE", "false").lower() == "true"

    logger.info(
        "Model: %s  Messages: %d  Chain: %s  External: %s  Agent: eliza",
        model_name, max_messages, chain, use_external,
    )

    agent = EVMExplorerAgent(
        model_name=model_name,
        max_messages=max_messages,
        run_index=run_index,
        chain=chain,
        environment_config=environment_config,
        code_file=os.getenv("CODE_FILE"),
        verbose=verbose,
    )

    async def go(env: AnvilEnv) -> None:
        await env.reset()
        logger.info("Agent: %s", env.agent_address)
        try:
            m = await agent.run(env)
            logger.info(
                "=== FINAL ===  reward=%d  contracts=%d  agent_type=eliza",
                m.get("final_reward", 0),
                m.get("final_contracts", 0),
            )
        finally:
            await agent.cleanup()
            await env.close()

    if use_external:
        from benchmarks.evm.anvil_env import ANVIL_DEFAULT_PRIVATE_KEY, ANVIL_DEFAULT_ADDRESS

        actual_key = private_key or ANVIL_DEFAULT_PRIVATE_KEY
        if private_key:
            # Derive address from the provided private key
            from eth_account import Account
            actual_address = Account.from_key(actual_key).address
        else:
            actual_address = ANVIL_DEFAULT_ADDRESS

        env = AnvilEnv(
            rpc_url=rpc_url,
            chain_id=chain_id,
            chain=chain,
            use_external_node=True,
            agent_private_key=actual_key,
            agent_address=actual_address,
        )
        await go(env)
    else:
        async with anvil_node(fork_url=fork_url, chain_id=chain_id):
            env = AnvilEnv(
                rpc_url=rpc_url,
                chain_id=chain_id,
                chain=chain,
                use_external_node=False,
            )
            await go(env)


if __name__ == "__main__":
    asyncio.run(main())
