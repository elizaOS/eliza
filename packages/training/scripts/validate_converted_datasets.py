"""Validate JSONL files against the eliza_native_v1 format.

Usage:
    python validate_converted_datasets.py path/to/file.jsonl [more.jsonl ...]

Prints per-file stats: total, valid, invalid with reasons.
Exits with code 1 if any file has >5% invalid records.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib.native_record import validate_native_record

TROPE_STARTS = (
    "Certainly!",
    "Of course!",
    "Sure!",
    "As an AI",
    "I'm an AI",
    "Great!",
    "Absolutely!",
)
TROPE_CONTAINS = (
    "You are an expert",
    "As an AI language model",
    "I'll help you with",
)

INVALID_THRESHOLD = 0.05


def _has_trope(text: str) -> bool:
    if not text:
        return False
    stripped = text.strip()
    for prefix in TROPE_STARTS:
        if stripped.startswith(prefix):
            return True
    for phrase in TROPE_CONTAINS:
        if phrase in stripped:
            return True
    return False


def _check_tropes(rec: dict) -> str | None:
    response_text = rec.get("response", {}).get("text", "")
    if _has_trope(response_text):
        return "trope in response.text"
    messages = rec.get("request", {}).get("messages", [])
    for msg in messages:
        if isinstance(msg, dict) and msg.get("role") == "assistant":
            if _has_trope(msg.get("content", "")):
                return "trope in assistant message"
    return None


def validate_file(path: Path) -> tuple[int, int, dict[str, int]]:
    total = 0
    valid = 0
    invalid_reasons: dict[str, int] = {}

    with path.open("r", encoding="utf-8") as f:
        for lineno, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            total += 1
            try:
                rec = json.loads(line)
            except json.JSONDecodeError as exc:
                reason = f"json parse error: {exc}"
                invalid_reasons[reason] = invalid_reasons.get(reason, 0) + 1
                continue

            ok, reason = validate_native_record(rec)
            if not ok:
                invalid_reasons[reason] = invalid_reasons.get(reason, 0) + 1
                continue

            trope_reason = _check_tropes(rec)
            if trope_reason:
                invalid_reasons[trope_reason] = invalid_reasons.get(trope_reason, 0) + 1
                continue

            valid += 1

    return total, valid, invalid_reasons


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python validate_converted_datasets.py file.jsonl [file2.jsonl ...]", file=sys.stderr)
        sys.exit(1)

    paths = [Path(p) for p in sys.argv[1:]]
    any_over_threshold = False

    for path in paths:
        if not path.exists():
            print(f"ERROR: {path} does not exist", file=sys.stderr)
            any_over_threshold = True
            continue

        total, valid, invalid_reasons = validate_file(path)
        invalid = total - valid
        invalid_pct = invalid / total if total > 0 else 0.0
        over = invalid_pct > INVALID_THRESHOLD

        status = "FAIL" if over else "OK"
        print(f"\n[{status}] {path}")
        print(f"  total  : {total}")
        print(f"  valid  : {valid}")
        print(f"  invalid: {invalid} ({invalid_pct:.1%})")
        if invalid_reasons:
            print("  reasons:")
            for reason, count in sorted(invalid_reasons.items(), key=lambda x: -x[1]):
                print(f"    {reason}: {count}")

        if over:
            any_over_threshold = True

    sys.exit(1 if any_over_threshold else 0)


if __name__ == "__main__":
    main()
