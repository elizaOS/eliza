"""Scenario loading and expansion for OpenClaw."""

from __future__ import annotations

from copy import deepcopy
from pathlib import Path
from typing import Any

import yaml

SCENARIOS_DIR = Path(__file__).parent / "scenarios"

EDGE_VARIANTS: tuple[dict[str, str], ...] = (
    {
        "suffix": "messy-existing-files",
        "name": "messy existing files",
        "prompt": (
            "\n\nEdge context: the workspace may contain extra notes, stale build "
            "artifacts, or unrelated files. Inspect before editing and preserve "
            "unrelated content."
        ),
    },
    {
        "suffix": "minimal-tools",
        "name": "minimal tool budget",
        "prompt": (
            "\n\nEdge context: complete the task with a small number of focused "
            "reads, writes, and commands. Avoid broad rewrites when a targeted "
            "change satisfies the requirements."
        ),
    },
    {
        "suffix": "ambiguous-user-language",
        "name": "ambiguous user wording",
        "prompt": (
            "\n\nEdge context: the requester used informal wording, but the YAML "
            "requirements and scoring checks are authoritative. Resolve ambiguity "
            "toward the smallest implementation that passes those checks."
        ),
    },
    {
        "suffix": "strict-typescript",
        "name": "strict TypeScript",
        "prompt": (
            "\n\nEdge context: TypeScript strict mode is enforced. Avoid implicit "
            "any values, preserve module compatibility, and run a relevant compile "
            "or test command before finishing."
        ),
    },
    {
        "suffix": "offline-deterministic",
        "name": "offline deterministic",
        "prompt": (
            "\n\nEdge context: the sandbox has no guaranteed network access except "
            "package installation already implied by the task. Keep weather behavior "
            "deterministic and do not depend on a live weather API."
        ),
    },
    {
        "suffix": "idempotent-rerun",
        "name": "idempotent rerun",
        "prompt": (
            "\n\nEdge context: this task may be rerun in a workspace where some "
            "expected files already exist. Make the result correct and idempotent "
            "instead of failing on existing paths."
        ),
    },
    {
        "suffix": "preserve-package-json",
        "name": "preserve package metadata",
        "prompt": (
            "\n\nEdge context: package.json may already contain useful fields. Read "
            "it before changing it and preserve unrelated metadata, scripts, and "
            "dependencies."
        ),
    },
    {
        "suffix": "windows-path-caution",
        "name": "cross-platform paths",
        "prompt": (
            "\n\nEdge context: avoid assumptions that only work on one shell or OS. "
            "Prefer Node/TypeScript path handling and portable npm scripts where "
            "that matters."
        ),
    },
    {
        "suffix": "failure-first-verification",
        "name": "failure-first verification",
        "prompt": (
            "\n\nEdge context: verify both success and failure paths. Commands that "
            "only demonstrate the happy path are insufficient when the task asks "
            "for error handling."
        ),
    },
    {
        "suffix": "no-secret-leakage",
        "name": "no secret leakage",
        "prompt": (
            "\n\nEdge context: never hardcode API keys, tokens, passwords, or real "
            "service credentials. Use mock data and local deterministic behavior."
        ),
    },
)


def base_scenario_name(name: str) -> str:
    """Return the authored YAML scenario name for an expanded scenario id."""
    marker = "--edge-"
    if marker in name:
        return name.split(marker, 1)[0]
    return name


def load_base_scenarios(scenarios_dir: Path = SCENARIOS_DIR) -> dict[str, dict[str, Any]]:
    """Load authored YAML scenarios keyed by stem."""
    scenarios: dict[str, dict[str, Any]] = {}
    for path in sorted(scenarios_dir.glob("*.yaml")):
        with path.open() as handle:
            scenarios[path.stem] = yaml.safe_load(handle)
    return scenarios


def _edge_scenario(base_id: str, scenario: dict[str, Any], variant: dict[str, str]) -> dict[str, Any]:
    edge = deepcopy(scenario)
    edge["name"] = f"{scenario.get('name', base_id)} ({variant['name']})"
    edge["description"] = (
        f"{scenario.get('description', '').rstrip()} Edge variant: {variant['name']}."
    ).strip()
    edge["prompt"] = f"{scenario.get('prompt', '').rstrip()}{variant['prompt']}\n"
    edge["base_scenario"] = base_id
    edge["edge_variant"] = variant["suffix"]
    return edge


def load_scenarios(scenarios_dir: Path = SCENARIOS_DIR) -> dict[str, dict[str, Any]]:
    """Load authored scenarios plus exactly ten edge variants per scenario."""
    base = load_base_scenarios(scenarios_dir)
    expanded = dict(base)
    for base_id, scenario in base.items():
        for variant in EDGE_VARIANTS:
            scenario_id = f"{base_id}--edge-{variant['suffix']}"
            expanded[scenario_id] = _edge_scenario(base_id, scenario, variant)
    return expanded


def count_scenarios(scenarios_dir: Path = SCENARIOS_DIR) -> dict[str, int]:
    existing = len(load_base_scenarios(scenarios_dir))
    added = existing * len(EDGE_VARIANTS)
    return {"existing": existing, "added": added, "total": existing + added}


def validate_scenarios(scenarios_dir: Path = SCENARIOS_DIR) -> None:
    scenarios = load_scenarios(scenarios_dir)
    counts = count_scenarios(scenarios_dir)
    if len(scenarios) != counts["total"]:
        raise ValueError(f"expected {counts['total']} scenarios, found {len(scenarios)}")

    missing = [
        scenario_id
        for scenario_id, scenario in scenarios.items()
        if not scenario.get("name") or not scenario.get("prompt")
    ]
    if missing:
        raise ValueError(f"scenarios missing required fields: {', '.join(missing)}")

    duplicate_count = len(scenarios) - len(set(scenarios))
    if duplicate_count:
        raise ValueError(f"found {duplicate_count} duplicate scenario ids")
