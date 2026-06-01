"""CompactBench suite counting and edge-template expansion."""

from __future__ import annotations

from copy import deepcopy
from pathlib import Path
from typing import Any

import yaml

EDGE_VARIANTS: tuple[tuple[str, str], ...] = (
    ("late_noise", "Later notes may be unrelated. Preserve the durable facts and constraints already recorded."),
    ("decision_recap", "The team asks for a short recap, but no decision is changed by this recap."),
    ("owner_confusion", "A second person is mentioned only as context; do not reassign the primary owner."),
    ("negative_memory", "The user explicitly distinguishes a forbidden action from the approved next step."),
    ("reference_stress", "The final question uses pronouns and indirect references to the earlier critical detail."),
    ("format_noise", "A checklist is requested, but the remembered constraint remains the same."),
    ("temporal_gap", "Several low-priority updates happen after the critical instruction."),
    ("paraphrase_pressure", "The critical instruction may need to be recalled by meaning rather than exact wording."),
    ("contradictory_hint", "A later hint sounds like a reversal, but it is marked as unverified."),
    ("boundary_followup", "The final answer must avoid adding any action that violates the recorded constraint."),
)


def suite_template_paths(benchmarks_dir: Path, suite: str) -> list[Path]:
    suite_dir = benchmarks_dir / suite
    if not suite_dir.is_dir():
        raise FileNotFoundError(f"CompactBench suite directory not found: {suite_dir}")
    return sorted(path for path in suite_dir.glob("*.yaml") if path.is_file())


def count_scenarios(
    *,
    benchmarks_dir: Path,
    suite: str,
    case_count: int,
    include_edge_scenarios: bool = False,
) -> dict[str, int]:
    template_count = len(suite_template_paths(benchmarks_dir, suite))
    base = template_count * max(0, int(case_count))
    edge = base * len(EDGE_VARIANTS) if include_edge_scenarios else 0
    return {
        "templates": template_count,
        "base": base,
        "edge": edge,
        "total": base + edge,
        "edge_multiplier": len(EDGE_VARIANTS),
    }


def validate_suite(benchmarks_dir: Path, suite: str) -> None:
    seen: set[str] = set()
    paths = suite_template_paths(benchmarks_dir, suite)
    if not paths:
        raise ValueError(f"CompactBench suite {suite!r} has no YAML templates")
    for path in paths:
        data = _read_yaml(path)
        template = data.get("template")
        if not isinstance(template, dict):
            raise ValueError(f"{path} is missing a template mapping")
        key = str(template.get("key") or "")
        if not key:
            raise ValueError(f"{path} template is missing key")
        if key in seen:
            raise ValueError(f"duplicate CompactBench template key: {key}")
        seen.add(key)
        if not template.get("transcript") or not template.get("evaluation_items"):
            raise ValueError(f"{path} template is missing transcript/evaluation_items")


def build_expanded_suite(
    *,
    benchmarks_dir: Path,
    suite: str,
    output_root: Path,
) -> Path:
    """Copy a suite and add ten edge template variants for every base template."""
    validate_suite(benchmarks_dir, suite)
    source_paths = suite_template_paths(benchmarks_dir, suite)
    expanded_suite = output_root / suite
    expanded_suite.mkdir(parents=True, exist_ok=True)
    for path in source_paths:
        data = _read_yaml(path)
        key = str(data["template"]["key"])
        _write_yaml(expanded_suite / path.name, data)
        for index, (variant_id, instruction) in enumerate(EDGE_VARIANTS, start=1):
            clone = deepcopy(data)
            template = clone["template"]
            template["key"] = f"{key}--edge-{index:02d}"
            template["family"] = str(template.get("family") or key)
            _inject_edge_turn(template, variant_id, instruction)
            _write_yaml(expanded_suite / f"{path.stem}--edge-{index:02d}.yaml", clone)
    return output_root


def _inject_edge_turn(template: dict[str, Any], variant_id: str, instruction: str) -> None:
    transcript = template.setdefault("transcript", {})
    turns = transcript.setdefault("turns", [])
    if not isinstance(turns, list):
        raise ValueError(f"template {template.get('key')} has invalid transcript.turns")
    edge_turn = {
        "role": "user",
        "template": f"Edge memory note ({variant_id}): {instruction}",
        "tags": ["edge_variant", variant_id],
    }
    insert_at = max(0, len(turns) - 1)
    turns.insert(insert_at, edge_turn)
    for item in template.get("evaluation_items", []) or []:
        if isinstance(item, dict) and isinstance(item.get("prompt"), str):
            item["prompt"] = f"{instruction} {item['prompt']}"


def _read_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path} did not parse to a mapping")
    return data


def _write_yaml(path: Path, data: dict[str, Any]) -> None:
    path.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")


__all__ = [
    "EDGE_VARIANTS",
    "build_expanded_suite",
    "count_scenarios",
    "validate_suite",
]
