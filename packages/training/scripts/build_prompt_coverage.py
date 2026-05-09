"""Build PROMPT_COVERAGE.md for the training package.

Samples 1000 records from data/final/train.jsonl (reservoir sample) and reports,
for every entry in registry-v2.json and every action in actions-catalog.json,
the number of corpus records that target it.

Coverage heuristics:
- Prompt: search the record's `currentMessage`, `expectedResponse`, and
  `metadata.task_type` for the prompt's `task_id` or any unique substring of
  the prompt's expected_keys / variables.
- Action: search the record's `expectedResponse` and `availableActions` for
  literal occurrences of the action `name` (with word boundary).
"""

from __future__ import annotations

import json
import random
import re
from collections import Counter
from pathlib import Path
from typing import Any

_TRAINING_ROOT = Path(__file__).parent.parent.resolve()
TRAIN_JSONL = _TRAINING_ROOT / "data" / "final" / "train.jsonl"
REGISTRY_V2 = _TRAINING_ROOT / "data" / "prompts" / "registry-v2.json"
ACTIONS_CATALOG = _TRAINING_ROOT / "data" / "prompts" / "actions-catalog.json"
OUT_PATH = _TRAINING_ROOT / "PROMPT_COVERAGE.md"

SAMPLE_SIZE = 1000


def reservoir_sample(path: Path, k: int, seed: int = 42) -> list[dict[str, Any]]:
    rng = random.Random(seed)
    sample: list[str] = []
    with path.open() as f:
        for i, line in enumerate(f):
            if i < k:
                sample.append(line)
            else:
                j = rng.randint(0, i)
                if j < k:
                    sample[j] = line
    return [json.loads(s) for s in sample]


def _flatten_text(rec: dict[str, Any]) -> str:
    parts: list[str] = []
    cm = rec.get("currentMessage")
    if isinstance(cm, dict):
        for v in cm.values():
            if isinstance(v, str):
                parts.append(v)
    elif isinstance(cm, str):
        parts.append(cm)
    er = rec.get("expectedResponse")
    if isinstance(er, dict):
        parts.append(json.dumps(er))
    elif isinstance(er, str):
        parts.append(er)
    aa = rec.get("availableActions")
    if isinstance(aa, list):
        parts.extend(str(x) for x in aa)
    md = rec.get("metadata") or {}
    if isinstance(md, dict):
        for v in md.values():
            if isinstance(v, str):
                parts.append(v)
    return "\n".join(parts)


def coverage_status(n: int) -> str:
    if n >= 100:
        return "well-covered"
    if n >= 1:
        return "under-covered"
    return "uncovered"


def recommended_action(status: str, kind: str) -> str:
    if status == "well-covered":
        return "extract-from-existing"
    if status == "under-covered":
        return "extract-from-existing"
    # uncovered
    if kind in {"core-prompt", "lifeops-prompt"}:
        return "synthesize"
    if kind == "plugin-prompt":
        return "synthesize"
    if kind == "action":
        return "synthesize"
    return "skip-low-priority"


def main() -> None:
    sample = reservoir_sample(TRAIN_JSONL, SAMPLE_SIZE)
    flat_texts = [_flatten_text(r) for r in sample]
    metas: list[dict[str, Any]] = [r.get("metadata") or {} for r in sample]
    available_actions_per: list[set[str]] = []
    for r in sample:
        aa = r.get("availableActions") or []
        if isinstance(aa, list):
            available_actions_per.append({str(x) for x in aa})
        else:
            available_actions_per.append(set())

    # ---- prompts ----
    registry = json.loads(REGISTRY_V2.read_text())
    prompt_rows: list[dict[str, Any]] = []
    for entry in registry["entries"]:
        task_id = entry["task_id"]
        kind = entry.get("source_kind", "core")
        # Check for direct task_type match (none in current corpus, but cheap)
        n = sum(1 for m in metas if m.get("task_type") == task_id)
        # Check for substring match on task_id in any text
        if n == 0 and len(task_id) >= 4:
            for txt in flat_texts:
                if task_id in txt:
                    n += 1
        kind_label = (
            "core-prompt"
            if kind == "core"
            else (
                "plugin-prompt"
                if kind == "plugin"
                else "lifeops-prompt"
                if kind == "lifeops"
                else "action-inline-prompt"
            )
        )
        status = coverage_status(n)
        prompt_rows.append(
            {
                "id": task_id,
                "type": kind_label,
                "n": n,
                "status": status,
                "rec": recommended_action(status, kind_label),
            }
        )

    # ---- actions ----
    catalog = json.loads(ACTIONS_CATALOG.read_text())
    action_rows: list[dict[str, Any]] = []
    for action in catalog["actions"]:
        name = action["name"]
        plugin = action["plugin"]
        if not name:
            continue
        pattern = re.compile(rf"\b{re.escape(name)}\b")
        n = 0
        for txt, avail in zip(flat_texts, available_actions_per, strict=True):
            if name in avail or pattern.search(txt):
                n += 1
        status = coverage_status(n)
        action_rows.append(
            {
                "id": f"{plugin}::{name}",
                "type": "action",
                "n": n,
                "status": status,
                "rec": recommended_action(status, "action"),
            }
        )

    rows = prompt_rows + action_rows

    # Aggregate stats
    by_status = Counter(r["status"] for r in rows)
    by_type_status = Counter((r["type"], r["status"]) for r in rows)

    out: list[str] = []
    out.append("# Prompt + Action Corpus Coverage Report")
    out.append("")
    out.append(
        "Generated by `scripts/build_prompt_coverage.py`. "
        f"Sampled {SAMPLE_SIZE} records from `data/final/train.jsonl` (reservoir, seed=42)."
    )
    out.append("")
    out.append("## Summary")
    out.append("")
    out.append(
        f"- Total entries scored: **{len(rows)}** "
        f"({len(prompt_rows)} prompts + {len(action_rows)} actions)"
    )
    out.append(f"- well-covered (>=100): **{by_status['well-covered']}**")
    out.append(f"- under-covered (1-99): **{by_status['under-covered']}**")
    out.append(f"- uncovered (0): **{by_status['uncovered']}**")
    out.append("")
    out.append("### Breakdown by entry type")
    out.append("")
    out.append("| type | well-covered | under-covered | uncovered |")
    out.append("|---|---:|---:|---:|")
    for t in [
        "core-prompt",
        "plugin-prompt",
        "lifeops-prompt",
        "action-inline-prompt",
        "action",
    ]:
        wc = by_type_status[(t, "well-covered")]
        uc = by_type_status[(t, "under-covered")]
        un = by_type_status[(t, "uncovered")]
        out.append(f"| {t} | {wc} | {uc} | {un} |")
    out.append("")
    out.append("## Methodology notes")
    out.append("")
    out.append(
        "- The current corpus's `metadata.task_type` is one of `agent_trace`, `tool_call`, "
        "`reasoning_cot`, `shell_command`, `scam_defense`, `mcp_tool_call`, `dialogue_routing`, "
        "or `n8n_workflow_generation`. None of these match prompt `task_id`s directly, so prompt "
        "coverage falls back to substring matching on the record's text payload."
    )
    out.append(
        "- Action coverage matches the action `name` (e.g. `SHELL_COMMAND`, `TRANSFER`) as a "
        "word-boundary regex against the record's `currentMessage`, `expectedResponse`, "
        "`metadata`, and `availableActions`. False positives are possible for short generic "
        "names (e.g. `STATUS`, `APP`)."
    )
    out.append(
        "- `synthesize` is recommended for uncovered entries because the corpus does not yet "
        "carry training data targeting Eliza-native prompts/actions; `extract-from-existing` "
        "for under-covered entries means real records exist that can be mined and re-tagged."
    )
    out.append("")
    out.append("## Coverage table")
    out.append("")
    out.append("| task_id_or_action | type | corpus_records_found | coverage_status | recommended_action |")
    out.append("|---|---|---:|---|---|")
    # Sort: covered rows first (descending count), then uncovered alphabetically.
    status_order = {"well-covered": 0, "under-covered": 1, "uncovered": 2}
    for r in sorted(rows, key=lambda r: (status_order[r["status"]], -r["n"], r["id"])):
        out.append(
            f"| `{r['id']}` | {r['type']} | {r['n']} | {r['status']} | {r['rec']} |"
        )

    OUT_PATH.write_text("\n".join(out) + "\n")
    print(f"wrote {OUT_PATH} ({len(rows)} rows)")


if __name__ == "__main__":
    main()
