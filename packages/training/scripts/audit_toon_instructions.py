#!/usr/bin/env python3
"""Audit data/prompts/registry.json — every TOON-output prompt must declare:

1. Mentions "TOON" by name.
2. Says "TOON only / must ONLY / return only" — no other formats.
3. Forbids JSON/XML/markdown/<think> wrapping.
4. Has an example block.

Findings printed to STDOUT and written to data/prompts/audit_findings.json.
This is read-only — no template mutations.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "data" / "prompts" / "registry.json"
OUT = ROOT / "data" / "prompts" / "audit_findings.json"

CHECKS = {
    "mentions_TOON": re.compile(r"\bTOON\b"),
    "no_other_formats": re.compile(
        r"no\s+(?:JSON|XML|markdown|fences?|<think>|prose)|"
        r"do\s+not\s+include\s+(?:any\s+text|thinking|reasoning)",
        re.IGNORECASE,
    ),
    "has_only_directive": re.compile(
        r"(?:must\s+ONLY|exactly\s+one\s+TOON|return\s+only|TOON\s+only|"
        r"only\s+contain\s+the\s+TOON)",
        re.IGNORECASE,
    ),
    "has_example_block": re.compile(
        r"(?:example|Example|format:|respond using TOON|"
        r"return in TOON|output:|response format)",
        re.IGNORECASE,
    ),
}


def audit_entry(entry: dict) -> dict:
    fmt = entry.get("output_format", "")
    if fmt != "toon":
        return {"task_id": entry["task_id"], "format": fmt, "skip": True}
    template = entry.get("template", "") or ""
    findings = {name: bool(pat.search(template)) for name, pat in CHECKS.items()}
    return {
        "task_id": entry["task_id"],
        "format": fmt,
        "checks": findings,
        "has_examples_field": bool(entry.get("examples")),
        "has_expected_keys": bool(entry.get("expected_keys")),
        "missing": [k for k, v in findings.items() if not v],
        "skip": False,
    }


def main() -> int:
    reg = json.loads(REGISTRY.read_text())
    entries = reg.get("entries", [])
    audited = [audit_entry(e) for e in entries]
    toon_only = [a for a in audited if not a.get("skip")]
    text_only = [a for a in audited if a.get("skip")]

    print("=== TOON instruction audit ===")
    print(f"Total entries: {len(entries)}")
    print(f"  TOON output:  {len(toon_only)}")
    print(f"  text output:  {len(text_only)}")
    print()

    perfect = [a for a in toon_only if not a["missing"]]
    flawed = [a for a in toon_only if a["missing"]]
    print(f"TOON entries fully passing: {len(perfect)}")
    print(f"TOON entries needing attention: {len(flawed)}")
    print()

    if flawed:
        print("--- TOON entries with missing instruction elements ---")
        for a in flawed:
            print(f"  {a['task_id']:>30s}: missing {a['missing']}")
        print()

    findings = {
        "summary": {
            "total": len(entries),
            "toon_format": len(toon_only),
            "text_format": len(text_only),
            "fully_passing": len(perfect),
            "needs_attention": len(flawed),
        },
        "needs_attention": flawed,
        "fully_passing": [a["task_id"] for a in perfect],
        "text_format_skipped": [a["task_id"] for a in text_only],
    }
    OUT.write_text(json.dumps(findings, indent=2))
    print(f"Wrote {OUT}")

    return 0 if not flawed else 1


if __name__ == "__main__":
    import sys
    sys.exit(main())
