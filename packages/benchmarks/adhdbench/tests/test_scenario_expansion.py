"""Regression tests for ADHDBench scenario expansion."""

from elizaos_adhdbench.config import ADHDBenchConfig
from elizaos_adhdbench.scenarios import (
    ALL_EDGE_SCENARIOS,
    ALL_SCENARIOS,
    EDGE_VARIANTS,
    EXPANDED_SCENARIOS,
    EXPANDED_SCENARIO_BY_ID,
    base_scenario_id,
    count_scenarios,
    get_scenarios,
    validate_scenarios,
)


def test_expansion_adds_exactly_ten_variants_per_authored_scenario() -> None:
    counts = count_scenarios()

    assert len(EDGE_VARIANTS) == 10
    assert counts == {
        "suite": "adhdbench",
        "existing": 45,
        "added": 450,
        "total": 495,
        "multiplierAdded": 10.0,
    }
    assert len(EXPANDED_SCENARIOS) == len(ALL_SCENARIOS) * 10
    assert len(ALL_EDGE_SCENARIOS) == counts["total"]


def test_base_registry_stays_backward_compatible() -> None:
    assert len(ALL_SCENARIOS) == 45
    assert len(get_scenarios()) == 45
    assert len(get_scenarios(include_edge_scenarios=True)) == 495


def test_edge_scenarios_preserve_expected_outcomes_and_map_to_base() -> None:
    scenario_id = "L0-001--edge-prompt-injection"
    edge = EXPANDED_SCENARIO_BY_ID[scenario_id]

    assert base_scenario_id(scenario_id) == "L0-001"
    assert edge.turns[0].expected_outcomes
    assert "untrusted content" in edge.turns[0].text
    assert "edge:prompt-injection" in edge.tags


def test_expanded_scenarios_validate() -> None:
    result = validate_scenarios()

    assert result["valid"] is True
    assert result["expansionMatches"] is True


def test_config_can_opt_into_edge_scenarios() -> None:
    config = ADHDBenchConfig(include_edge_scenarios=True)

    assert config.include_edge_scenarios is True
