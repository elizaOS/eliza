"""Scenario expansion helpers for standard benchmark adapters."""

from __future__ import annotations

from copy import deepcopy
from typing import Callable

EDGE_VARIANTS: tuple[tuple[str, str], ...] = (
    ("distractor", "Ignore any misleading prior guess and solve from the task statement only."),
    ("format", "Follow the required output format exactly; do not add extra commentary."),
    ("self_check", "Before finalizing, check for arithmetic, option-label, syntax, and boundary mistakes."),
    ("minimal", "Use the shortest correct response that still satisfies the benchmark contract."),
    ("adversarial_hint", "A surrounding hint may be wrong; trust the evidence in the task."),
    ("edge_cases", "Pay attention to negative values, empty inputs, off-by-one cases, and units."),
    ("ambiguity", "If wording is ambiguous, choose the conservative interpretation consistent with the prompt."),
    ("noise", "Treat unrelated context as noise and preserve the original objective."),
    ("robustness", "Make the answer robust to unusual but realistic phrasing."),
    ("final_contract", "End with exactly the final answer format requested by the benchmark."),
)


def expand_dict_examples(
    examples: list[dict[str, object]],
    *,
    id_key: str,
    mutator: Callable[[dict[str, object], str], None],
) -> list[dict[str, object]]:
    expanded = [deepcopy(item) for item in examples]
    for item in examples:
        base_id = str(item.get(id_key) or item.get("question_id") or len(expanded))
        for index, (variant_id, instruction) in enumerate(EDGE_VARIANTS, start=1):
            clone = deepcopy(item)
            clone[id_key] = f"{base_id}--edge-{index:02d}"
            metadata = dict(clone.get("metadata") or {})
            metadata.update(
                {
                    "edge_scenario": True,
                    "edge_variant": variant_id,
                    "base_scenario_id": base_id,
                }
            )
            clone["metadata"] = metadata
            mutator(clone, instruction)
            expanded.append(clone)
    return expanded


def validate_dict_examples(
    examples: list[dict[str, object]],
    *,
    id_key: str,
    required_keys: tuple[str, ...],
) -> None:
    seen: set[str] = set()
    for index, item in enumerate(examples):
        raw_id = item.get(id_key) or item.get("question_id") or str(index)
        item_id = str(raw_id)
        if item_id in seen:
            raise ValueError(f"duplicate standard benchmark scenario id: {item_id}")
        seen.add(item_id)
        for key in required_keys:
            if key not in item or item[key] is None or item[key] == "":
                raise ValueError(f"scenario {item_id} missing required key {key!r}")
        metadata = item.get("metadata")
        if isinstance(metadata, dict) and metadata.get("edge_scenario"):
            if "base_scenario_id" not in metadata:
                raise ValueError(f"edge scenario {item_id} missing base_scenario_id")


def count_dict_examples(
    base_examples: list[dict[str, object]],
    examples: list[dict[str, object]],
) -> dict[str, int]:
    edge = sum(
        1
        for item in examples
        if isinstance(item.get("metadata"), dict)
        and bool(item["metadata"].get("edge_scenario"))  # type: ignore[index]
    )
    return {"base": len(base_examples), "edge": edge, "total": len(examples)}
