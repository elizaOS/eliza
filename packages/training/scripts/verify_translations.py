"""Verify translated corpus output: counts, identifier-mask preservation,
and sample inspection.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "data" / "synthesized" / "translated"

LANGS = ["es", "fr", "de", "pt", "zh", "ja", "ko", "ru"]

ACTION_NAMES = {
    "RESPOND", "IGNORE", "STOP", "REPLY", "TASK_CALL", "USE_SKILL",
    "FUNCTION_CALL", "CALL_TOOL",
}


def first_record(lang: str) -> dict | None:
    p = OUT_DIR / f"{lang}.jsonl"
    if not p.exists() or p.stat().st_size == 0:
        return None
    with p.open() as f:
        line = f.readline()
        if not line.strip():
            return None
        return json.loads(line)


def scan_action_preservation(lang: str, n: int = 200) -> dict:
    """Count occurrences of all-caps action-like tokens that survive translation
    in the expectedResponse + currentMessage surfaces. We sample N records.
    """
    p = OUT_DIR / f"{lang}.jsonl"
    if not p.exists():
        return {"records": 0}

    total = 0
    action_hits = 0
    payload_action_lines = 0
    broken_payload = 0
    with p.open() as f:
        for i, line in enumerate(f):
            if i >= n:
                break
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                broken_payload += 1
                continue
            total += 1
            er = r.get("expectedResponse", "")
            if isinstance(er, str):
                # Count untranslated action tokens
                for tok in ACTION_NAMES:
                    action_hits += len(re.findall(rf"\b{tok}\b", er))
                # Count well-formed native JSON action lines
                payload_action_lines += len(re.findall(
                    r"^action\s*:\s*[A-Z][A-Z_]+\s*$", er, re.MULTILINE
                ))
    return {
        "records": total,
        "action_token_occurrences": action_hits,
        "well_formed_action_lines": payload_action_lines,
        "broken_lines": broken_payload,
    }


def main() -> None:
    print("=" * 60)
    print("Translation verification")
    print("=" * 60)
    for lang in LANGS:
        p = OUT_DIR / f"{lang}.jsonl"
        if not p.exists():
            print(f"\n{lang}: FILE MISSING")
            continue
        n = sum(1 for _ in p.open())
        print(f"\n{lang}: {n} records, {p.stat().st_size:,} bytes")

        r = first_record(lang)
        if r is None:
            print("  (empty)")
            continue
        cm = (r.get("currentMessage") or {}).get("content", "")
        er = r.get("expectedResponse", "")
        md = r.get("metadata") or {}
        print(f"  task_type: {md.get('task_type')}")
        print(f"  translated_to: {md.get('translated_to')}")
        print(f"  source_dataset: {r.get('source_dataset')}")
        print(f"  cm[:140]: {cm[:140]!r}")
        print(f"  er[:140]: {er[:140]!r}")

        stats = scan_action_preservation(lang)
        print(f"  preservation scan (N={stats.get('records')}): "
              f"action tokens preserved={stats.get('action_token_occurrences')}, "
              f"well-formed action: lines={stats.get('well_formed_action_lines')}")


if __name__ == "__main__":
    main()
