#!/usr/bin/env python3
"""Patch data/prompts/registry.json to fix TOON instruction gaps.

For each TOON-output entry that's missing the "no other formats" guardrail
or an example block, append a minimal correction so the rendered
metadata.system_prompt in training records carries clean instructions.

Run after audit_toon_instructions.py. Output: registry.patched.json.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "data" / "prompts" / "registry.json"
OUT = ROOT / "data" / "prompts" / "registry.patched.json"

GUARDRAIL_BLOCK = (
    "\n\nIMPORTANT: Output exactly one TOON document. No JSON, no XML, no "
    "markdown fences, no <think> tags, no prose before or after the document."
)
ONLY_DIRECTIVE = (
    "\n\nReturn TOON only. Your response must contain only the TOON document."
)


def needs_no_other_formats(template: str) -> bool:
    return not re.search(
        r"no\s+(?:JSON|XML|markdown|fences?|<think>|prose)|"
        r"do\s+not\s+include\s+(?:any\s+text|thinking|reasoning)",
        template, re.IGNORECASE,
    )


def needs_only_directive(template: str) -> bool:
    return not re.search(
        r"(?:must\s+ONLY|exactly\s+one\s+TOON|return\s+only|TOON\s+only|"
        r"only\s+contain\s+the\s+TOON)",
        template, re.IGNORECASE,
    )


def needs_example(template: str, keys: list[str]) -> bool:
    return not re.search(r"(?:example|Example|format:)", template, re.IGNORECASE) \
        and bool(keys)


def synth_example(keys: list[str]) -> str:
    """Synthesize a minimal TOON example from expected_keys."""
    lines = ["", "Example:"]
    for k in keys[:6]:
        lines.append(f"{k}: <value>")
    return "\n".join(lines) + "\n"


def patch_entry(entry: dict, stats: dict) -> dict:
    if entry.get("output_format") != "toon":
        return entry
    template = entry.get("template", "")
    keys = entry.get("expected_keys", [])
    appended = []
    if needs_no_other_formats(template):
        template = template.rstrip() + GUARDRAIL_BLOCK
        appended.append("no_other_formats")
    if needs_only_directive(template):
        template = template.rstrip() + ONLY_DIRECTIVE
        appended.append("only_directive")
    if needs_example(template, keys):
        template = template.rstrip() + synth_example(keys)
        appended.append("example_block")
    if appended:
        entry["template"] = template
        stats[entry["task_id"]] = appended
    return entry


def main() -> int:
    reg = json.loads(REGISTRY.read_text())
    stats: dict = {}
    reg["entries"] = [patch_entry(e, stats) for e in reg.get("entries", [])]
    OUT.write_text(json.dumps(reg, indent=2))
    print(f"Patched {len(stats)} entries:")
    for tid, fixes in stats.items():
        print(f"  {tid}: {fixes}")
    print(f"Wrote {OUT}")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
