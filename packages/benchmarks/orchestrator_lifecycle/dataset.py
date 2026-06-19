"""Scenario dataset loader for orchestrator lifecycle benchmark."""

from __future__ import annotations

import json
import re
from dataclasses import replace
from pathlib import Path

from .types import Scenario, ScenarioTurn

EXPANSION_MULTIPLIER = 10
EDGE_VARIANTS: tuple[tuple[str, str, str], ...] = (
    ("polite", "Polite framing.", "Please help with this: {message}"),
    ("urgent", "Urgent operations framing.", "This is urgent: {message}"),
    ("mobile", "Mobile-message framing.", "Sent from mobile, quick note: {message}"),
    ("followup", "Follow-up thread framing.", "Following up from earlier: {message}"),
    ("quoted", "Forwarded quoted request.", "Forwarded request:\n> {message}"),
    ("context", "Extra operating context.", "Context: orchestrator lifecycle benchmark\n{message}"),
    ("brief", "Brevity preference.", "Keep this brief if you reply: {message}"),
    ("noisy", "Natural chat filler.", "Hey, sorry for the messy phrasing, {message}"),
    ("boundary", "Explicit user-intent boundary.", "User intent starts here:\n{message}"),
    ("handoff", "Teammate handoff framing.", "My teammate asked me to pass this along: {message}"),
)

if len(EDGE_VARIANTS) != EXPANSION_MULTIPLIER:
    raise RuntimeError(
        f"orchestrator lifecycle expansion requires {EXPANSION_MULTIPLIER} variants, "
        f"found {len(EDGE_VARIANTS)}"
    )


class LifecycleDataset:
    def __init__(self, scenario_dir: str) -> None:
        self.scenario_dir = self._resolve_scenario_dir(Path(scenario_dir))

    def load_base(self) -> list[Scenario]:
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

    def load_expanded(self) -> list[Scenario]:
        base = self.load_base()
        expanded = [
            _apply_variant(scenario, variant_id, description, template)
            for scenario in base
            for variant_id, description, template in EDGE_VARIANTS
        ]
        if len(expanded) != len(base) * EXPANSION_MULTIPLIER:
            raise RuntimeError(
                "orchestrator lifecycle scenario expansion mismatch: "
                f"expected {len(base) * EXPANSION_MULTIPLIER}, found {len(expanded)}"
            )
        return expanded

    def load(self) -> list[Scenario]:
        base = self.load_base()
        return [*base, *self.load_expanded()]

    def count_scenarios(self) -> dict[str, int | str | float]:
        base = self.load_base()
        expanded = self.load_expanded()
        return {
            "suite": "orchestrator-lifecycle",
            "existing": len(base),
            "added": len(expanded),
            "total": len(base) + len(expanded),
            "multiplierAdded": len(expanded) / len(base),
        }

    def validate_scenarios(self) -> dict[str, object]:
        base = self.load_base()
        expanded = self.load_expanded()
        all_scenarios = [*base, *expanded]
        ids: set[str] = set()
        duplicate_ids: set[str] = set()
        empty_turns: list[str] = []

        for scenario in all_scenarios:
            if scenario.scenario_id in ids:
                duplicate_ids.add(scenario.scenario_id)
            ids.add(scenario.scenario_id)
            if not scenario.turns or any(not turn.message.strip() for turn in scenario.turns):
                empty_turns.append(scenario.scenario_id)

        expansion_matches = len(expanded) == len(base) * EXPANSION_MULTIPLIER
        return {
            "valid": not duplicate_ids and not empty_turns and expansion_matches,
            "total": len(all_scenarios),
            "uniqueIds": len(ids),
            "duplicateIds": sorted(duplicate_ids),
            "emptyTurns": empty_turns,
            "expansionMatches": expansion_matches,
        }

    def _resolve_scenario_dir(self, scenario_dir: Path) -> Path:
        if scenario_dir.exists() or scenario_dir.is_absolute():
            return scenario_dir

        package_dir = Path(__file__).resolve().parent
        packages_root = package_dir.parents[1]
        candidates = [
            packages_root / scenario_dir,
            package_dir / scenario_dir,
            package_dir / scenario_dir.name,
        ]
        return next((candidate for candidate in candidates if candidate.exists()), scenario_dir)


def base_scenario_id(scenario_id: str) -> str:
    return re.sub(r"--edge-[a-z-]+$", "", scenario_id)


def _apply_variant(
    scenario: Scenario,
    variant_id: str,
    description: str,
    template: str,
) -> Scenario:
    return Scenario(
        scenario_id=f"{scenario.scenario_id}--edge-{variant_id}",
        title=f"{scenario.title} ({variant_id})",
        category=scenario.category,
        required_capabilities=list(scenario.required_capabilities),
        turns=[
            replace(turn, message=template.format(message=turn.message))
            if turn.actor == "user"
            else replace(turn)
            for turn in scenario.turns
        ],
    )
