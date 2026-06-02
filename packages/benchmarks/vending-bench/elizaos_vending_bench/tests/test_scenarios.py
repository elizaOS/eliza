"""Tests for Vending-Bench scenario expansion."""

from __future__ import annotations

from decimal import Decimal

from elizaos_vending_bench.scenarios import (
    EDGE_VARIANTS,
    count_scenarios,
    expanded_run_configs,
    validate_scenarios,
)
from elizaos_vending_bench.types import VendingBenchConfig


def test_count_expanded_scenarios() -> None:
    config = VendingBenchConfig(num_runs=2, include_edge_scenarios=True)

    assert count_scenarios(config) == {
        "base": 2,
        "edge": 2 * len(EDGE_VARIANTS),
        "total": 2 + 2 * len(EDGE_VARIANTS),
    }


def test_expanded_configs_preserve_base_and_add_edges() -> None:
    config = VendingBenchConfig(
        num_runs=1,
        random_seed=42,
        initial_cash=Decimal("500.00"),
        include_edge_scenarios=True,
    )

    scenarios = expanded_run_configs(config)

    assert len(scenarios) == 1 + len(EDGE_VARIANTS)
    assert scenarios[0][0] == "base"
    assert scenarios[0][2].include_edge_scenarios is False
    assert {suffix for suffix, _, _ in scenarios[1:]} == {v.variant_id for v in EDGE_VARIANTS}
    assert any(edge.initial_cash < config.initial_cash for _, _, edge in scenarios[1:])


def test_validate_expanded_scenarios() -> None:
    config = VendingBenchConfig(num_runs=1, max_days_per_run=1, include_edge_scenarios=True)

    validate_scenarios(config)
