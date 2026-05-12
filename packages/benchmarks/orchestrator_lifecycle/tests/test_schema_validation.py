from __future__ import annotations

import json
from pathlib import Path


def test_seed_scenarios_match_minimum_schema() -> None:
    scenario_dir = Path("benchmarks/orchestrator_lifecycle/scenarios")
    for path in scenario_dir.glob("*.json"):
        if path.name == "schema.json":
            continue
        payload = json.loads(path.read_text(encoding="utf-8"))
        assert isinstance(payload.get("scenario_id"), str)
        assert isinstance(payload.get("title"), str)
        assert isinstance(payload.get("category"), str)
        turns = payload.get("turns")
        assert isinstance(turns, list)
        assert turns, f"Scenario {path.name} must include at least one turn"
        for turn in turns:
            assert isinstance(turn, dict)
            assert isinstance(turn.get("actor"), str)
            assert isinstance(turn.get("message"), str)
