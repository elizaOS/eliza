"""Tests for GAIA harness routing helpers."""

from __future__ import annotations

from elizaos_gaia.harness import harness_env_updates, resolve_harness
from elizaos_gaia.types import GAIAConfig


def test_config_harness_takes_precedence_over_environment(monkeypatch) -> None:
    monkeypatch.setenv("ELIZA_BENCH_HARNESS", "eliza")

    route = resolve_harness(GAIAConfig(harness="openclaw"))

    assert route.harness == "openclaw"
    assert route.backend == "openclaw_adapter_via_eliza_client"


def test_harness_env_updates_sets_all_delegate_variables() -> None:
    updates = harness_env_updates(resolve_harness(explicit="hermes"))

    assert updates == {
        "BENCHMARK_HARNESS": "hermes",
        "ELIZA_BENCH_HARNESS": "hermes",
        "BENCHMARK_AGENT": "hermes",
    }
