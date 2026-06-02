from __future__ import annotations

from benchmarks.HyperliquidBench.__main__ import (
    count_scenarios,
    expand_scenarios,
    validate_scenarios,
)
from benchmarks.HyperliquidBench.eliza_agent import make_coverage_scenario


def test_hyperliquid_scenario_expansion_adds_ten_edge_variants() -> None:
    base = [make_coverage_scenario(allowed_coins=["ETH", "BTC"], max_steps=3)]

    expanded = expand_scenarios(base)

    assert len(expanded) == 11
    assert expanded[0].scenario_id == "coverage_smoke"
    assert expanded[1].scenario_id == "coverage_smoke__edge_01"
    assert "Edge condition:" in expanded[1].description
    assert expanded[2].allowed_coins == ["BTC", "ETH"]


def test_hyperliquid_scenario_count_and_validate() -> None:
    base = [make_coverage_scenario(allowed_coins=["ETH", "BTC"], max_steps=3)]

    validate_scenarios(base, include_edge_scenarios=True)

    assert count_scenarios(base, include_edge_scenarios=True) == {
        "base": 1,
        "edge": 10,
        "edge_multiplier": 10,
        "total": 11,
    }
