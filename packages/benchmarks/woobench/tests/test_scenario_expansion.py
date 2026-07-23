"""Regression tests for WooBench scenario expansion."""

from woobench.__main__ import _build_parser

from woobench.scenarios import (
    ALL_SCENARIOS,
    BASE_SCENARIOS,
    EDGE_VARIANTS,
    EXPANDED_SCENARIOS,
    SCENARIOS_BY_ARCHETYPE,
    SCENARIOS_BY_ID,
    SCENARIOS_BY_SYSTEM,
    base_scenario_id,
    count_woobench_scenarios,
    validate_woobench_scenarios,
)


def test_expansion_adds_exactly_ten_variants_per_authored_scenario() -> None:
    counts = count_woobench_scenarios()

    assert len(EDGE_VARIANTS) == 10
    assert counts == {
        "suite": "woobench",
        "existing": len(BASE_SCENARIOS),
        "added": len(BASE_SCENARIOS) * 10,
        "total": len(BASE_SCENARIOS) * 11,
        "multiplierAdded": 10.0,
    }
    assert len(EXPANDED_SCENARIOS) == len(BASE_SCENARIOS) * 10
    assert len(ALL_SCENARIOS) == counts["total"]


def test_expanded_scenarios_are_addressable_in_indexes() -> None:
    scenario_id = "true_believer_tarot_01--edge-high-stakes-decision"

    assert scenario_id in SCENARIOS_BY_ID
    assert base_scenario_id(scenario_id) == "true_believer_tarot_01"
    assert SCENARIOS_BY_ID[scenario_id] in SCENARIOS_BY_SYSTEM["tarot"]
    assert SCENARIOS_BY_ID[scenario_id] in SCENARIOS_BY_ARCHETYPE["true_believer"]
    assert "major move" in SCENARIOS_BY_ID[scenario_id].opening


def test_expanded_scenarios_validate() -> None:
    result = validate_woobench_scenarios()

    assert result["valid"] is True
    assert result["expansionMatches"] is True


def test_full_campaign_expansion_flag_is_supported() -> None:
    args = _build_parser().parse_args(["--expand-scenarios", "--dry-run"])

    assert args.expand_scenarios is True
