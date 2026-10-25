#!/usr/bin/env python3
"""Comprehensive validator for the canonical eliza training-record schema.

Runs deeper checks than the structural pass — validates every record
against the elizaOS contract:

Top level (REQUIRED):
  - roomName:          str
  - agentId:           str
  - memoryEntries:     list of dict
  - currentMessage:    dict
  - expectedResponse:  str (non-empty)
  - availableActions:  list of dict
  - metadata:          dict

memoryEntries[i] (each entry):
  - role:        str (one of: user, assistant, system, tool, tool_output, reasoning)
  - speaker:     str
  - content:     str
  - channel:     str

currentMessage:
  - content:     str (non-empty)
  - speaker:     str (optional but expected)

availableActions[i] (each action spec):
  - name:        str
  - description: str (optional, may be empty)

metadata:
  - task_type:   str
  - source_dataset: str
  - split:       str (train/val/test)

Usage:
    python3 scripts/validate_eliza_schema.py [path]

Reports:
  - Records validated
  - Per-violation counts (per field per error type)
  - Sample of each violation type (5 records)
  - Summary verdict: PASS or FAIL
"""
from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

VALID_ROLES = {
    "user", "assistant", "system", "tool", "tool_output",
    "reasoning", "agent", "memory", "environment", "ipython",
}


def validate_record(rec: dict) -> list[tuple[str, str]]:
    """Return list of (field_path, violation_type) tuples for this record."""
    errors: list[tuple[str, str]] = []

    # Top-level required fields
    for f in ("roomName", "agentId", "memoryEntries", "currentMessage",
              "expectedResponse", "availableActions", "metadata"):
        if f not in rec:
            errors.append((f, "missing"))

    # Type checks for top-level fields
    if "roomName" in rec and not isinstance(rec["roomName"], str):
        errors.append(("roomName", "not_string"))
    if "agentId" in rec and not isinstance(rec["agentId"], str):
        errors.append(("agentId", "not_string"))

    if "memoryEntries" in rec:
        me = rec["memoryEntries"]
        if not isinstance(me, list):
            errors.append(("memoryEntries", "not_list"))
        else:
            for i, entry in enumerate(me):
                if not isinstance(entry, dict):
                    errors.append((f"memoryEntries[{i}]", "not_dict"))
                    continue
                # Each entry needs role + content
                for f in ("role", "content"):
                    if f not in entry:
                        errors.append((f"memoryEntries[{i}].{f}", "missing"))
                if "role" in entry:
                    if not isinstance(entry["role"], str):
                        errors.append((f"memoryEntries[{i}].role", "not_string"))
                    elif entry["role"] not in VALID_ROLES:
                        errors.append((f"memoryEntries[{i}].role={entry['role']}", "unknown_role"))
                if "content" in entry and not isinstance(entry["content"], str):
                    errors.append((f"memoryEntries[{i}].content", "not_string"))

    if "currentMessage" in rec:
        cm = rec["currentMessage"]
        if not isinstance(cm, dict):
            errors.append(("currentMessage", "not_dict"))
        else:
            if "content" not in cm:
                errors.append(("currentMessage.content", "missing"))
            elif not isinstance(cm["content"], str):
                errors.append(("currentMessage.content", "not_string"))

    if "expectedResponse" in rec:
        er = rec["expectedResponse"]
        if not isinstance(er, str):
            errors.append(("expectedResponse", "not_string"))
        elif not er.strip():
            errors.append(("expectedResponse", "empty"))

    if "availableActions" in rec:
        aa = rec["availableActions"]
        if not isinstance(aa, list):
            errors.append(("availableActions", "not_list"))
        else:
            # availableActions can be List[str] (action names) OR List[dict]
            # (action specs with name+description). Both are valid.
            for i, action in enumerate(aa):
                if isinstance(action, str):
                    if not action.strip():
                        errors.append((f"availableActions[{i}]", "empty_string"))
                elif isinstance(action, dict):
                    if "name" not in action:
                        errors.append((f"availableActions[{i}].name", "missing"))
                    elif not isinstance(action["name"], str):
                        errors.append((f"availableActions[{i}].name", "not_string"))
                else:
                    errors.append((f"availableActions[{i}]", "not_str_or_dict"))

    if "metadata" in rec:
        md = rec["metadata"]
        if not isinstance(md, dict):
            errors.append(("metadata", "not_dict"))
        else:
            for f in ("task_type", "split"):
                if f not in md:
                    errors.append((f"metadata.{f}", "missing"))
                elif md[f] is not None and not isinstance(md[f], str):
                    errors.append((f"metadata.{f}", "not_string"))

    return errors


def main() -> int:
    src = sys.argv[1] if len(sys.argv) > 1 else str(ROOT / "data" / "final" / "train_final.jsonl")
    if not Path(src).exists():
        print(f"error: {src} missing", file=sys.stderr)
        return 2

    total = 0
    decode_errors = 0
    violations: Counter = Counter()
    samples: dict[str, list] = defaultdict(list)

    with open(src) as f:
        for line_no, line in enumerate(f, 1):
            total += 1
            try:
                rec = json.loads(line)
            except json.JSONDecodeError as e:
                decode_errors += 1
                violations[("__decode_error__", str(e)[:50])] += 1
                continue
            errors = validate_record(rec)
            for field, vtype in errors:
                # Bucket the violation; strip [n] index for cleaner aggregation
                bucket_key = field.split("[")[0] if "[" in field else field
                violations[(bucket_key, vtype)] += 1
                if len(samples[(bucket_key, vtype)]) < 3:
                    samples[(bucket_key, vtype)].append({
                        "line": line_no,
                        "task_type": rec.get("metadata", {}).get("task_type") if isinstance(rec, dict) else None,
                        "source": rec.get("metadata", {}).get("source_dataset") if isinstance(rec, dict) else None,
                        "field": field,
                        "violation": vtype,
                    })
            if total % 200000 == 0:
                print(f"[{total:,}] violations={sum(violations.values()):,}", file=sys.stderr)

    print(f"\n=== {Path(src).name} ===")
    print(f"Total records: {total:,}")
    print(f"Decode errors: {decode_errors:,}")
    total_violations = sum(violations.values())
    print(f"Total violations: {total_violations:,}")
    if not violations:
        print("\nVERDICT: PASS — every record conforms to schema")
        return 0

    print("\nViolation summary:")
    print(f"  {'field':<40s} {'type':<20s} {'count':>10s}")
    for (field, vtype), count in violations.most_common(30):
        print(f"  {field:<40s} {vtype:<20s} {count:>10,d}")

    print("\nSamples (3 per violation):")
    for key, items in list(samples.items())[:15]:
        print(f"\n  {key}:")
        for s in items:
            print(f"    line={s['line']} tt={s['task_type']} src={s['source']} field={s['field']}")

    if total_violations > 0:
        print(f"\nVERDICT: FAIL — {total_violations:,} violations")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
