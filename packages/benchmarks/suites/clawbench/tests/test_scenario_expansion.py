from __future__ import annotations

from pathlib import Path

import pytest

from clawbench import scenarios
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
        "expectedBaseIds": [
            "client_escalation",
            "inbox_to_action",
            "inbox_triage",
            "morning_brief",
            "team_standup",
        ],
        "actualBaseIds": [
            "client_escalation",
            "inbox_to_action",
            "inbox_triage",
            "morning_brief",
            "team_standup",
        ],
        "duplicateBaseIds": [],
        "missingBaseIds": [],
        "unexpectedBaseIds": [],
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


def test_missing_base_scenario_invalidates_count_and_loading(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    for scenario_id in sorted(scenarios.EXPECTED_BASE_SCENARIO_IDS - {"team_standup"}):
        (tmp_path / f"{scenario_id}.yaml").write_text(
            "\n".join(
                [
                    f"name: {scenario_id}",
                    "prompt: Test prompt",
                    "tools: [exec]",
                    "scoring:",
                    "  checks:",
                    "    - id: answer",
                    "      type: response_contains",
                    "      pattern: test",
                ]
            ),
            encoding="utf-8",
        )
    monkeypatch.setattr(scenarios, "SCENARIOS_DIR", tmp_path)

    validation = scenarios.validate_scenarios()
    assert validation["valid"] is False
    assert validation["missingBaseIds"] == ["team_standup"]
    with pytest.raises(ValueError, match="invalid ClawBench corpus"):
        scenarios.count_scenarios()
    with pytest.raises(ValueError, match="base scenario corpus drifted"):
        scenarios.load_scenarios()
