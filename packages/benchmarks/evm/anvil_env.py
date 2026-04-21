"""
EVM Gymnasium environment using Anvil (Foundry) or any EVM-compatible RPC.

Analogous to solana-gym-env's surfpool_env.py but for EVM chains.
Manages Anvil lifecycle, transaction execution, and reward calculation.

Reward key: unique (contract_address, function_selector) pairs.
"""

import asyncio
import json
import logging
import os
import shutil
import subprocess
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import AsyncGenerator

logger = logging.getLogger(__name__)

# Anvil default account #0
ANVIL_DEFAULT_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
ANVIL_DEFAULT_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"


@dataclass
class TxResult:
    """Result of a single transaction execution."""
    tx_hash: str
    to_address: str
    function_selector: str
    success: bool
    deployed_address: str = ""
    gas_used: int = 0


@dataclass
class StepResult:
    """Result of executing a single skill step."""
    reward: int
    tx_results: list[TxResult]
    unique_selectors: dict[str, list[str]]  # address → [selectors]
    deployed_contracts: dict[str, str]  # address → contract_type
    error: str = ""


class AnvilEnv:
    """
    EVM Gymnasium-style environment using Anvil.

    Manages:
    - Anvil process lifecycle (or connects to external node)
    - Agent account with ETH
    - Transaction execution and tracing
    - Reward calculation: unique (address, selector) pairs
    """

    def __init__(
        self,
        rpc_url: str = "http://127.0.0.1:8545",
        chain_id: int = 31337,
        chain: str = "general",
        use_external_node: bool = False,
        fork_url: str = "",
        agent_private_key: str = ANVIL_DEFAULT_PRIVATE_KEY,
        agent_address: str = ANVIL_DEFAULT_ADDRESS,
    ):
        self.rpc_url = rpc_url
        self.chain_id = chain_id
        self.chain = chain
        self.use_external_node = use_external_node
        self.fork_url = fork_url
        self.agent_private_key = agent_private_key
        self.agent_address = agent_address

        # Reward tracking
        self._discovered: set[tuple[str, str]] = set()
        self._deployed_contracts: dict[str, str] = {}
        self._total_reward = 0
        self._session: "aiohttp.ClientSession | None" = None

    @property
    def total_reward(self) -> int:
        return self._total_reward

    @property
    def discovered_count(self) -> int:
        return len(self._discovered)

    async def reset(self) -> dict[str, str | int | float]:
        """Reset the environment. Returns initial observation."""
        self._discovered = set()
        self._deployed_contracts = {}
        self._total_reward = 0

        if not self.use_external_node:
            # If using Anvil, we can reset state via RPC
            try:
                await self._rpc_call("anvil_reset", [])
            except RuntimeError as exc:
                # Some Anvil-compatible nodes omit anvil_reset; continue with a fresh process state.
                if "Not implemented" not in str(exc):
                    raise

        obs = await self.get_observation()
        logger.info(
            "AnvilEnv reset: agent=%s  chain=%s  balance=%s ETH",
            self.agent_address, self.chain, obs.get("eth_balance", "?"),
        )
        return obs

    async def step(self, skill_output: str) -> StepResult:
        """
        Process the output of a skill execution.

        skill_output is JSON from the TypeScript skill runner containing
        tx hashes and results.
        """
        try:
            data = json.loads(skill_output)
        except json.JSONDecodeError:
            return StepResult(
                reward=0, tx_results=[], unique_selectors={},
                deployed_contracts={}, error=f"Invalid JSON: {skill_output[:200]}",
            )

        if data.get("error"):
            return StepResult(
                reward=0, tx_results=[], unique_selectors={},
                deployed_contracts={}, error=str(data["error"]),
            )

        results_data = data.get("results", [])
        tx_results: list[TxResult] = []
        new_selectors: dict[str, list[str]] = {}
        new_deployments: dict[str, str] = {}
        step_reward = 0

        for r in results_data:
            if not isinstance(r, dict):
                continue

            tx_hash = r.get("txHash", "")
            to_addr = r.get("to", "").lower()
            selector = r.get("selector", "0x").lower()
            success = r.get("success", False)
            deployed_addr = r.get("deployedAddress", "")

            tx_result = TxResult(
                tx_hash=tx_hash,
                to_address=to_addr,
                function_selector=selector,
                success=success,
                deployed_address=deployed_addr or "",
            )
            tx_results.append(tx_result)

            if not success:
                continue

            # Track deployment
            if deployed_addr:
                new_deployments[deployed_addr.lower()] = "deployed_contract"
                self._deployed_contracts[deployed_addr.lower()] = "deployed_contract"

            # Calculate reward for this tx
            pair = (to_addr, selector)
            if pair not in self._discovered:
                self._discovered.add(pair)
                step_reward += 1
                new_selectors.setdefault(to_addr, []).append(selector)

            # If we have a tx hash and the node supports tracing, get internal calls
            if tx_hash and not self.use_external_node:
                try:
                    internal_pairs = await self._trace_internal_calls(tx_hash)
                    for int_addr, int_sel in internal_pairs:
                        int_pair = (int_addr.lower(), int_sel.lower())
                        if int_pair not in self._discovered:
                            self._discovered.add(int_pair)
                            step_reward += 1
                            new_selectors.setdefault(int_addr.lower(), []).append(int_sel.lower())
                except Exception as e:
                    logger.debug("Tracing failed for %s: %s", tx_hash, e)

        self._total_reward += step_reward

        return StepResult(
            reward=step_reward,
            tx_results=tx_results,
            unique_selectors=new_selectors,
            deployed_contracts=new_deployments,
            error="",
        )

    async def _trace_internal_calls(self, tx_hash: str) -> list[tuple[str, str]]:
        """
        Use debug_traceTransaction to find internal calls.
        Returns list of (to_address, function_selector) pairs.
        """
        try:
            result = await self._rpc_call(
                "debug_traceTransaction",
                [tx_hash, {"tracer": "callTracer", "tracerConfig": {"onlyTopCall": False}}],
            )
        except Exception:
            return []

        pairs: list[tuple[str, str]] = []
        self._extract_calls_from_trace(result, pairs)
        return pairs

    def _extract_calls_from_trace(
        self,
        trace: dict[str, object],
        pairs: list[tuple[str, str]],
    ) -> None:
        """Recursively extract (address, selector) from call trace."""
        if not isinstance(trace, dict):
            return

        to_addr = trace.get("to", "")
        input_data = trace.get("input", "")

        if isinstance(to_addr, str) and isinstance(input_data, str) and to_addr:
            selector = input_data[:10] if len(input_data) >= 10 else "0x"
            pairs.append((to_addr.lower(), selector.lower()))

        # Process child calls
        calls = trace.get("calls", [])
        if isinstance(calls, list):
            for child in calls:
                if isinstance(child, dict):
                    self._extract_calls_from_trace(child, pairs)

    async def get_observation(self) -> dict[str, str | int | float]:
        """Get current environment observation."""
        try:
            balance_hex = await self._rpc_call("eth_getBalance", [self.agent_address, "latest"])
            balance_wei = int(str(balance_hex), 16) if balance_hex else 0
            balance_eth = balance_wei / 1e18
        except Exception as e:
            logger.warning("Failed to get ETH balance: %s", e)
            balance_eth = 0.0

        try:
            block_hex = await self._rpc_call("eth_blockNumber", [])
            block_number = int(str(block_hex), 16) if block_hex else 0
        except Exception as e:
            logger.warning("Failed to get block number: %s", e)
            block_number = 0

        return {
            "eth_balance": f"{balance_eth:.4f}",
            "block_number": block_number,
            "total_reward": self._total_reward,
            "discovered_count": len(self._discovered),
            "deployed_contracts": len(self._deployed_contracts),
        }

    async def _get_session(self) -> "aiohttp.ClientSession":
        """Get or create a reusable aiohttp session."""
        import aiohttp
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
        return self._session

    async def _rpc_call(self, method: str, params: list[object]) -> object:
        """Make a JSON-RPC call to the EVM node."""
        payload = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
            "id": 1,
        }

        session = await self._get_session()
        async with session.post(self.rpc_url, json=payload) as resp:
            data = await resp.json()
            if data.get("error") is not None:
                raise RuntimeError(f"RPC error: {data['error']}")
            return data.get("result")

    async def close(self) -> None:
        """Clean up resources: close HTTP session and log final state."""
        if self._session is not None and not self._session.closed:
            await self._session.close()
            self._session = None
        logger.info(
            "AnvilEnv closing: total_reward=%d  discovered=%d  deployed=%d",
            self._total_reward, len(self._discovered), len(self._deployed_contracts),
        )


@asynccontextmanager
async def anvil_node(
    fork_url: str = "",
    port: int = 8545,
    chain_id: int = 31337,
    block_time: int = 0,
) -> AsyncGenerator[None, None]:
    """Context manager to start/stop Anvil."""
    anvil_path = shutil.which("anvil")
    if anvil_path is None:
        raise RuntimeError(
            "Anvil not found. Install Foundry: curl -L https://foundry.paradigm.xyz | bash"
        )

    cmd = [
        anvil_path,
        "--port", str(port),
        "--chain-id", str(chain_id),
        "--accounts", "1",
        "--balance", "10000",
        "--silent",
    ]

    if fork_url:
        cmd.extend(["--fork-url", fork_url])

    if block_time > 0:
        cmd.extend(["--block-time", str(block_time)])

    logger.info("Starting Anvil: %s", " ".join(cmd))
    process = subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )

    # Wait for Anvil to be ready
    rpc_url = f"http://127.0.0.1:{port}"
    for attempt in range(30):
        try:
            import urllib.request
            req = urllib.request.Request(
                rpc_url,
                data=json.dumps({"jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 1}).encode(),
                headers={"Content-Type": "application/json"},
            )
            urllib.request.urlopen(req, timeout=2)
            logger.info("Anvil ready on port %d (attempt %d)", port, attempt + 1)
            break
        except Exception:
            if process.poll() is not None:
                stderr = process.stderr.read().decode() if process.stderr else ""
                raise RuntimeError(f"Anvil exited early: {stderr[:500]}")
            time.sleep(0.5)
    else:
        process.terminate()
        raise RuntimeError("Anvil failed to start within 15 seconds")

    try:
        yield
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
        logger.info("Anvil stopped")
