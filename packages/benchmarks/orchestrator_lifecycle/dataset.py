"""Scenario dataset loader for orchestrator lifecycle benchmark."""

from __future__ import annotations

import json
from pathlib import Path

from .types import Scenario, ScenarioTurn


class LifecycleDataset:
    def __init__(self, scenario_dir: str) -> None:
        self.scenario_dir = Path(scenario_dir)

    def load(self) -> list[Scenario]:
        if not self.scenario_dir.exists():
            raise FileNotFoundError(f"Scenario directory not found: {self.scenario_dir}")

        scenarios: list[Scenario] = []
        for path in sorted(self.scenario_dir.glob("*.json")):
            if path.name == "schema.json":
                continue
            with open(path, encoding="utf-8") as handle:
                payload = json.load(handle)
            turns_payload = payload.get("turns", [])
            turns: list[ScenarioTurn] = []
            for turn in turns_payload:
                if not isinstance(turn, dict):
                    continue
                turns.append(
                    ScenarioTurn(
                        actor=str(turn.get("actor", "")),
                        message=str(turn.get("message", "")),
                        expected_behaviors=[
                            str(v) for v in turn.get("expected_behaviors", [])
                        ],
                        forbidden_behaviors=[
                            str(v) for v in turn.get("forbidden_behaviors", [])
                        ],
                    )
                )
            scenarios.append(
                Scenario(
                    scenario_id=str(payload.get("scenario_id", path.stem)),
                    title=str(payload.get("title", path.stem)),
                    category=str(payload.get("category", "general")),
                    required_capabilities=[
                        str(v) for v in payload.get("required_capabilities", [])
                    ],
                    turns=turns,
                )
            )
        return scenarios
