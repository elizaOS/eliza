"""Normalize non-canonical fact_extractor op names to the runtime vocabulary.

gpt-oss-120b consistently emits `op: insert` or `op: add` instead of the
canonical `add_durable` / `add_current` pair, despite the prompt
forbidding it. Roughly 30 % of fact_extractor records are affected.

Mapping:
- `op: insert` + `category: durable.*`  → `op: add_durable`
- `op: insert` + `category: current.*`  → `op: add_current`
- `op: insert` + ambiguous category     → infer durable for stable
                                          identity-like categories,
                                          current for state-like
- `op: add`     same rules as `op: insert`
- `op: update`  same rules as `op: insert`
- Wrapper shape `{"insert": {...}}` (no `op` key) → unwrap and apply
  the rules above

Records the script can't reconcile (truly unknown shape) are dropped
unless ``--keep-unparseable`` is passed.

Usage::

    python scripts/transform_normalize_fact_ops.py \
        --input  data/synthesized/evaluators/fact_extractor.jsonl \
        --output data/synthesized/evaluators/fact_extractor.jsonl
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("normalize-fact-ops")


CANONICAL_OPS = {"add_durable", "add_current", "strengthen", "decay", "contradict"}
INSERT_LIKE = {"insert", "add", "update"}

# Categories the model commonly invents that aren't prefixed `durable.` /
# `current.`. These heuristics mirror the runtime taxonomy in
# eliza/packages/core/src/runtime/fact-types.ts.
DURABLE_HINTS = {
    "allergy", "diet", "identity", "hometown", "career", "family",
    "education", "founding", "hobby", "preference", "relationship",
    "personal.project", "personal", "team.size", "team.composition",
}
CURRENT_HINTS = {
    "feeling", "task", "activity", "mood", "today", "current",
    "meetings", "meeting", "blocker",
}


def _category_to_kind(category: str | None) -> str | None:
    if not isinstance(category, str):
        return None
    if category.startswith("durable."):
        return "add_durable"
    if category.startswith("current."):
        return "add_current"
    head = category.split(".", 1)[0].lower()
    if head in DURABLE_HINTS or category in DURABLE_HINTS:
        return "add_durable"
    if head in CURRENT_HINTS:
        return "add_current"
    return None


def _normalize_op(op: dict) -> dict | None:
    """Return a normalized op or None if it's truly unsalvageable."""
    if not isinstance(op, dict):
        return None

    # Wrapper shape: {"insert": {...}} or {"add": {...}}
    for wrapper in INSERT_LIKE:
        if wrapper in op and "op" not in op and isinstance(op[wrapper], dict):
            inner = dict(op[wrapper])
            inner["op"] = wrapper
            return _normalize_op(inner)

    # `type: insert` (some teachers use `type` instead of `op`)
    if "type" in op and "op" not in op:
        op = {**op, "op": op["type"]}

    raw = op.get("op")
    if raw in CANONICAL_OPS:
        return op
    if raw in INSERT_LIKE:
        # Some teachers nest the actual claim inside `fact: {...}`. Hoist.
        if "fact" in op and isinstance(op["fact"], dict) and "category" not in op:
            inner = dict(op["fact"])
            inner["op"] = raw
            for k, v in op.items():
                if k not in ("op", "fact"):
                    inner.setdefault(k, v)
            op = inner
        kind = _category_to_kind(op.get("category"))
        if kind is None:
            return None
        out = {"op": kind}
        for k in ("category", "claim", "factId", "since", "validAt", "value", "proposedText"):
            if k in op and op[k] is not None:
                out[k] = op[k]
        # Allow naked `value: x` to survive as the claim if claim missing.
        if "claim" not in out and "value" in op:
            out["claim"] = op["value"]
        return out
    return None


def normalize_record(rec: dict) -> dict | None:
    er = rec.get("expectedResponse")
    if not isinstance(er, str):
        return None
    try:
        payload = json.loads(er)
    except json.JSONDecodeError:
        return None
    ops = payload.get("ops")
    if not isinstance(ops, list):
        return None
    new_ops: list[dict] = []
    for op in ops:
        norm = _normalize_op(op)
        if norm is None:
            return None  # one bad op poisons the record
        new_ops.append(norm)
    payload["ops"] = new_ops
    rec["expectedResponse"] = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    rec.setdefault("metadata", {})["fact_op_normalized"] = True
    return rec


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--input", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    args = p.parse_args()

    if not args.input.exists():
        log.error("input not found: %s", args.input)
        return 2

    in_place = args.input.resolve() == args.output.resolve()
    tmp = args.output.with_suffix(args.output.suffix + ".tmp") if in_place else args.output

    n_total = n_already = n_normalized = n_dropped = 0
    with args.input.open("r", encoding="utf-8") as fin, \
         tmp.open("w", encoding="utf-8") as fout:
        for line in fin:
            line = line.rstrip("\n")
            if not line:
                continue
            n_total += 1
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                n_dropped += 1
                continue

            er = rec.get("expectedResponse")
            try:
                payload = json.loads(er) if isinstance(er, str) else None
            except json.JSONDecodeError:
                n_dropped += 1
                continue
            if not isinstance(payload, dict) or not isinstance(payload.get("ops"), list):
                n_dropped += 1
                continue

            ops = payload["ops"]
            if all(
                isinstance(op, dict) and op.get("op") in CANONICAL_OPS
                for op in ops
            ):
                fout.write(line + "\n")
                n_already += 1
                continue

            normalized = normalize_record(dict(rec))
            if normalized is None:
                n_dropped += 1
                continue
            fout.write(json.dumps(normalized, ensure_ascii=False) + "\n")
            n_normalized += 1

    if in_place:
        os.replace(tmp, args.output)

    log.info(
        "in=%s out=%s total=%d already=%d normalized=%d dropped=%d",
        args.input, args.output, n_total, n_already, n_normalized, n_dropped,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
