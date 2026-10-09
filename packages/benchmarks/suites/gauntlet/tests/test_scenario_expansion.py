from __future__ import annotations

from pathlib import Path

from gauntlet.scenarios import (
    base_scenario_id,
    count_scenarios,
    load_scenarios,
    validate_scenarios,
)

SCENARIOS_DIR = Path(__file__).resolve().parents[1] / "scenarios"


def test_gauntlet_scenarios_expand_by_exactly_10x() -> None:
    assert count_scenarios(SCENARIOS_DIR) == {
        "suite": "gauntlet",
        "existing": 96,
        "added": 960,
        "total": 1056,
        "multiplierAdded": 10,
    }
    assert validate_scenarios(SCENARIOS_DIR) == {
        "valid": True,
        "total": 1056,
        "uniqueIds": 1056,
        "duplicateIds": [],
        "missingTasks": [],
        "missingScoring": [],
        "expansionMatches": True,
    }


def test_expanded_gauntlet_scenarios_keep_level_and_base_identity() -> None:
    scenarios = load_scenarios(SCENARIOS_DIR)
    level1 = scenarios[1]
    generated = next(s for s in level1 if s.id == "swap_sol_usdc--edge-mobile")
    assert generated.level == 1
    assert generated.base_id == "swap_sol_usdc"
    assert base_scenario_id(generated.id) == "swap_sol_usdc"
    assert generated.tasks
    assert generated.tasks[0]["id"].endswith("--edge-mobile")
    assert "edge_context" in generated.tasks[0]["parameters"]
