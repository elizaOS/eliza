"""Regression tests for OpenClaw scenario expansion."""

from openclaw.scenarios import (
    EDGE_VARIANTS,
    base_scenario_name,
    count_scenarios,
    load_base_scenarios,
    load_scenarios,
    scenario_provenance,
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
    assert scenarios["implementation--edge-idempotent-rerun"]["prerequisites"] == [
        "setup--edge-idempotent-rerun"
    ]


def test_expanded_scenarios_validate() -> None:
    validate_scenarios()


def test_scenario_provenance_records_complete_authored_corpus() -> None:
    provenance = scenario_provenance()

    assert provenance["authored_scenarios"] == 5
    assert provenance["edge_variants_per_scenario"] == 10
    assert provenance["total_scenarios"] == 55
    assert len(provenance["workload_sha256"]) == 64
    assert len(provenance["manifests"]) == 5
    assert all(len(item["sha256"]) == 64 for item in provenance["manifests"])
