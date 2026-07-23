"""Structural validation shared by the standard benchmark adapters."""

from __future__ import annotations

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


def count_dict_examples(examples: list[dict[str, object]]) -> dict[str, int]:
    return {"total": len(examples)}
