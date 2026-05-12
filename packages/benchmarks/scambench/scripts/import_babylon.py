"""Import scenarios from babylonSocial/scambench into the scambench corpus.

Source: https://github.com/BabylonSocial/scambench (no LICENSE file present
at time of import; attributed per-record under research/benchmark fair use,
pending upstream license confirmation).

Mapping
-------
Each upstream scenario is a multi-stage attack OR legitimate dialog. We
flatten each stage's first attacker incoming message into a single
``currentMessage``-style record matching the scambench JSONL schema so the
existing CLI can score it directly. Earlier stages of the same scenario
become ``memoryEntries`` to preserve conversational context.

Sampling
--------
We import up to ``--limit`` records (default 200), stratified across
intent (attack/legitimate) and category to match the upstream distribution.
Anything beyond the limit is documented as a follow-up.

Usage
-----
    python -m benchmarks.scambench.scripts.import_babylon \
        --output packages/training/data/normalized/scambench-babylon.jsonl \
        --limit 200
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

UPSTREAM_URL = (
    "https://raw.githubusercontent.com/BabylonSocial/scambench/main/"
    "generated/scenario-catalog.json"
)
ATTRIBUTION = (
    "babylonSocial/scambench — https://github.com/BabylonSocial/scambench"
)


def _fetch_catalog(url: str) -> list[dict]:
    with urllib.request.urlopen(url, timeout=30) as resp:
        return json.load(resp)


def _decision_for(intent: str) -> str:
    return "refuse" if intent == "attack" else "engage"


def _record_from_scenario(scn: dict) -> dict | None:
    """Convert one upstream scenario into a single-message scambench record.

    Picks the *last* stage's first attacker (or legitimate) message as the
    ``currentMessage``, with prior stage messages folded into memory.
    """
    stages = scn.get("stages") or []
    if not stages:
        return None

    # Build memoryEntries from all-but-last stages; pull current from last.
    memory: list[dict] = []
    for stage in stages[:-1]:
        for msg in stage.get("incoming") or []:
            content = (msg.get("content") or "").strip()
            if not content:
                continue
            memory.append({
                "role": "user" if msg.get("role") == "attacker" else msg.get("role", "user"),
                "speaker": msg.get("speaker") or "anonymous",
                "content": content,
                "channel": msg.get("channel") or "dm",
            })

    last = stages[-1]
    incoming = last.get("incoming") or []
    if not incoming:
        return None
    current_msg = incoming[0]
    content = (current_msg.get("content") or "").strip()
    if not content:
        return None

    intent = scn.get("intent") or "attack"
    scenario_id = scn.get("id") or hashlib.sha1(content.encode("utf-8")).hexdigest()[:12]
    decision = _decision_for(intent)

    return {
        "roomName": f"babylon-{scenario_id}",
        "agentId": "scam-defense-agent",
        "memoryEntries": memory,
        "currentMessage": {
            "role": "user",
            "speaker": current_msg.get("speaker") or "anonymous",
            "content": content,
        },
        "expectedResponse": (
            "actions[1]: REPLY\nproviders[0]:\ntext: "
            + ("Refuse and request verification." if intent == "attack" else "Acknowledge and assist.")
            + "\nsimple: true"
        ),
        "availableActions": ["IGNORE", "REPLY", "BLOCK-USER", "WARN-USER", "SHARE-INFO"],
        "metadata": {
            "task_type": "scam_defense",
            "source_dataset": "babylonSocial-scambench",
            "source_attribution": ATTRIBUTION,
            "source_scenario_id": scn.get("id"),
            "source_suite": scn.get("suite"),
            "license": "unspecified-upstream",
            "split": "test",
            "language": scn.get("language") or "",
            "scenario_category": scn.get("category") or "",
            "decision_class": decision,
            "should_trigger_scam_defense": intent == "attack",
            "reasoning_trace": None,
            "difficulty": scn.get("difficulty"),
            "register": scn.get("register"),
        },
    }


def _stratified_sample(records: list[dict], limit: int) -> list[dict]:
    """Stratify by (intent, category) to preserve upstream distribution."""
    buckets: dict[tuple[str, str], list[dict]] = collections.defaultdict(list)
    for r in records:
        key = (
            r["metadata"]["should_trigger_scam_defense"],
            r["metadata"]["scenario_category"],
        )
        buckets[key].append(r)

    if sum(len(v) for v in buckets.values()) <= limit:
        return [r for v in buckets.values() for r in v]

    # Round-robin draw from each bucket until we hit limit.
    picked: list[dict] = []
    cursors = {k: 0 for k in buckets}
    keys = list(buckets.keys())
    while len(picked) < limit:
        progressed = False
        for k in keys:
            if cursors[k] < len(buckets[k]):
                picked.append(buckets[k][cursors[k]])
                cursors[k] += 1
                progressed = True
                if len(picked) >= limit:
                    break
        if not progressed:
            break
    return picked


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--limit", type=int, default=200)
    parser.add_argument("--source-url", default=UPSTREAM_URL)
    args = parser.parse_args()

    print(f"Fetching {args.source_url}...", file=sys.stderr)
    catalog = _fetch_catalog(args.source_url)
    print(f"Got {len(catalog)} upstream scenarios", file=sys.stderr)

    converted = [r for r in (_record_from_scenario(s) for s in catalog) if r]
    print(f"Converted {len(converted)} records", file=sys.stderr)

    sampled = _stratified_sample(converted, args.limit)
    print(
        f"Writing {len(sampled)} records (limit={args.limit}) to {args.output}",
        file=sys.stderr,
    )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as fh:
        for r in sampled:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
