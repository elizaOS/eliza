"""Regression tests for OpenClaw scenario expansion."""

from openclaw.scenarios import (
    EDGE_VARIANTS,
    base_scenario_name,
    count_scenarios,
    load_base_scenarios,
    load_scenarios,
    validate_scenarios,
)


def test_expansion_adds_exactly_ten_variants_per_authored_scenario() -> None:
    base = load_base_scenarios()
    expanded = load_scenarios()
    counts = count_scenarios()

    assert len(EDGE_VARIANTS) == 10
    assert counts == {
        "existing": len(base),
        "added": len(base) * 10,
        "total": len(base) * 11,
    }
    assert len(expanded) == counts["total"]


def test_expanded_scenarios_preserve_base_mapping_and_prompt() -> None:
    scenario_id = "setup--edge-idempotent-rerun"
    scenarios = load_scenarios()

    assert scenario_id in scenarios
    assert base_scenario_name(scenario_id) == "setup"
    assert scenarios[scenario_id]["base_scenario"] == "setup"
    assert "idempotent" in scenarios[scenario_id]["prompt"].lower()


def test_expanded_scenarios_validate() -> None:
    validate_scenarios()
