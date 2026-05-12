"""
Two-phase exploration strategy for the EVM benchmark.
Phase 1: deterministic templates. Phase 2: LLM with catalog context.

Directly analogous to the Solana benchmark's exploration_strategy.py.
"""

import logging
from dataclasses import dataclass, field

from benchmarks.evm.contract_catalog import (
    get_contracts_for_chain,
    get_total_unique_pairs,
    ContractInfo,
)
from benchmarks.evm.skill_templates import DETERMINISTIC_TEMPLATES, get_template_for_step

logger = logging.getLogger(__name__)


@dataclass
class DiscoveryState:
    """Tracks discovered (contract_address, function_selector) pairs."""
    discovered: set[tuple[str, str]] = field(default_factory=set)
    current_step: int = 0
    total_reward: int = 0
    history: list[tuple[int, str, int, bool]] = field(default_factory=list)
    failed_templates: set[str] = field(default_factory=set)
    phase: str = "deterministic"
    chain: str = "general"

    # Track deployed contract addresses → contract type mapping
    deployed_contracts: dict[str, str] = field(default_factory=dict)

    @property
    def remaining_unique(self) -> int:
        return max(0, get_total_unique_pairs(self.chain) - len(self.discovered))

    def record_discovery(self, contract_address: str, selectors: list[str]) -> int:
        """Records newly discovered (address, selector) pairs. Returns count of new pairs."""
        before = len(self.discovered)
        for sel in selectors:
            self.discovered.add((contract_address.lower(), sel.lower()))
        return len(self.discovered) - before

    def record_step(self, step_name: str, reward: int, success: bool) -> None:
        self.history.append((self.current_step, step_name, reward, success))
        self.total_reward += reward
        self.current_step += 1
        if not success:
            self.failed_templates.add(step_name)

    def register_contract(self, address: str, contract_type: str) -> None:
        """Register a deployed contract address with its type."""
        self.deployed_contracts[address.lower()] = contract_type

    def get_undiscovered_by_contract(self) -> dict[str, list[str]]:
        """Return undiscovered selectors per contract, for LLM context."""
        result: dict[str, list[str]] = {}
        contracts = get_contracts_for_chain(self.chain)
        for contract in contracts:
            # For deployed contracts, check if we have a known address
            if contract.address.startswith("DEPLOY:"):
                # Find deployed addresses matching this contract type.
                # Labels come from templates as e.g. "ERC20", "NFT", "WETH"
                # so do case-insensitive substring matching against catalog name.
                contract_name_lower = contract.name.lower()
                addrs = [
                    addr for addr, ctype in self.deployed_contracts.items()
                    if ctype.lower() in contract_name_lower
                    or contract_name_lower in ctype.lower()
                ]
                if not addrs:
                    # Not yet deployed — all selectors are missing
                    result[f"{contract.name} (not deployed)"] = [
                        f"{fn.selector} ({fn.name})" for fn in contract.functions
                    ]
                    continue
                for addr in addrs:
                    missing = [
                        f"{fn.selector} ({fn.name})"
                        for fn in contract.functions
                        if (addr, fn.selector.lower()) not in self.discovered
                    ]
                    if missing:
                        result[f"{contract.name} ({addr[:10]}...)"] = missing
            else:
                # Fixed-address contract (precompiles, system contracts)
                missing = [
                    f"{fn.selector} ({fn.name})"
                    for fn in contract.functions
                    if (contract.address.lower(), fn.selector.lower()) not in self.discovered
                ]
                if missing:
                    result[f"{contract.name} ({contract.address[:10]}...)"] = missing
        return result


class ExplorationStrategy:
    """Two-phase exploration: deterministic templates then LLM-assisted."""

    def __init__(self, max_messages: int = 50, chain: str = "general"):
        self.max_messages = max_messages
        self.chain = chain
        self.state = DiscoveryState(chain=chain)
        self._det_idx = 0

    def get_next_action(self) -> dict[str, str]:
        """Get the next action to take."""
        if self.state.current_step >= self.max_messages:
            return {"type": "done", "description": "All messages used"}

        # Phase 1: deterministic templates
        while self._det_idx < len(DETERMINISTIC_TEMPLATES):
            name, code = get_template_for_step(self._det_idx)
            desc = DETERMINISTIC_TEMPLATES[self._det_idx][2]
            expected = DETERMINISTIC_TEMPLATES[self._det_idx][1]
            self._det_idx += 1
            if code and name not in self.state.failed_templates:
                return {
                    "type": "deterministic",
                    "template_name": name,
                    "code": code,
                    "expected_reward": str(expected),
                    "description": desc,
                }

        # Phase 2: LLM-assisted
        self.state.phase = "llm_assisted"
        return {
            "type": "llm_assisted",
            "template_name": "llm_exploration",
            "prompt_context": self._build_llm_context(),
            "description": f"LLM exploration: {self.state.remaining_unique} remaining",
        }

    def record_result(
        self,
        template_name: str,
        reward: int,
        success: bool,
        info: dict[str, list[str] | dict[str, str]] | None = None,
    ) -> None:
        """Record the result of a step."""
        if info and "unique_selectors" in info:
            selector_data = info["unique_selectors"]
            if isinstance(selector_data, dict):
                for addr, sels in selector_data.items():
                    if isinstance(sels, list):
                        self.state.record_discovery(addr, sels)

        if info and "deployed_contracts" in info:
            deployed = info["deployed_contracts"]
            if isinstance(deployed, dict):
                for addr, ctype in deployed.items():
                    if isinstance(ctype, str):
                        self.state.register_contract(addr, ctype)

        self.state.record_step(template_name, reward, success)

        if success and reward > 0:
            logger.info(
                "Step %d: %s  reward=%d  total=%d  discovered=%d",
                self.state.current_step, template_name, reward,
                self.state.total_reward, len(self.state.discovered),
            )
        elif not success:
            logger.warning("Step %d: %s FAILED", self.state.current_step, template_name)

    def _build_llm_context(self) -> str:
        """Build concise context for LLM. Keep it short to avoid token bloat."""
        undiscovered = self.state.get_undiscovered_by_contract()
        lines = [
            f"Reward: {self.state.total_reward} | Messages left: {self.max_messages - self.state.current_step}",
        ]

        deployed = self.state.deployed_contracts
        if deployed:
            lines.append("\nDeployed contracts you can call:")
            for addr, ctype in deployed.items():
                lines.append(f"  {addr} ({ctype})")

        # Only show undiscovered selectors (compact format)
        lines.append("\nUndiscovered function selectors to target:")
        for contract_key, missing_fns in undiscovered.items():
            # Show max 10 per contract to keep context short
            fns_display = missing_fns[:10]
            if len(missing_fns) > 10:
                fns_display.append(f"... and {len(missing_fns) - 10} more")
            lines.append(f"  {contract_key}: {', '.join(fns_display)}")

        lines.append("\nDO NOT inline large bytecodes. Keep code under 200 lines.")
        lines.append("Try: deploy a tiny contract, call precompiles with new data, use create2.")

        return "\n".join(lines)

    def get_summary(self) -> str:
        """Human-readable summary of exploration progress."""
        lines = [
            f"Messages: {self.state.current_step}/{self.max_messages}  "
            f"Reward: {self.state.total_reward}  "
            f"Discovered: {len(self.state.discovered)}  Phase: {self.state.phase}",
            "",
        ]
        for step_num, name, reward, success in self.state.history:
            lines.append(f"  {step_num:3d}. [{'OK' if success else 'FAIL'}] {name}: +{reward}")
        return "\n".join(lines)
