"""Unit tests for the eliza-adapter EVM explorer.

Focus: the P2c bun-build retry helpers. The async ``run`` loop integrates with
an Anvil node and a Bun subprocess; that path is covered by the EVM
benchmark's own integration tests.
"""

from __future__ import annotations

from eliza_adapter.evm import ElizaBridgeEVMExplorer


def test_is_bun_build_error_detects_typescript_diagnostic() -> None:
    result = {
        "results": [],
        "error": "Bun exit 1: skill.ts:7:12 - error TS2304: Cannot find name 'BigInt'.",
    }
    assert ElizaBridgeEVMExplorer._is_bun_build_error(result) is True


def test_is_bun_build_error_uses_stderr_when_present() -> None:
    result = {
        "results": [],
        "error": "Bun exit 1: short summary",
        "stderr": "skill.ts:3:1 - error TS2307: Cannot find module 'viem'.",
    }
    assert ElizaBridgeEVMExplorer._is_bun_build_error(result) is True


def test_is_bun_build_error_detects_syntax_error() -> None:
    result = {
        "results": [],
        "error": "SyntaxError: Unexpected token '}' at skill.ts:14",
    }
    assert ElizaBridgeEVMExplorer._is_bun_build_error(result) is True


def test_is_bun_build_error_skips_runtime_chain_errors() -> None:
    # Anvil rejection: the skill compiled and ran but the chain reverted. We
    # don't want to retry this — it's not a build failure.
    result = {
        "results": [],
        "error": "execution reverted: insufficient balance",
    }
    assert ElizaBridgeEVMExplorer._is_bun_build_error(result) is False


def test_is_bun_build_error_skips_partial_success() -> None:
    # If the skill produced on-chain results before the error, treat as a
    # partial-success and do not retry.
    result = {
        "results": [{"tx": "0xabc"}],
        "error": "error TS2304: Cannot find name 'foo'.",
    }
    assert ElizaBridgeEVMExplorer._is_bun_build_error(result) is False


def test_is_bun_build_error_skips_empty_error() -> None:
    assert ElizaBridgeEVMExplorer._is_bun_build_error({"results": [], "error": ""}) is False
    assert ElizaBridgeEVMExplorer._is_bun_build_error({"results": []}) is False


def test_format_skill_error_prefers_stderr() -> None:
    result = {
        "results": [],
        "error": "Bun exit 1: see stderr",
        "stderr": "skill.ts:1:1 - error TS2304: Cannot find name 'X'.",
    }
    assert "TS2304" in ElizaBridgeEVMExplorer._format_skill_error(result)


def test_format_skill_error_falls_back_to_error() -> None:
    result = {"results": [], "error": "Bun exit 1: top-level summary"}
    assert "top-level summary" in ElizaBridgeEVMExplorer._format_skill_error(result)
