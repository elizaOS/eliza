"""Scenario loading and edge expansion helpers for ClawBench."""

from __future__ import annotations

import copy
import re
from pathlib import Path
from typing import Any

import yaml

CLAWBENCH_DIR = Path(__file__).resolve().parent.parent
SCENARIOS_DIR = CLAWBENCH_DIR / "scenarios"
EXPANSION_MULTIPLIER = 10

ScenarioDict = dict[str, Any]
Variant = tuple[str, str, str]

EDGE_VARIANTS: tuple[Variant, ...] = (
    ("polite", "Polite framing.", "Please help with this: {prompt}"),
    ("urgent", "Urgent operations framing.", "This is time sensitive: {prompt}"),
    ("mobile", "Mobile-message framing.", "Sent from mobile, quick note: {prompt}"),
    ("followup", "Follow-up thread framing.", "Following up from earlier: {prompt}"),
    ("quoted", "Forwarded quoted request.", "Forwarded request:\n> {prompt}"),
    ("context", "Extra operating context.", "Context: ClawBench edge case\n{prompt}"),
    ("brief", "Brevity preference.", "Keep this brief if you reply: {prompt}"),
    ("noisy", "Natural chat filler.", "Hey, sorry for the messy phrasing, {prompt}"),
    ("boundary", "Explicit user-intent boundary.", "User intent starts here:\n{prompt}"),
    ("handoff", "Teammate handoff framing.", "My teammate asked me to pass this along: {prompt}"),
)

if len(EDGE_VARIANTS) != EXPANSION_MULTIPLIER:
    raise RuntimeError(
        f"ClawBench expansion requires {EXPANSION_MULTIPLIER} variants, "
        f"found {len(EDGE_VARIANTS)}"
    )


def base_scenario_name(name: str) -> str:
    return re.sub(r"--edge-[a-z-]+$", "", name)


def _load_yaml(path: Path) -> ScenarioDict:
    with open(path, encoding="utf-8") as handle:
        data = yaml.safe_load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"Scenario YAML at {path} did not parse to a dict")
    data.setdefault("name", path.stem)
    data["_base_name"] = data["name"]
    return data


def load_base_scenarios() -> list[ScenarioDict]:
    return [_load_yaml(path) for path in sorted(SCENARIOS_DIR.glob("*.y*ml"))]


def _apply_variant(scenario: ScenarioDict, variant: Variant) -> ScenarioDict:
    variant_id, description, template = variant
    out = copy.deepcopy(scenario)
    base_name = str(scenario.get("_base_name") or scenario.get("name") or "")
    out["name"] = f"{base_name}--edge-{variant_id}"
    out["_base_name"] = base_name
    out["description"] = (
        f"{str(scenario.get('description', '')).strip()} Edge variant: {description}"
    ).strip()
    out["prompt"] = template.format(prompt=str(scenario.get("prompt", "")))
    return out


def expand_scenarios(base_scenarios: list[ScenarioDict]) -> list[ScenarioDict]:
    expanded = [
        _apply_variant(scenario, variant)
        for scenario in base_scenarios
        for variant in EDGE_VARIANTS
    ]
    if len(expanded) != len(base_scenarios) * EXPANSION_MULTIPLIER:
        raise RuntimeError(
            "ClawBench scenario expansion mismatch: "
            f"expected {len(base_scenarios) * EXPANSION_MULTIPLIER}, found {len(expanded)}"
        )
    return expanded


def load_scenarios() -> list[ScenarioDict]:
    base = load_base_scenarios()
    return [*base, *expand_scenarios(base)]


def load_scenario(name_or_path: str) -> ScenarioDict:
    path = Path(name_or_path)
    if path.exists():
        return _load_yaml(path)

    for scenario in load_scenarios():
        if scenario.get("name") == name_or_path:
            return scenario

    available = sorted(str(scenario.get("name")) for scenario in load_scenarios())
    raise FileNotFoundError(f"Scenario '{name_or_path}' not found. Available: {available}")


def count_scenarios() -> dict[str, int | str | float]:
    base = load_base_scenarios()
    expanded = expand_scenarios(base)
    return {
        "suite": "clawbench",
        "existing": len(base),
        "added": len(expanded),
        "total": len(base) + len(expanded),
        "multiplierAdded": len(expanded) / len(base),
    }


def validate_scenarios() -> dict[str, object]:
    base = load_base_scenarios()
    expanded = expand_scenarios(base)
    all_scenarios = [*base, *expanded]
    ids: set[str] = set()
    duplicate_ids: set[str] = set()
    missing_prompt: list[str] = []
    missing_scoring: list[str] = []
    missing_tools: list[str] = []

    for scenario in all_scenarios:
        name = str(scenario.get("name", ""))
        if name in ids:
            duplicate_ids.add(name)
        ids.add(name)
        if not str(scenario.get("prompt", "")).strip():
            missing_prompt.append(name)
        if not scenario.get("scoring", {}).get("checks"):
            missing_scoring.append(name)
        if not scenario.get("tools"):
            missing_tools.append(name)

    expansion_matches = len(expanded) == len(base) * EXPANSION_MULTIPLIER
    return {
        "valid": not duplicate_ids
        and not missing_prompt
        and not missing_scoring
        and not missing_tools
        and expansion_matches,
        "total": len(all_scenarios),
        "uniqueIds": len(ids),
        "duplicateIds": sorted(duplicate_ids),
        "missingPrompt": missing_prompt,
        "missingScoring": missing_scoring,
        "missingTools": missing_tools,
        "expansionMatches": expansion_matches,
    }
