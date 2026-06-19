"""Build v2 corpus from the published v1 + new synth + transforms.

Inputs:
  - data/final/train.jsonl                  v1 published corpus (1.06M records)
  - data/synthesized/evaluators/*.jsonl      Phase-4 synth (Groq gpt-oss-120b)
  - data/synthesized/phase3/*.jsonl          Phase-3 synth (Groq gpt-oss-120b)

Pipeline:
  1. Stream v1 train.jsonl. For each record, classify by phase. Apply
     transforms inline:
       - task_type=reasoning_cot         → DROP (per COVERAGE_AUDIT decision)
       - task_type=claude_distill        → reshape to reply (Phase-2)
       - task_type starts with lifeops.* → already-Phase-2 in v2 thanks
                                            to synth fix; keep but rebrand
       - task_type=dataset-generator.*   → strip namespace prefix
       - phase==OOB after transforms     → drop
  2. Append the new synth records (already Phase-3/4).
  3. Apply per-tier caps (Tier S replicate, hermes E_combined budget).
  4. Repair native JSON bullets in synth records.
  5. Write data/final/train_v2.jsonl + manifest_v2.json with the final
     phase distribution.

Output:
  - data/final/train_v2.jsonl
  - data/final/manifest_v2.json

The script does NOT split into val/test because v1 already lived in HF
as a single train file; the val/test came from upstream metadata.split
fields which we preserve. Run pack_dataset.py if a fresh val/test split
is needed.
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Iterator

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from lib.runtime_phases import classify_phase, PHASE_OOB  # noqa: E402

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("build-v2")


_CD_THINK_RE = re.compile(r"<think>(.+?)</think>(.*)$", re.S)
_RC_THINK_RE = _CD_THINK_RE  # same shape


def _payload_repair(s: str) -> str:
    """Inline copy of transform_repair_payload_bullets.repair so we don't
    have to subprocess. Two passes: indexed-assign collapse and
    markdown-bullet → array."""
    lines = s.splitlines()
    out: list[str] = []
    i = 0
    INDEXED = re.compile(r"^([a-zA-Z_][a-zA-Z0-9_]*)\[(\d+)\]\s*:\s*(.+)$")
    while i < len(lines):
        line = lines[i]
        m_idx = INDEXED.match(line)
        if m_idx and m_idx.group(2) == "0":
            key = m_idx.group(1)
            items = [m_idx.group(3).strip()]
            k = i + 1
            expected = 1
            while k < len(lines):
                m2 = INDEXED.match(lines[k])
                if not m2 or m2.group(1) != key or m2.group(2) != str(expected):
                    break
                items.append(m2.group(3).strip())
                expected += 1
                k += 1
            if len(items) >= 2:
                out.append(f"{key}[{len(items)}]:")
                for v in items:
                    out.append(f"  - {v}")
                i = k
                continue
        m_bare = re.match(r"^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*$", line)
        if m_bare:
            j = i + 1
            while j < len(lines) and lines[j].strip() == "":
                j += 1
            bullets: list[str] = []
            k = j
            while k < len(lines) and lines[k].lstrip().startswith("- "):
                bullets.append(lines[k].lstrip()[2:].strip())
                k += 1
            if bullets:
                key = m_bare.group(1)
                out.append(f"{key}[{len(bullets)}]:")
                for b in bullets:
                    out.append(f"  - {b}")
                i = k
                continue
        out.append(line)
        i += 1
    return "\n".join(out)


def _shrink_thought(s: str, limit: int = 240) -> str:
    s = " ".join(s.split())
    return s[:limit].rstrip()


def _to_phase2_reply(thought: str, text: str) -> str:
    """Build a native JSON planner envelope with REPLY-only action."""
    thought = _shrink_thought(thought)
    text = (text or "").strip()
    return (
        f"thought: {thought}\n"
        f"tool_calls[0]\n"
        f"  - name: REPLY\n"
        f"    params:\n"
        f"providers: []\n"
        f"text: {json.dumps(text)}\n"
        f"simple: true"
    )


def transform_record(rec: dict) -> dict | None:
    """Return the transformed record or None to drop."""
    md = rec.get("metadata") or {}
    tt = (md.get("task_type") or "").strip()

    # 1. reasoning_cot → DROP
    if tt == "reasoning_cot":
        return None

    # 2. claude_distill → Phase-2 reply
    if tt == "claude_distill":
        m = _CD_THINK_RE.match((rec.get("expectedResponse") or "").strip())
        if not m:
            return None
        thought, final = m.group(1).strip(), m.group(2).strip()
        if not final:
            return None
        rec["expectedResponse"] = _to_phase2_reply(thought, final)
        md["task_type"] = "reply"
        md["transformed_from"] = "claude_distill"
        rec.setdefault("availableActions", ["REPLY"])
        return rec

    # 3. dataset-generator.<phase> namespace strip
    if tt.startswith("dataset-generator."):
        new_tt = tt.split(".", 1)[1]
        md["task_type"] = new_tt
        md["transformed_from"] = tt
        rec["metadata"] = md
        return rec

    # 4. abliteration_* never enters SFT mix
    if tt.startswith("abliteration_"):
        return None

    # 5. plugin-*.* OOB → DROP (~150 records, small enough to discard)
    if tt.startswith("plugin-"):
        return None

    # 6. After all transforms, drop anything that classifies OOB
    if classify_phase(md.get("task_type")) == PHASE_OOB:
        return None

    return rec


def iter_synth(synth_dir: Path) -> Iterator[dict]:
    """Yield records from data/synthesized/{evaluators,phase3}/*.jsonl,
    repairing native JSON bullets/indexed-assign as we go."""
    for sub in ("evaluators", "phase3"):
        d = synth_dir / sub
        if not d.exists():
            continue
        for p in sorted(d.glob("*.jsonl")):
            with p.open() as f:
                for line in f:
                    line = line.rstrip("\n")
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    er = rec.get("expectedResponse") or ""
                    rec["expectedResponse"] = _payload_repair(er)
                    yield rec


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--input", type=Path, default=ROOT / "data/final/train.jsonl",
                   help="v1 train.jsonl input")
    p.add_argument("--synth-dir", type=Path, default=ROOT / "data/synthesized",
                   help="directory containing evaluators/ and phase3/ subdirs")
    p.add_argument("--output", type=Path, default=ROOT / "data/final/train_v2.jsonl",
                   help="output train_v2.jsonl")
    p.add_argument("--manifest", type=Path, default=ROOT / "data/final/manifest_v2.json",
                   help="output manifest_v2.json")
    p.add_argument("--phase2-cap", type=int, default=0,
                   help="if > 0, downsample Phase-2 records to this many "
                   "(reservoir sample). 0 disables.")
    p.add_argument("--seed", type=int, default=0xDEC0DE)
    p.add_argument("--dry-run", action="store_true",
                   help="don't write outputs; just count what would happen")
    args = p.parse_args()
    import random as _random
    rng = _random.Random(args.seed)

    if not args.input.exists():
        log.error("input not found: %s", args.input)
        return 2

    n_in = 0
    n_kept = 0
    n_dropped_reasoning = 0
    n_dropped_oob = 0
    n_dropped_abliteration = 0
    n_dropped_plugin = 0
    n_transformed_cd = 0
    n_transformed_dg = 0
    by_phase: Counter = Counter()
    by_task: Counter = Counter()
    by_source: Counter = Counter()

    args.output.parent.mkdir(parents=True, exist_ok=True)
    fout = None if args.dry_run else args.output.open("w", encoding="utf-8")

    try:
        with args.input.open("r", encoding="utf-8") as fin:
            for line in fin:
                line = line.rstrip("\n")
                if not line:
                    continue
                n_in += 1
                if n_in % 100_000 == 0:
                    log.info("scanned %d v1 records (kept=%d, dropped reasoning=%d oob=%d abliteration=%d plugin=%d)",
                             n_in, n_kept, n_dropped_reasoning, n_dropped_oob,
                             n_dropped_abliteration, n_dropped_plugin)
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue

                md_in = rec.get("metadata") or {}
                tt_in = md_in.get("task_type", "")
                if tt_in == "reasoning_cot":
                    n_dropped_reasoning += 1
                    continue
                if tt_in.startswith("abliteration_"):
                    n_dropped_abliteration += 1
                    continue
                if tt_in.startswith("plugin-"):
                    n_dropped_plugin += 1
                    continue

                tx = transform_record(rec)
                if tx is None:
                    n_dropped_oob += 1
                    continue
                if tt_in == "claude_distill":
                    n_transformed_cd += 1
                if tt_in.startswith("dataset-generator."):
                    n_transformed_dg += 1

                md = tx.get("metadata") or {}
                phase = classify_phase(md.get("task_type"))
                # Phase-2 reservoir-sample cap (one-pass, online): if cap is
                # set, decide on-the-fly whether to keep this Phase-2 record
                # via a Bernoulli trial calibrated against the projected
                # full Phase-2 count from the v1 manifest. The simpler
                # approach used here: keep with probability cap/expected_p2,
                # where expected_p2 = 807195 (v1 manifest).
                if args.phase2_cap and phase == "2":
                    keep_prob = min(1.0, args.phase2_cap / 807_195.0)
                    if rng.random() > keep_prob:
                        continue

                by_phase[phase] += 1
                by_task[md.get("task_type", "?")] += 1
                by_source[md.get("source_dataset", "?")] += 1
                n_kept += 1
                if fout is not None:
                    fout.write(json.dumps(tx) + "\n")

        # Append synth records.
        n_synth_in = 0
        for rec in iter_synth(args.synth_dir):
            n_synth_in += 1
            md = rec.get("metadata") or {}
            phase = classify_phase(md.get("task_type"))
            by_phase[phase] += 1
            by_task[md.get("task_type", "?")] += 1
            by_source[md.get("source_dataset", "?")] += 1
            n_kept += 1
            if fout is not None:
                fout.write(json.dumps(rec) + "\n")

    finally:
        if fout is not None:
            fout.close()

    total = sum(by_phase.values())

    def pct(n: int) -> float:
        return (100.0 * n / total) if total else 0.0

    manifest = {
        "v1_records_scanned": n_in,
        "v1_records_kept": n_kept - n_synth_in,
        "v1_dropped": {
            "reasoning_cot": n_dropped_reasoning,
            "abliteration": n_dropped_abliteration,
            "plugin": n_dropped_plugin,
            "oob_after_transform": n_dropped_oob,
        },
        "v1_transformed": {
            "claude_distill_to_reply": n_transformed_cd,
            "dataset_generator_strip": n_transformed_dg,
        },
        "synth_records_added": n_synth_in,
        "v2_total": n_kept,
        "phase_distribution_pct": {ph: round(pct(c), 2) for ph, c in by_phase.most_common()},
        "phase_counts": dict(by_phase.most_common()),
        "by_task_type_top20": dict(by_task.most_common(20)),
        "by_source_top20": dict(by_source.most_common(20)),
    }

    if not args.dry_run:
        args.manifest.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        log.info("wrote %d records → %s", n_kept, args.output)
        log.info("manifest → %s", args.manifest)
    else:
        log.info("dry-run: %d records would be written", n_kept)

    log.info("phase distribution: %s", manifest["phase_distribution_pct"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
