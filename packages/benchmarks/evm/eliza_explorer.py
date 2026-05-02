"""
Eliza-powered EVM benchmark explorer.

Two-phase exploration:
  Phase 1 (Deterministic): pre-built TypeScript templates using viem, no LLM needed.
  Phase 2 (LLM-Assisted): catalog-guided LLM exploration of remaining selectors.

Usage:
    # Start Anvil (or use auto-managed):
    anvil --port 8545 --chain-id 31337

    # Run benchmark:
    USE_EXTERNAL_NODE=true python -m benchmarks.evm.eliza_explorer

    # For Hyperliquid EVM:
    CHAIN=hyperliquid RPC_URL=https://api.hyperliquid-testnet.xyz/evm \
      python -m benchmarks.evm.eliza_explorer
"""

import asyncio
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

from benchmarks.evm.anvil_env import AnvilEnv, anvil_node
from benchmarks.evm.exploration_strategy import ExplorationStrategy

load_dotenv()
# Also load keys from eliza/.env if it exists
_eliza_env = Path(__file__).parent.parent.parent / "eliza" / ".env"
if _eliza_env.exists():
    load_dotenv(_eliza_env, override=False)

logger = logging.getLogger(__name__)

BENCH_DIR = Path(__file__).parent
SKILL_RUNNER_DIR = BENCH_DIR / "skill_runner"
DEFAULT_CODE_FILE = str(SKILL_RUNNER_DIR / "evm_skill.ts")


def run_typescript_skill(
    code: str,
    rpc_url: str,
    private_key: str,
    chain_id: int,
    code_file: str,
    timeout_ms: int = 30000,
) -> dict[str, object]:
    """Write code to file, run via Bun's runSkill.ts, return parsed JSON result."""
    with open(code_file, "w") as f:
        f.write(code)

    runner = str(SKILL_RUNNER_DIR / "runSkill.ts")
    completed = subprocess.run(
        ["bun", runner, code_file, str(timeout_ms), rpc_url, private_key, str(chain_id)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=str(SKILL_RUNNER_DIR),
    )

    stdout_lines = (completed.stdout or "").strip().split("\n")
    last_line = stdout_lines[-1] if stdout_lines else ""

    if completed.returncode == 0 and last_line:
        try:
            return dict(json.loads(last_line))
        except json.JSONDecodeError:
            return {"results": [], "error": f"Invalid JSON output: {last_line[:500]}"}

    if last_line:
        try:
            parsed = dict(json.loads(last_line))
            if completed.stderr:
                parsed["stderr"] = completed.stderr[:2000]
            return parsed
        except json.JSONDecodeError:
            # Last line wasn't valid JSON — fall through to generic error
            logger.debug("Non-JSON last line from Bun (exit %d): %s", completed.returncode, last_line[:200])

    return {
        "results": [],
        "error": f"Bun exit {completed.returncode}: {last_line[:300]}",
        "stderr": (completed.stderr or "")[:2000],
    }


from benchmarks.evm.providers import PROVIDER_URLS as _PROVIDER_URLS
from benchmarks.evm.providers import PROVIDER_KEY_VARS as _PROVIDER_KEY_VARS
from benchmarks.evm.providers import detect_provider as _detect_provider


class LLM:
    """LLM wrapper supporting Groq, OpenAI, and OpenRouter (all OpenAI-compatible)."""

    def __init__(self, model_name: str, api_key: str, provider: str = ""):
        from langchain_openai import ChatOpenAI
        from langchain_core.messages import SystemMessage, HumanMessage, AIMessage

        self.provider = provider or _detect_provider(model_name)
        base_url = _PROVIDER_URLS.get(self.provider, "https://api.openai.com/v1")

        # Strip provider prefix from model name if present (e.g. "groq/qwen..." → "qwen...")
        clean_model = model_name
        for prefix in ("groq/", "openai/", "openrouter/"):
            if clean_model.lower().startswith(prefix):
                clean_model = clean_model[len(prefix):]
                break

        logger.info("LLM: provider=%s  model=%s  base_url=%s", self.provider, clean_model, base_url)

        self.llm = ChatOpenAI(
            base_url=base_url,
            model=clean_model,
            api_key=api_key,
            temperature=0.7,
        )
        self._msg_classes = {
            "system": SystemMessage,
            "user": HumanMessage,
            "assistant": AIMessage,
        }

    async def generate(self, messages: list[dict[str, str]]) -> str:
        lc_messages = [
            self._msg_classes[m["role"]](content=m["content"])
            for m in messages
            if m["role"] in self._msg_classes
        ]
        result = await self.llm.ainvoke(lc_messages)
        return str(result.content)


class ElizaExplorer:
    """
    EVM benchmark explorer.

    Phase 1 (Deterministic): pre-built templates, no LLM needed.
    Phase 2 (LLM-Assisted): catalog-guided LLM exploration.
    """

    def __init__(
        self,
        model_name: str = "qwen/qwen3-32b",
        max_messages: int = 50,
        run_index: int = 0,
        chain: str = "general",
        environment_config: str | None = None,
        code_file: str | None = None,
    ):
        self.model_name = model_name
        self.max_messages = max_messages
        self.run_index = run_index
        self.chain = chain
        self.code_file = code_file or DEFAULT_CODE_FILE
        self.run_id = f"evm_{datetime.now().strftime('%y-%m-%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"

        self.env_config: dict[str, object] | None = None
        if environment_config:
            p = Path(environment_config)
            if not p.is_absolute():
                p = BENCH_DIR / "environments" / environment_config
            with open(p) as f:
                self.env_config = dict(json.load(f))

        self.strategy = ExplorationStrategy(max_messages=max_messages, chain=chain)
        self._llm: LLM | None = None
        self._llm_messages: list[dict[str, str]] = []
        self.code_pattern = re.compile(r"```(?:javascript|js|typescript|ts)(.*?)```", re.DOTALL)
        self.metrics: dict[str, object] = {
            "model": model_name,
            "run_index": run_index,
            "run_id": self.run_id,
            "chain": chain,
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
        if self.env_config and "timeout" in self.env_config:
            val = self.env_config["timeout"]
            return int(val) if isinstance(val, (int, float, str)) else 30000
        return 30000

    def _ensure_llm(self) -> LLM:
        if self._llm is None:
            provider = _detect_provider(self.model_name)
            key_var = _PROVIDER_KEY_VARS.get(provider, "OPENAI_API_KEY")
            api_key = os.getenv(key_var, "")
            if not api_key:
                # Try all known key vars as fallback
                for var in _PROVIDER_KEY_VARS.values():
                    api_key = os.getenv(var, "")
                    if api_key:
                        break
            if not api_key:
                raise RuntimeError(
                    f"No API key found for provider '{provider}'. "
                    f"Set {key_var} in .env or environment."
                )
            self._llm = LLM(self.model_name, api_key, provider)
        return self._llm

    async def _execute_deterministic(
        self,
        env: AnvilEnv,
        code: str,
        template_name: str,
    ) -> tuple[int, bool, dict[str, object]]:
        """Execute a deterministic template."""
        result = run_typescript_skill(
            code, env.rpc_url, env.agent_private_key, env.chain_id,
            self.code_file, self._timeout_ms,
        )

        # Process result through env
        step_result = await env.step(json.dumps(result))

        if step_result.error:
            logger.warning("Template %s: error — %s", template_name, step_result.error[:400])
            return 0, False, {"error": step_result.error}

        logger.info(
            "Template %s: reward=%d  total=%d  txs=%d",
            template_name, step_result.reward, env.total_reward, len(step_result.tx_results),
        )

        # Label deployed contracts with meaningful names so LLM context is useful
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
        env: AnvilEnv,
        prompt_context: str,
    ) -> tuple[int, bool, dict[str, object]]:
        """Execute an LLM-assisted exploration step."""
        llm = self._ensure_llm()

        if not self._llm_messages:
            obs = await env.get_observation()
            self._llm_messages = [
                {"role": "system", "content": self._build_system_prompt(env, obs)},
            ]

        self._llm_messages.append({
            "role": "user",
            "content": f"Current state:\n\n{prompt_context}\n\nWrite ```typescript with executeSkill signature.",
        })

        response_text = await llm.generate(self._llm_messages)
        self._llm_messages.append({"role": "assistant", "content": response_text})

        code_blocks = self.code_pattern.findall(response_text)
        if not code_blocks:
            self._llm_messages.append({"role": "user", "content": "No code blocks found."})
            return 0, False, {"error": "no_code_blocks"}

        skill_code = next(
            (b.strip() for b in code_blocks if "export async function executeSkill" in b),
            code_blocks[0].strip(),
        )

        result = run_typescript_skill(
            skill_code, env.rpc_url, env.agent_private_key, env.chain_id,
            self.code_file, self._timeout_ms,
        )

        step_result = await env.step(json.dumps(result))

        feedback = (
            f"Reward: {step_result.reward}. Total: {env.total_reward}."
            if step_result.reward > 0
            else f"reward=0. Error: {step_result.error}" if step_result.error
            else f"reward=0. No new selectors discovered."
        )
        self._llm_messages.append({"role": "user", "content": feedback})

        return step_result.reward, True, {
            "unique_selectors": step_result.unique_selectors,
            "deployed_contracts": step_result.deployed_contracts,
        }

    def _build_system_prompt(
        self,
        env: AnvilEnv,
        obs: dict[str, str | int | float],
    ) -> str:
        """Build the system prompt for LLM-assisted exploration."""
        return f"""Expert EVM developer. Discover unique contract function selectors on an EVM chain.

Write TypeScript using viem. Function signature:
  export async function executeSkill(rpcUrl: string, privateKey: string, chainId: number = 31337): Promise<string>

You MUST return JSON: {{ "results": [...], "error": null }}

Each result: {{ txHash, to, selector, success, deployedAddress? }}

CRITICAL RULES:
- Keep code SHORT. Do NOT inline large bytecodes. Use small contracts or interact with existing ones.
- Use sendTransaction for calls. Track results manually.
- Import from 'viem' and 'viem/accounts' only.

STATE: {obs.get('eth_balance', 0)} ETH | Agent: {env.agent_address}
RPC: {env.rpc_url} | Chain ID: {env.chain_id}

REWARD: +1 per unique (contract_address, function_selector_4bytes) pair.
Already discovered: {obs.get('total_reward', 0)} pairs.

STRATEGY to earn more rewards:
- Call DIFFERENT functions on the deployed contracts listed below
- Deploy new contract types (ERC1155, Multicall, proxy patterns)
- Call precompiles 0x01-0x09 with different input data (different first 4 bytes = different reward)
- Use low-level calls: selfdestruct, create2, delegatecall
- Each NEW (to_address, first_4_bytes_of_calldata) pair = +1 reward

HELPER PATTERN (use this structure):
```typescript
const results: Array<{{txHash:string;to:string;selector:string;success:boolean;deployedAddress?:string}}> = [];
// ... send txs, push to results ...
return JSON.stringify({{ results, error: null }});
```
"""

    async def run(self, env: AnvilEnv) -> dict[str, object]:
        """Main exploration loop."""
        logger.info(
            "EVM Explorer  model=%s  chain=%s  max=%d  id=%s",
            self.model_name, self.chain, self.max_messages, self.run_id,
        )

        for step_idx in range(self.max_messages):
            t0 = datetime.now()
            action = self.strategy.get_next_action()
            if action["type"] == "done":
                break

            logger.info(
                "\n%s\nStep %d/%d [%s]: %s\n%s",
                "=" * 60, step_idx + 1, self.max_messages,
                action["type"], action["description"], "=" * 60,
            )

            reward, success, info = 0, False, {}
            if action["type"] == "deterministic":
                reward, success, info = await self._execute_deterministic(
                    env, action["code"], action["template_name"],
                )
            elif action["type"] == "llm_assisted":
                reward, success, info = await self._execute_llm_step(
                    env, action.get("prompt_context", ""),
                )

            self.strategy.record_result(
                action.get("template_name", "unknown"), reward, success, info,
            )

            elapsed = (datetime.now() - t0).total_seconds()
            messages_list = self.metrics.get("messages")
            if isinstance(messages_list, list):
                messages_list.append({
                    "index": step_idx + 1,
                    "timestamp": t0.isoformat(),
                    "duration": elapsed,
                    "type": action["type"],
                    "template": action.get("template_name", "llm"),
                    "reward": reward,
                    "total_reward": env.total_reward,
                    "success": success,
                })

            cumulative = self.metrics.get("cumulative_rewards")
            if isinstance(cumulative, list):
                cumulative.append(env.total_reward)

            if info and "unique_selectors" in info:
                selectors_data = info["unique_selectors"]
                if isinstance(selectors_data, dict):
                    contracts_disc = self.metrics.get("contracts_discovered")
                    selectors_by = self.metrics.get("selectors_by_contract")
                    if isinstance(contracts_disc, dict) and isinstance(selectors_by, dict):
                        for addr, sels in selectors_data.items():
                            if isinstance(sels, list):
                                if addr not in contracts_disc:
                                    contracts_disc[addr] = step_idx + 1
                                selectors_by.setdefault(addr, []).extend(sels)

            if action["type"] == "llm_assisted":
                transitions = self.metrics.get("phase_transitions")
                if isinstance(transitions, list) and not transitions:
                    transitions.append({
                        "phase": "llm_assisted",
                        "step": step_idx + 1,
                        "total_reward": env.total_reward,
                    })

            if not success:
                errors = self.metrics.get("errors")
                if isinstance(errors, list):
                    errors.append({
                        "step": step_idx + 1,
                        "template": action.get("template_name", ""),
                        "error": str(info.get("error", "unknown"))[:500],
                    })

            self._save_checkpoint()

        self.metrics["end_time"] = datetime.now().isoformat()
        self.metrics["final_reward"] = env.total_reward
        self.metrics["final_contracts"] = len(
            self.metrics.get("contracts_discovered", {})
            if isinstance(self.metrics.get("contracts_discovered"), dict)
            else {}
        )
        self._save_checkpoint()
        logger.info("\n%s", self.strategy.get_summary())
        return self.metrics

    def _save_checkpoint(self) -> None:
        """Save current metrics to file."""
        d = BENCH_DIR / "metrics"
        d.mkdir(exist_ok=True)
        mc = dict(self.metrics)

        # Deduplicate selectors
        selectors_by = mc.get("selectors_by_contract")
        if isinstance(selectors_by, dict):
            mc["selectors_by_contract"] = {
                k: sorted(set(v)) if isinstance(v, list) else v
                for k, v in selectors_by.items()
            }

        with open(d / f"{self.run_id}_metrics.json", "w") as f:
            json.dump(mc, f, indent=2, default=str)

        if self._llm_messages:
            with open(d / f"{self.run_id}_conversation.json", "w") as f:
                json.dump(self._llm_messages, f, indent=2)


async def main() -> None:
    """CLI entry point."""
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

    logger.info(
        "Model: %s  Messages: %d  Chain: %s  External: %s",
        model_name, max_messages, chain, use_external,
    )

    explorer = ElizaExplorer(
        model_name=model_name,
        max_messages=max_messages,
        run_index=run_index,
        chain=chain,
        environment_config=environment_config,
        code_file=os.getenv("CODE_FILE"),
    )

    async def go(env: AnvilEnv) -> None:
        await env.reset()
        logger.info("Agent: %s", env.agent_address)
        m = await explorer.run(env)
        logger.info("=== FINAL ===  reward=%d  contracts=%d", m.get("final_reward", 0), m.get("final_contracts", 0))
        await env.close()

    if use_external:
        from benchmarks.evm.anvil_env import ANVIL_DEFAULT_PRIVATE_KEY, ANVIL_DEFAULT_ADDRESS
        actual_key = private_key or ANVIL_DEFAULT_PRIVATE_KEY
        if private_key:
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
