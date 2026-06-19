"""Build a scenarios.jsonl from existing pre-synthesized records + lifeops.

Source: data/synthesized/{should_respond_routing,dialogue_routing,
                          action_pairs/*,...}/*.jsonl
Each record already has roomName/agentId/memoryEntries/currentMessage.
We re-emit it as a `scenario` line for `drive_eliza.py`.

Output: scripts/synth/scenarios/all.jsonl (1 scenario per line)
"""
from __future__ import annotations

import argparse
import json
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SYNTH = ROOT / "data" / "synthesized"
OUT = Path(__file__).resolve().parent / "scenarios"


def to_scenario(rec: dict, source: str) -> dict | None:
    cm = rec.get("currentMessage") or {}
    text = cm.get("content") or ""
    if not text:
        return None
    md = rec.get("metadata") or {}
    task_id = md.get("task_type", "scenario") + ":" + str(uuid.uuid4())
    return {
        "task_id": task_id,
        "benchmark": f"synth-{source}",
        "user_text": text,
        "context": {
            "channel": cm.get("channel", "dm"),
            "available_actions": rec.get("availableActions") or [
                "REPLY", "IGNORE",
            ],
            "memory": [
                {"role": m.get("role", "user"), "content": m.get("content", "")}
                for m in (rec.get("memoryEntries") or [])
            ][:20],
            "roomName": rec.get("roomName"),
            "agentId": rec.get("agentId", "agent"),
        },
    }


def harvest(path: Path, source: str, max_per: int) -> list[dict]:
    out = []
    with path.open() as f:
        for i, line in enumerate(f):
            if max_per and i >= max_per:
                break
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            sc = to_scenario(r, source)
            if sc:
                out.append(sc)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-per-source", type=int, default=5_000)
    ap.add_argument("--out", type=Path, default=OUT / "all.jsonl")
    args = ap.parse_args()

    sources: list[tuple[Path, str]] = []
    # Curated set of synthesized files that already match scenario shape
    for fname, src in [
        ("should_respond_routing.jsonl", "should_respond"),
        ("dialogue_routing.jsonl", "dialogue_routing"),
        ("multiparty_should_respond.jsonl", "multiparty"),
        ("action_planner_coverage.jsonl", "action_planner"),
        ("action_pairs/lifeops.jsonl", "lifeops"),
        ("action_pairs/lifeops_ea.jsonl", "lifeops_ea"),
    ]:
        p = SYNTH / fname
        if p.exists():
            sources.append((p, src))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    n_total = 0
    with args.out.open("w") as out_f:
        for path, src in sources:
            scenarios = harvest(path, src, args.max_per_source)
            print(f"  {src}: {len(scenarios):,} scenarios from {path.name}")
            for sc in scenarios:
                out_f.write(json.dumps(sc, ensure_ascii=False) + "\n")
                n_total += 1

    print(f"\nDONE — {n_total:,} scenarios written to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
