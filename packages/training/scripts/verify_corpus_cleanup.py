"""Sanity scan after the corpus cleanup pass.

Compares train.jsonl (original) vs train_cleaned.jsonl on these checks:
- count of records with `<|endoftext|>` in expectedResponse
- count of records with `<tool_call>` inside a TOON `text` field that ALSO
  has structured actions/tool_calls siblings
- count of carnice-glm5-hermes records still starting with the workspace
  rules header
- count of phi3-mcp records still starting with the boilerplate
- count of hermes-3 records still starting with BEGININPUT
- count of currentMessage.content tool-result patterns

Prints a side-by-side before/after table and writes a few sample triples to
the report.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

ORIGINAL = ROOT / "data" / "final" / "train.jsonl"
CLEANED = ROOT / "data" / "final" / "train_cleaned.jsonl"

CARNICE_HEADER_PREFIX = (
    "You are operating inside an isolated disposable workspace that is "
    "already set as the current working directory."
)
PHI3_HEADER_PREFIX = (
    "Analyze the user input and determine if a tool call is needed."
)


def scan(path: Path) -> dict[str, int]:
    counts = {
        "records": 0,
        "endoftext_anywhere": 0,
        "answer_tag_in_er": 0,
        "think_block_in_er": 0,
        "tool_call_in_text": 0,
        "carnice_unsplit": 0,
        "phi3_unsplit": 0,
        "hermes3_unsplit": 0,
        "tool_result_currentMessage": 0,
        "multilight_persona_thoughts": 0,
    }

    with path.open("r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            counts["records"] += 1
            rec = json.loads(line)
            er = rec.get("expectedResponse", "")
            if isinstance(er, str):
                if "<|endoftext|>" in er:
                    counts["endoftext_anywhere"] += 1
                if "<answer>" in er or "</answer>" in er:
                    counts["answer_tag_in_er"] += 1
                if "<think>" in er:
                    counts["think_block_in_er"] += 1
                if "<tool_call>" in er and (
                    "actions[" in er or "tool_calls[" in er
                ):
                    counts["tool_call_in_text"] += 1

            md = rec.get("metadata") or {}
            src = md.get("source_dataset", "")
            cm = rec.get("currentMessage") or {}
            cm_content = cm.get("content", "")
            if not isinstance(cm_content, str):
                cm_content = ""

            if src == "carnice-glm5-hermes" and cm_content.startswith(
                CARNICE_HEADER_PREFIX
            ):
                counts["carnice_unsplit"] += 1
            if src == "phi3-mcp" and cm_content.startswith(PHI3_HEADER_PREFIX):
                counts["phi3_unsplit"] += 1
            if src == "hermes-3" and cm_content.startswith("BEGININPUT"):
                counts["hermes3_unsplit"] += 1
            if cm_content.startswith(
                ("response:", "FUNCTION RESPONSE:", "### Ran Playwright code", "<tool_response>")
            ):
                counts["tool_result_currentMessage"] += 1

            if src == "light-multilight" and isinstance(er, str):
                if re.search(r"thought:\s*\"?As [^\"\n]+ in [^\"\n]+\.", er):
                    counts["multilight_persona_thoughts"] += 1

    return counts


def main() -> int:
    print(f"Scanning {ORIGINAL}...", flush=True)
    before = scan(ORIGINAL)
    print(f"Scanning {CLEANED}...", flush=True)
    after = scan(CLEANED)

    cols = list(before.keys())
    print()
    print(f"{'check':<35} {'before':>10} {'after':>10}  {'delta':>10}")
    print("-" * 70)
    for k in cols:
        b = before[k]
        a = after[k]
        d = a - b
        print(f"{k:<35} {b:>10} {a:>10}  {d:>+10}")

    out = {"before": before, "after": after}
    out_path = ROOT / "data" / "final" / "manifest_cleaned_verification.json"
    out_path.write_text(json.dumps(out, indent=2) + "\n")
    print()
    print(f"Wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
