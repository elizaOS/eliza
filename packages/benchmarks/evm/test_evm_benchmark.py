"""
Tests for the EVM benchmark system.

Covers:
  - contract_catalog: data integrity, selector uniqueness, boundary values
  - skill_templates: template generation, TypeScript validity
  - exploration_strategy: state tracking, phase transitions, edge cases
  - eliza_explorer: construction, code pattern extraction
  - anvil_env: environment creation, reward calculation
"""

import json
import os
import subprocess
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Module imports
# ---------------------------------------------------------------------------
from benchmarks.evm.contract_catalog import (
    ALL_CONTRACTS,
    GENERAL_CONTRACTS,
    HYPERLIQUID_CONTRACTS,
    CONTRACT_BY_ADDRESS,
    ERC20_CONTRACT,
    ERC721_CONTRACT,
    WETH_CONTRACT,
    ERC1155_CONTRACT,
    MULTICALL3_CONTRACT,
    NATIVE_ETH,
    PRECOMPILE_IDENTITY,
    PRECOMPILE_SHA256,
    PRECOMPILE_ECRECOVER,
    HL_READ_POSITIONS,
    HL_READ_ORACLE,
    HL_CORE_WRITER,
    ContractInfo,
    FunctionInfo,
    Difficulty,
    get_contracts_for_chain,
    get_total_unique_pairs,
    get_functions_by_difficulty,
    summarize_catalog,
)
from benchmarks.evm.skill_templates import (
    DETERMINISTIC_TEMPLATES,
    _TEMPLATE_DISPATCH,
    get_template_for_step,
    get_total_expected_deterministic_reward,
    eth_transfer_template,
    deploy_erc20_template,
    precompile_batch1_template,
)
from benchmarks.evm.exploration_strategy import (
    DiscoveryState,
    ExplorationStrategy,
)

BENCH_DIR = Path(__file__).parent
SKILL_RUNNER_DIR = BENCH_DIR / "skill_runner"


# =========================================================================
# contract_catalog tests
# =========================================================================

class TestContractCatalog:

    def test_general_contracts_populated(self):
        assert len(GENERAL_CONTRACTS) >= 10  # precompiles + deployed contracts

    def test_hyperliquid_contracts_populated(self):
        assert len(HYPERLIQUID_CONTRACTS) >= 2

    def test_all_contracts_is_union(self):
        assert len(ALL_CONTRACTS) == len(GENERAL_CONTRACTS) + len(HYPERLIQUID_CONTRACTS)

    def test_no_duplicate_fixed_addresses(self):
        """Fixed-address contracts should have unique addresses."""
        fixed = [c.address for c in ALL_CONTRACTS if not c.address.startswith("DEPLOY:")]
        assert len(fixed) == len(set(fixed)), f"Duplicate addresses: {[x for x in fixed if fixed.count(x) > 1]}"

    def test_every_contract_has_functions(self):
        for contract in ALL_CONTRACTS:
            assert len(contract.functions) > 0, f"{contract.name} has no functions"

    def test_no_duplicate_selectors_within_contract(self):
        """Each contract should have unique function selectors."""
        for contract in ALL_CONTRACTS:
            selectors = [fn.selector for fn in contract.functions]
            unique = set(selectors)
            if len(selectors) != len(unique):
                dupes = [s for s in unique if selectors.count(s) > 1]
                pytest.fail(f"{contract.name}: duplicate selectors {dupes}")

    def test_selectors_are_valid_hex(self):
        """All selectors should be valid hex strings."""
        for contract in ALL_CONTRACTS:
            for fn in contract.functions:
                assert fn.selector.startswith("0x"), f"{contract.name}.{fn.name}: selector={fn.selector}"
                assert len(fn.selector) == 10 or fn.selector in ("0x", "0x00000000", "0xFFFFFFFF"), \
                    f"{contract.name}.{fn.name}: selector length={len(fn.selector)}"

    def test_evm_precompile_addresses_are_sequential(self):
        """Standard EVM precompiles should be at 0x01-0x09."""
        evm_precompiles = [
            c for c in ALL_CONTRACTS
            if c.is_precompile and c.address.startswith("0x000000000000000000000000000000000000000")
            and int(c.address, 16) <= 9
        ]
        assert len(evm_precompiles) == 9
        for i, pc in enumerate(evm_precompiles, start=1):
            expected = f"0x{i:040x}"
            assert pc.address == expected, f"Precompile {i}: expected {expected}, got {pc.address}"

    def test_erc20_has_standard_functions(self):
        selectors = ERC20_CONTRACT.unique_selectors
        # Standard ERC20 selectors
        assert "0xa9059cbb" in selectors  # transfer
        assert "0x095ea7b3" in selectors  # approve
        assert "0x23b872dd" in selectors  # transferFrom
        assert "0x70a08231" in selectors  # balanceOf
        assert "0x18160ddd" in selectors  # totalSupply

    def test_erc721_has_standard_functions(self):
        selectors = ERC721_CONTRACT.unique_selectors
        assert "0x23b872dd" in selectors  # transferFrom
        assert "0x42842e0e" in selectors  # safeTransferFrom
        assert "0x095ea7b3" in selectors  # approve

    def test_difficulty_ordering(self):
        assert Difficulty.TRIVIAL.value < Difficulty.EASY.value
        assert Difficulty.EASY.value < Difficulty.MEDIUM.value
        assert Difficulty.MEDIUM.value < Difficulty.HARD.value
        assert Difficulty.HARD.value < Difficulty.VERY_HARD.value

    def test_get_contracts_for_chain_general(self):
        contracts = get_contracts_for_chain("general")
        names = [c.name for c in contracts]
        assert "ERC20 Token" in names
        assert "Hyperliquid L1 Read" not in names

    def test_get_contracts_for_chain_hyperliquid(self):
        contracts = get_contracts_for_chain("hyperliquid")
        names = [c.name for c in contracts]
        assert "ERC20 Token" in names
        assert any("Hyperliquid" in n for n in names)

    def test_total_unique_pairs_positive(self):
        assert get_total_unique_pairs("general") > 0
        assert get_total_unique_pairs("hyperliquid") > get_total_unique_pairs("general")

    def test_get_functions_by_difficulty_trivial(self):
        trivials = get_functions_by_difficulty(Difficulty.TRIVIAL)
        for _, fn in trivials:
            assert fn.difficulty == Difficulty.TRIVIAL

    def test_get_functions_by_difficulty_monotonic(self):
        counts = [len(get_functions_by_difficulty(d)) for d in Difficulty]
        for i in range(len(counts) - 1):
            assert counts[i] <= counts[i + 1]

    def test_summarize_catalog_contains_all_contracts(self):
        summary = summarize_catalog()
        for contract in GENERAL_CONTRACTS:
            assert contract.name in summary

    def test_summarize_catalog_contains_total(self):
        summary = summarize_catalog()
        assert str(get_total_unique_pairs("general")) in summary

    def test_contract_info_total_unique_with_duplicates(self):
        contract = ContractInfo("test", "0xtest", [
            FunctionInfo("A", "0x11111111", "a()", Difficulty.TRIVIAL),
            FunctionInfo("B", "0x11111111", "b()", Difficulty.TRIVIAL),
            FunctionInfo("C", "0x22222222", "c()", Difficulty.TRIVIAL),
        ])
        assert contract.total_unique == 2
        assert contract.unique_selectors == {"0x11111111", "0x22222222"}

    def test_contract_info_empty_functions(self):
        contract = ContractInfo("empty", "0xempty", [])
        assert contract.total_unique == 0
        assert contract.unique_selectors == set()

    def test_hl_contracts(self):
        assert len(HL_READ_POSITIONS.functions) >= 1
        assert len(HL_READ_ORACLE.functions) >= 1
        assert len(HL_CORE_WRITER.functions) >= 1
        assert "0x17938e13" in HL_CORE_WRITER.unique_selectors  # sendRawAction


# =========================================================================
# skill_templates tests
# =========================================================================

class TestSkillTemplates:

    def test_dispatch_covers_all_templates(self):
        template_names = {entry[0] for entry in DETERMINISTIC_TEMPLATES}
        dispatch_names = set(_TEMPLATE_DISPATCH.keys())
        assert template_names == dispatch_names, (
            f"Missing in dispatch: {template_names - dispatch_names}, "
            f"Extra: {dispatch_names - template_names}"
        )

    def test_every_template_generates_valid_function_signature(self):
        for i, (name, _, _) in enumerate(DETERMINISTIC_TEMPLATES):
            tname, code = get_template_for_step(i)
            assert tname == name
            assert "export async function executeSkill" in code, (
                f"Template {name} missing executeSkill signature"
            )

    def test_every_template_contains_viem_imports(self):
        for i, (name, _, _) in enumerate(DETERMINISTIC_TEMPLATES):
            _, code = get_template_for_step(i)
            assert "viem" in code, f"{name}: no viem import"

    def test_every_template_returns_json_stringify(self):
        for i, (name, _, _) in enumerate(DETERMINISTIC_TEMPLATES):
            _, code = get_template_for_step(i)
            assert "JSON.stringify" in code, f"{name}: no JSON.stringify"

    def test_out_of_range_step_returns_empty(self):
        name, code = get_template_for_step(9999)
        assert name == ""
        assert code == ""

    def test_negative_step_returns_empty(self):
        name, code = get_template_for_step(-1)
        assert name == ""
        assert code == ""

    def test_total_expected_reward_is_positive(self):
        total = get_total_expected_deterministic_reward()
        assert total > 0
        assert total == sum(entry[1] for entry in DETERMINISTIC_TEMPLATES)

    def test_eth_transfer_template_has_sendAndTrack(self):
        code = eth_transfer_template()
        assert "sendAndTrack" in code
        assert "parseEther" in code

    def test_deploy_erc20_template_has_deployment(self):
        code = deploy_erc20_template()
        assert "to: null" in code  # deployment
        assert "encodeFunctionData" in code

    def test_precompile_template_has_correct_addresses(self):
        code = precompile_batch1_template()
        assert "0x0000000000000000000000000000000000000004" in code  # identity
        assert "0x0000000000000000000000000000000000000002" in code  # sha256
        assert "0x0000000000000000000000000000000000000003" in code  # ripemd160


# =========================================================================
# exploration_strategy tests
# =========================================================================

class TestDiscoveryState:

    def test_initial_state(self):
        s = DiscoveryState()
        assert len(s.discovered) == 0
        assert s.current_step == 0
        assert s.total_reward == 0
        assert s.phase == "deterministic"
        assert s.remaining_unique == get_total_unique_pairs("general")

    def test_record_discovery_new_pairs(self):
        s = DiscoveryState()
        count = s.record_discovery("0xcontract1", ["0xa9059cbb", "0x095ea7b3"])
        assert count == 2
        assert len(s.discovered) == 2

    def test_record_discovery_duplicates_ignored(self):
        s = DiscoveryState()
        s.record_discovery("0xcontract1", ["0xa9059cbb", "0x095ea7b3"])
        count = s.record_discovery("0xcontract1", ["0x095ea7b3", "0x23b872dd"])
        assert count == 1  # only transferFrom is new
        assert len(s.discovered) == 3

    def test_record_discovery_same_selector_different_contract(self):
        s = DiscoveryState()
        s.record_discovery("0xcontract1", ["0xa9059cbb"])
        count = s.record_discovery("0xcontract2", ["0xa9059cbb"])
        assert count == 1  # different contract = different pair
        assert len(s.discovered) == 2

    def test_record_discovery_empty_list(self):
        s = DiscoveryState()
        count = s.record_discovery("0xcontract1", [])
        assert count == 0

    def test_record_step_increments(self):
        s = DiscoveryState()
        s.record_step("tmpl1", 5, True)
        assert s.current_step == 1
        assert s.total_reward == 5
        assert len(s.history) == 1
        assert s.history[0] == (0, "tmpl1", 5, True)

    def test_record_step_failure_adds_to_failed_set(self):
        s = DiscoveryState()
        s.record_step("bad_tmpl", 0, False)
        assert "bad_tmpl" in s.failed_templates

    def test_record_step_success_not_in_failed_set(self):
        s = DiscoveryState()
        s.record_step("good_tmpl", 10, True)
        assert "good_tmpl" not in s.failed_templates

    def test_register_contract(self):
        s = DiscoveryState()
        s.register_contract("0xABCD1234", "ERC20 Token")
        assert "0xabcd1234" in s.deployed_contracts
        assert s.deployed_contracts["0xabcd1234"] == "ERC20 Token"

    def test_case_insensitive_discovery(self):
        s = DiscoveryState()
        s.record_discovery("0xABCD", ["0xA9059CBB"])
        count = s.record_discovery("0xabcd", ["0xa9059cbb"])
        assert count == 0  # Same pair, different case


class TestExplorationStrategy:

    def test_first_action_is_deterministic(self):
        strat = ExplorationStrategy(max_messages=50)
        action = strat.get_next_action()
        assert action["type"] == "deterministic"
        assert "code" in action
        assert "executeSkill" in action["code"]

    def test_deterministic_phase_produces_all_templates(self):
        strat = ExplorationStrategy(max_messages=100)
        names = []
        for _ in range(len(DETERMINISTIC_TEMPLATES) + 5):
            action = strat.get_next_action()
            if action["type"] == "deterministic":
                names.append(action["template_name"])
                strat.record_result(action["template_name"], 1, True)
            else:
                break
        expected_names = [entry[0] for entry in DETERMINISTIC_TEMPLATES]
        assert names == expected_names

    def test_phase_transitions_to_llm_after_deterministic(self):
        strat = ExplorationStrategy(max_messages=100)
        for _ in range(len(DETERMINISTIC_TEMPLATES)):
            action = strat.get_next_action()
            strat.record_result(action.get("template_name", ""), 0, True)
        action = strat.get_next_action()
        assert action["type"] == "llm_assisted"
        assert strat.state.phase == "llm_assisted"
        assert "prompt_context" in action

    def test_done_when_messages_exhausted(self):
        strat = ExplorationStrategy(max_messages=2)
        for _ in range(2):
            action = strat.get_next_action()
            strat.record_result(action.get("template_name", ""), 1, True)
        action = strat.get_next_action()
        assert action["type"] == "done"

    def test_done_at_zero_messages(self):
        strat = ExplorationStrategy(max_messages=0)
        action = strat.get_next_action()
        assert action["type"] == "done"

    def test_failed_template_skipped(self):
        strat = ExplorationStrategy(max_messages=50)
        action1 = strat.get_next_action()
        first_name = action1["template_name"]
        strat.record_result(first_name, 0, False)
        action2 = strat.get_next_action()
        assert action2["template_name"] != first_name

    def test_record_result_with_selector_info(self):
        strat = ExplorationStrategy(max_messages=50)
        action = strat.get_next_action()
        info = {
            "unique_selectors": {
                "0xcontract1": ["0xa9059cbb", "0x095ea7b3"],
                "0xcontract2": ["0x70a08231"],
            }
        }
        strat.record_result(action["template_name"], 3, True, info)
        assert ("0xcontract1", "0xa9059cbb") in strat.state.discovered
        assert ("0xcontract1", "0x095ea7b3") in strat.state.discovered
        assert ("0xcontract2", "0x70a08231") in strat.state.discovered

    def test_record_result_with_deployments(self):
        strat = ExplorationStrategy(max_messages=50)
        action = strat.get_next_action()
        info = {
            "unique_selectors": {},
            "deployed_contracts": {"0xdeadbeef": "ERC20 Token"},
        }
        strat.record_result(action["template_name"], 0, True, info)
        assert "0xdeadbeef" in strat.state.deployed_contracts

    def test_llm_context_contains_undiscovered(self):
        strat = ExplorationStrategy(max_messages=50)
        for _ in range(len(DETERMINISTIC_TEMPLATES)):
            action = strat.get_next_action()
            strat.record_result(action.get("template_name", ""), 0, True)
        action = strat.get_next_action()
        ctx = action["prompt_context"]
        assert "Reward:" in ctx
        assert "Undiscovered" in ctx

    def test_summary_format(self):
        strat = ExplorationStrategy(max_messages=5)
        action = strat.get_next_action()
        strat.record_result(action["template_name"], 10, True)
        summary = strat.get_summary()
        assert "Messages: 1/5" in summary
        assert "Reward: 10" in summary
        assert "[OK]" in summary

    def test_summary_shows_failures(self):
        strat = ExplorationStrategy(max_messages=5)
        action = strat.get_next_action()
        strat.record_result(action["template_name"], 0, False)
        summary = strat.get_summary()
        assert "[FAIL]" in summary

    def test_hyperliquid_chain_has_more_targets(self):
        strat_general = ExplorationStrategy(max_messages=50, chain="general")
        strat_hl = ExplorationStrategy(max_messages=50, chain="hyperliquid")
        assert strat_hl.state.remaining_unique > strat_general.state.remaining_unique


# =========================================================================
# anvil_env tests
# =========================================================================

class TestAnvilEnv:

    def test_construction_defaults(self):
        from benchmarks.evm.anvil_env import AnvilEnv, ANVIL_DEFAULT_ADDRESS
        env = AnvilEnv()
        assert env.rpc_url == "http://127.0.0.1:8545"
        assert env.chain_id == 31337
        assert env.chain == "general"
        assert env.agent_address == ANVIL_DEFAULT_ADDRESS
        assert env.total_reward == 0
        assert env.discovered_count == 0

    def test_construction_custom(self):
        from benchmarks.evm.anvil_env import AnvilEnv
        env = AnvilEnv(
            rpc_url="http://localhost:9545",
            chain_id=998,
            chain="hyperliquid",
            use_external_node=True,
        )
        assert env.rpc_url == "http://localhost:9545"
        assert env.chain_id == 998
        assert env.chain == "hyperliquid"
        assert env.use_external_node is True

    def test_step_with_valid_results(self):
        import asyncio
        from benchmarks.evm.anvil_env import AnvilEnv

        env = AnvilEnv(use_external_node=True)
        result_json = json.dumps({
            "results": [
                {"txHash": "0x1234", "to": "0xcontract1", "selector": "0xa9059cbb", "success": True},
                {"txHash": "0x5678", "to": "0xcontract1", "selector": "0x095ea7b3", "success": True},
                {"txHash": "0x9abc", "to": "0xcontract2", "selector": "0xa9059cbb", "success": True},
            ],
            "error": None,
        })

        step_result = asyncio.get_event_loop().run_until_complete(env.step(result_json))
        assert step_result.reward == 3
        assert env.total_reward == 3
        assert env.discovered_count == 3

    def test_step_with_duplicate_selectors(self):
        import asyncio
        from benchmarks.evm.anvil_env import AnvilEnv

        env = AnvilEnv(use_external_node=True)
        result_json = json.dumps({
            "results": [
                {"txHash": "0x1", "to": "0xcontract1", "selector": "0xa9059cbb", "success": True},
                {"txHash": "0x2", "to": "0xcontract1", "selector": "0xa9059cbb", "success": True},
            ],
            "error": None,
        })

        step_result = asyncio.get_event_loop().run_until_complete(env.step(result_json))
        assert step_result.reward == 1  # Second is duplicate
        assert env.total_reward == 1

    def test_step_with_failed_tx(self):
        import asyncio
        from benchmarks.evm.anvil_env import AnvilEnv

        env = AnvilEnv(use_external_node=True)
        result_json = json.dumps({
            "results": [
                {"txHash": "0x1", "to": "0xcontract1", "selector": "0xa9059cbb", "success": False},
            ],
            "error": None,
        })

        step_result = asyncio.get_event_loop().run_until_complete(env.step(result_json))
        assert step_result.reward == 0

    def test_step_with_error(self):
        import asyncio
        from benchmarks.evm.anvil_env import AnvilEnv

        env = AnvilEnv(use_external_node=True)
        result_json = json.dumps({"results": [], "error": "Something failed"})

        step_result = asyncio.get_event_loop().run_until_complete(env.step(result_json))
        assert step_result.reward == 0
        assert step_result.error == "Something failed"

    def test_step_with_invalid_json(self):
        import asyncio
        from benchmarks.evm.anvil_env import AnvilEnv

        env = AnvilEnv(use_external_node=True)
        step_result = asyncio.get_event_loop().run_until_complete(env.step("not json"))
        assert step_result.reward == 0
        assert "Invalid JSON" in step_result.error

    def test_step_tracks_deployments(self):
        import asyncio
        from benchmarks.evm.anvil_env import AnvilEnv

        env = AnvilEnv(use_external_node=True)
        result_json = json.dumps({
            "results": [
                {"txHash": "0x1", "to": "0x0000000000000000000000000000000000000000",
                 "selector": "0x", "success": True, "deployedAddress": "0xNewContract"},
            ],
            "error": None,
        })

        step_result = asyncio.get_event_loop().run_until_complete(env.step(result_json))
        assert "0xnewcontract" in env._deployed_contracts


# =========================================================================
# eliza_explorer tests
# =========================================================================

class TestElizaExplorerConstruction:

    def test_default_construction(self):
        from benchmarks.evm.eliza_explorer import ElizaExplorer
        explorer = ElizaExplorer(max_messages=3)
        assert explorer.max_messages == 3
        assert explorer.model_name == "qwen/qwen3-32b"
        assert explorer.chain == "general"
        assert explorer.env_config is None
        assert explorer.run_id.startswith("evm_")
        assert explorer._llm is None

    def test_construction_with_chain(self):
        from benchmarks.evm.eliza_explorer import ElizaExplorer
        explorer = ElizaExplorer(chain="hyperliquid", max_messages=5)
        assert explorer.chain == "hyperliquid"

    def test_construction_with_env_config(self):
        from benchmarks.evm.eliza_explorer import ElizaExplorer
        explorer = ElizaExplorer(
            environment_config="general_env.json",
            max_messages=5,
        )
        assert explorer.env_config is not None
        assert explorer.env_config["name"] == "general_evm_benchmark"

    def test_timeout_default(self):
        from benchmarks.evm.eliza_explorer import ElizaExplorer
        explorer = ElizaExplorer(max_messages=1)
        assert explorer._timeout_ms == 30000

    def test_timeout_from_config(self):
        from benchmarks.evm.eliza_explorer import ElizaExplorer
        explorer = ElizaExplorer(
            environment_config="hyperliquid_env.json",
        )
        assert explorer._timeout_ms == 60000

    def test_ensure_llm_raises_without_key(self):
        from benchmarks.evm.eliza_explorer import ElizaExplorer
        explorer = ElizaExplorer(max_messages=1)
        # Remove all possible API keys
        saved: dict[str, str] = {}
        for var in ("GROQ_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY"):
            val = os.environ.pop(var, None)
            if val:
                saved[var] = val
        try:
            with pytest.raises(RuntimeError, match="No API key found"):
                explorer._ensure_llm()
        finally:
            os.environ.update(saved)

    def test_metrics_structure(self):
        from benchmarks.evm.eliza_explorer import ElizaExplorer
        explorer = ElizaExplorer(max_messages=1, run_index=42)
        m = explorer.metrics
        assert m["run_index"] == 42
        assert m["model"] == "qwen/qwen3-32b"
        assert isinstance(m["messages"], list)
        assert isinstance(m["errors"], list)
        assert isinstance(m["contracts_discovered"], dict)

    def test_code_pattern_extracts_typescript(self):
        from benchmarks.evm.eliza_explorer import ElizaExplorer
        explorer = ElizaExplorer(max_messages=1)
        text = "here is code:\n```typescript\nconst x = 1;\n```\nand more"
        matches = explorer.code_pattern.findall(text)
        assert len(matches) == 1
        assert "const x = 1;" in matches[0]

    def test_code_pattern_extracts_multiple_blocks(self):
        from benchmarks.evm.eliza_explorer import ElizaExplorer
        explorer = ElizaExplorer(max_messages=1)
        text = "```ts\nblock1\n```\ntext\n```javascript\nblock2\n```"
        matches = explorer.code_pattern.findall(text)
        assert len(matches) == 2


# =========================================================================
# skill_templates: TypeScript validity via real Bun execution
# =========================================================================

BUN_AVAILABLE = subprocess.run(
    ["bun", "--version"], capture_output=True, text=True
).returncode == 0

NODE_MODULES_PRESENT = (SKILL_RUNNER_DIR / "node_modules").is_dir()


@pytest.mark.skipif(not BUN_AVAILABLE, reason="Bun not installed")
@pytest.mark.skipif(not NODE_MODULES_PRESENT, reason="node_modules not installed in skill_runner")
class TestTemplatesBunTypeCheck:
    """Verify TypeScript templates compile correctly via Bun."""

    @pytest.fixture
    def code_file(self) -> str:
        return str(SKILL_RUNNER_DIR / "_test_skill.ts")

    def _check_compiles(self, code: str, code_file: str) -> bool:
        """Write code and check it compiles with bun."""
        with open(code_file, "w") as f:
            f.write(code)
        # Use bun to check syntax
        result = subprocess.run(
            ["bun", "build", "--no-bundle", code_file],
            capture_output=True, text=True, cwd=str(SKILL_RUNNER_DIR),
        )
        return result.returncode == 0

    def test_eth_transfer_compiles(self, code_file: str):
        code = eth_transfer_template()
        assert self._check_compiles(code, code_file), "eth_transfer template failed to compile"

    @pytest.mark.parametrize("step_idx", range(len(DETERMINISTIC_TEMPLATES)))
    def test_all_templates_compile(self, code_file: str, step_idx: int):
        name, code = get_template_for_step(step_idx)
        assert self._check_compiles(code, code_file), (
            f"Template '{name}' (step {step_idx}) failed to compile"
        )


# =========================================================================
# Run with: pytest benchmarks/evm/test_evm_benchmark.py -v
# =========================================================================
