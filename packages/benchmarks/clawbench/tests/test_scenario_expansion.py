from __future__ import annotations

from clawbench.scenarios import (
    base_scenario_name,
    count_scenarios,
    load_scenario,
    load_scenarios,
    validate_scenarios,
)


def test_clawbench_scenarios_expand_by_exactly_10x() -> None:
    assert count_scenarios() == {
        "suite": "clawbench",
        "existing": 5,
        "added": 50,
        "total": 55,
        "multiplierAdded": 10,
    }
    assert validate_scenarios() == {
        "valid": True,
        "total": 55,
        "uniqueIds": 55,
        "duplicateIds": [],
        "missingPrompt": [],
        "missingScoring": [],
        "missingTools": [],
        "expansionMatches": True,
    }


def test_expanded_scenario_keeps_base_fixture_identity() -> None:
    scenario = load_scenario("inbox_triage--edge-mobile")
    assert scenario["name"] == "inbox_triage--edge-mobile"
    assert scenario["_base_name"] == "inbox_triage"
    assert "Sent from mobile" in scenario["prompt"]
    assert scenario["scoring"]["checks"]
    assert base_scenario_name(scenario["name"]) == "inbox_triage"


def test_all_expanded_ids_are_addressable() -> None:
    for scenario in load_scenarios():
        assert load_scenario(str(scenario["name"]))["name"] == scenario["name"]
