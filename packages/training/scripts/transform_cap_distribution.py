#!/usr/bin/env python3
"""Cap per-action and per-source representation in the packed train corpus.

Runs AFTER `pack_dataset.py`. While `pack_dataset.py` applies per-source
*tier* weighting (DATASET_REVIEW.md Tier S/A/B/...), it does not bound
the resulting *action* distribution: `TASK_CALL` alone can dominate the
final mix even after tier caps because Tier B/C tool corpora collapse
into one action. This transform fixes that with three composable gates:

    1. per-source-dataset cap   (default 100,000)
    2. per-primary-action cap   (default 50,000)
    3. non-eliza fraction gate  (default 50% non-eliza after the above)

Eliza-tier sources (Tier S + Tier A from DATASET_REVIEW.md) are never
downsampled by gate (3). Gate (3) downsamples uniformly across non-eliza
sources only.

The transform is deterministic — same seed in, byte-identical output.

Usage:
    uv run python scripts/transform_cap_distribution.py \\
        --input  data/final/train.jsonl \\
        --output data/intermediate/train_capped.jsonl \\
        --config config/corpus_caps.yaml \\
        --report data/synthesized/review/cap_distribution_applied.json \\
        [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import logging
import random
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import yaml

# Source-of-truth: DATASET_REVIEW.md Tier S + Tier A.
# Keep this in sync with `eliza_tier_whitelist` in
# config/corpus_caps.yaml.
ELIZA_TIER_WHITELIST: frozenset[str] = frozenset({
    "nubilio-trajectories",   # Tier S — real eliza coding-agent loop
    "scambench",              # Tier A — real scam-defense scenarios
    "scam-defense-corpus",    # Tier A — augmented v2 trajectories
})

# Action-name extractor for native JSON-encoded `actions:` blocks. Matches the
# first `name: <ACTION>` line under an `actions[N]{...}` header. We do
# not parse the full native JSON here — we just lift the first action name,
# which is all the cap logic needs and what the runtime executes first.
_NATIVE_JSON_ACTION_NAME_RE = re.compile(
    r"actions(?:\[\d+\])?\s*\{[^}]*?\bname\s*:\s*([A-Z_][A-Z0-9_]*)",
    re.DOTALL,
)
_NATIVE_JSON_FIRST_NAME_RE = re.compile(
    r"^\s*-\s*name\s*:\s*([A-Z_][A-Z0-9_]*)\s*$",
    re.MULTILINE,
)
# Common eliza action shape: actions: [N] { name: TASK_CALL ...
_NATIVE_JSON_ACTION_HEADER_RE = re.compile(
    r"\bname\s*:\s*([A-Z_][A-Z0-9_]+)",
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("cap-distribution")


# ─────────────────────────── extraction ────────────────────────────


def primary_action(rec: dict[str, Any]) -> str:
    """Best-effort primary action name for a record.

    Routing-style tasks (`reply`, `should_respond_with_context`, …)
    surface their action via `availableActions[0]`. Tool-call / shell
    tasks surface it via the native JSON `tool_calls[0].name` field of
    `expectedResponse`. We try both, in order, and fall back to a
    canonical sentinel so cap logic always has a key.
    """
    md = rec.get("metadata") or {}
    task_type = (md.get("task_type") or "").lower()

    # Tool-call / shell tasks: extract from native JSON expectedResponse.
    if task_type in ("tool_call", "shell_command", "agent_trace"):
        er = rec.get("expectedResponse")
        if isinstance(er, str) and er:
            m = _NATIVE_JSON_ACTION_HEADER_RE.search(er)
            if m:
                return m.group(1)

    # Routing / reply tasks: first availableActions entry.
    aa = rec.get("availableActions")
    if isinstance(aa, list) and aa:
        first = aa[0]
        if isinstance(first, str) and first:
            return first

    # Fall back to expectedResponse extraction even when task_type
    # didn't claim to be tool_call (some adapters mis-label).
    er = rec.get("expectedResponse")
    if isinstance(er, str) and er:
        m = _NATIVE_JSON_ACTION_HEADER_RE.search(er)
        if m:
            return m.group(1)

    return "_UNKNOWN_"


def source_of(rec: dict[str, Any]) -> str:
    md = rec.get("metadata") or {}
    return str(md.get("source_dataset") or "_unknown_")


def task_type_of(rec: dict[str, Any]) -> str:
    md = rec.get("metadata") or {}
    return str(md.get("task_type") or "_unknown_")


# ─────────────────────────── pass 1: scan ──────────────────────────


def scan_corpus(input_path: Path) -> tuple[
    list[tuple[str, str, str]],   # records: (source, primary_action, task_type)
    Counter,                       # by_source
    Counter,                       # by_action
    Counter,                       # by_task_type
    Counter,                       # by (source, task_type) tuple
]:
    """Single pass over the corpus collecting per-record routing keys.

    We keep one tuple-per-record in memory, not the full record. At
    ~30 bytes/tuple a 10M-row corpus costs ~300 MB — well within the
    machine budget. The actual records are re-streamed in pass 2 by
    line index so we never hold the JSON payload.
    """
    records: list[tuple[str, str, str]] = []
    by_source: Counter = Counter()
    by_action: Counter = Counter()
    by_task_type: Counter = Counter()
    by_source_task: Counter = Counter()

    with input_path.open("r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line:
                records.append(("_blank_", "_blank_", "_blank_"))
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                records.append(("_malformed_", "_malformed_", "_malformed_"))
                continue
            src = source_of(rec)
            act = primary_action(rec)
            tt = task_type_of(rec)
            records.append((src, act, tt))
            by_source[src] += 1
            by_action[act] += 1
            by_task_type[tt] += 1
            by_source_task[(src, tt)] += 1

    return records, by_source, by_action, by_task_type, by_source_task


# ─────────────────────────── cap engine ────────────────────────────


def apply_caps(
    records: list[tuple[str, str, str]],
    *,
    max_per_source: int,
    max_per_action: int,
    max_non_eliza_fraction: float,
    eliza_whitelist: frozenset[str],
    seed: int,
) -> tuple[set[int], dict[str, int]]:
    """Return (kept_indices, drop_reasons_counter).

    Three gates applied in order. Each gate computes which indices to
    drop and removes them from the working set. The final `kept` is the
    intersection of all gates' survivors.
    """
    n = len(records)
    drops: Counter = Counter()
    drop_reason: dict[int, str] = {}

    def _rng(*labels: str) -> random.Random:
        """Per-bucket RNG. Mixing the seed with a label string ensures the
        per-source / per-action / fraction-gate decisions are independent
        and reproducible across runs."""
        return random.Random(f"{seed}|" + "|".join(labels))

    # ── gate 1: per-source cap ─────────────────────────────────────
    # Group indices by source, downsample any over-cap source uniformly.
    if max_per_source > 0:
        by_src: dict[str, list[int]] = defaultdict(list)
        for i, (src, _, _) in enumerate(records):
            by_src[src].append(i)
        for src, idxs in by_src.items():
            if len(idxs) > max_per_source:
                rng = _rng("source", src)
                # rng.sample requires a list; idxs is one. Sort first
                # so the seed alone (not iteration order) drives selection.
                idxs_sorted = sorted(idxs)
                kept = set(rng.sample(idxs_sorted, max_per_source))
                for i in idxs_sorted:
                    if i not in kept:
                        drop_reason[i] = "too-many-of-source"
                        drops["too-many-of-source"] += 1

    # ── gate 2: per-action cap ─────────────────────────────────────
    if max_per_action > 0:
        by_act: dict[str, list[int]] = defaultdict(list)
        for i, (_, act, _) in enumerate(records):
            if i in drop_reason:
                continue
            by_act[act].append(i)
        for act, idxs in by_act.items():
            if len(idxs) > max_per_action:
                rng = _rng("action", act)
                idxs_sorted = sorted(idxs)
                kept = set(rng.sample(idxs_sorted, max_per_action))
                for i in idxs_sorted:
                    if i not in kept:
                        drop_reason[i] = "too-many-of-action"
                        drops["too-many-of-action"] += 1

    # ── gate 3: non-eliza fraction gate ────────────────────────────
    # Pool together the surviving non-eliza records. If they exceed
    # `max_non_eliza_fraction` of the total survivors, downsample
    # uniformly across the entire non-eliza pool (NOT per-source) so
    # the cut bites proportionally to current size.
    if 0.0 < max_non_eliza_fraction < 1.0:
        survivors = [i for i in range(n) if i not in drop_reason]
        eliza_idxs = [i for i in survivors if records[i][0] in eliza_whitelist]
        non_eliza_idxs = [i for i in survivors if records[i][0] not in eliza_whitelist]
        e = len(eliza_idxs)
        ne = len(non_eliza_idxs)
        total = e + ne
        if total > 0:
            current_ne_frac = ne / total
            if current_ne_frac > max_non_eliza_fraction:
                # Solve for ne' such that ne' / (e + ne') = cap.
                #   ne' = e * cap / (1 - cap)
                target_ne = int(e * max_non_eliza_fraction / (1.0 - max_non_eliza_fraction))
                target_ne = min(target_ne, ne)
                rng = _rng("non-eliza-fraction")
                non_eliza_sorted = sorted(non_eliza_idxs)
                kept = set(rng.sample(non_eliza_sorted, target_ne))
                for i in non_eliza_sorted:
                    if i not in kept:
                        drop_reason[i] = "non-eliza-fraction-exceeded"
                        drops["non-eliza-fraction-exceeded"] += 1

    kept_indices = {i for i in range(n) if i not in drop_reason}
    return kept_indices, dict(drops)


# ─────────────────────────── reporting ─────────────────────────────


def build_report(
    *,
    records: list[tuple[str, str, str]],
    kept: set[int],
    drops: dict[str, int],
    by_source_before: Counter,
    by_action_before: Counter,
    by_task_type_before: Counter,
    by_source_task_before: Counter,
    eliza_whitelist: frozenset[str],
    config_used: dict[str, Any],
    input_path: Path,
    output_path: Path,
) -> dict[str, Any]:
    after_source: Counter = Counter()
    after_action: Counter = Counter()
    after_task_type: Counter = Counter()
    after_source_task: Counter = Counter()
    for i in kept:
        src, act, tt = records[i]
        after_source[src] += 1
        after_action[act] += 1
        after_task_type[tt] += 1
        after_source_task[(src, tt)] += 1

    eliza_after = sum(c for s, c in after_source.items() if s in eliza_whitelist)
    non_eliza_after = sum(c for s, c in after_source.items() if s not in eliza_whitelist)
    total_after = eliza_after + non_eliza_after
    eliza_before = sum(c for s, c in by_source_before.items() if s in eliza_whitelist)
    non_eliza_before = sum(c for s, c in by_source_before.items() if s not in eliza_whitelist)
    total_before = eliza_before + non_eliza_before

    def _ratio(num: int, den: int) -> float:
        return float(num) / float(den) if den > 0 else 0.0

    return {
        "input": str(input_path),
        "output": str(output_path),
        "config": config_used,
        "totals": {
            "before": total_before,
            "after": total_after,
            "dropped": total_before - total_after,
        },
        "drop_reasons": drops,
        "eliza_fraction": {
            "before": _ratio(eliza_before, total_before),
            "after": _ratio(eliza_after, total_after),
        },
        "non_eliza_fraction": {
            "before": _ratio(non_eliza_before, total_before),
            "after": _ratio(non_eliza_after, total_after),
        },
        "balance_ratio_eliza_to_non_eliza": {
            "before": _ratio(eliza_before, non_eliza_before),
            "after": _ratio(eliza_after, non_eliza_after),
        },
        "by_source": {
            "before": dict(by_source_before.most_common()),
            "after": dict(after_source.most_common()),
        },
        "by_action": {
            "before": dict(by_action_before.most_common()),
            "after": dict(after_action.most_common()),
        },
        "by_task_type": {
            "before": dict(by_task_type_before.most_common()),
            "after": dict(after_task_type.most_common()),
        },
        "by_source_task_type": {
            "before": {f"{s}::{t}": c for (s, t), c in by_source_task_before.most_common()},
            "after": {f"{s}::{t}": c for (s, t), c in after_source_task.most_common()},
        },
        "eliza_tier_whitelist": sorted(eliza_whitelist),
    }


# ─────────────────────────── pass 2: write ─────────────────────────


def write_kept(input_path: Path, output_path: Path, kept: set[int]) -> int:
    """Stream input and write kept indices to output. Returns count written."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    with input_path.open("r", encoding="utf-8", errors="replace") as fin, \
            output_path.open("w", encoding="utf-8") as fout:
        for idx, line in enumerate(fin):
            if idx in kept:
                if not line.endswith("\n"):
                    line += "\n"
                fout.write(line)
                written += 1
    return written


# ─────────────────────────── config loader ─────────────────────────


def load_config(config_path: Path) -> dict[str, Any]:
    if not config_path.exists():
        raise FileNotFoundError(f"config not found: {config_path}")
    with config_path.open("r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f) or {}
    out = {
        "seed": int(cfg.get("seed", 42)),
        "max_per_source": int(cfg.get("max_per_source", 100_000)),
        "max_per_action": int(cfg.get("max_per_action", 50_000)),
        "max_non_eliza_fraction": float(cfg.get("max_non_eliza_fraction", 0.5)),
        "eliza_tier_whitelist": frozenset(cfg.get("eliza_tier_whitelist") or ELIZA_TIER_WHITELIST),
    }
    if not (0.0 <= out["max_non_eliza_fraction"] <= 1.0):
        raise ValueError(
            f"max_non_eliza_fraction must be in [0,1], got {out['max_non_eliza_fraction']}"
        )
    return out


# ─────────────────────────── CLI ───────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--input", type=Path, required=True,
                    help="packed train.jsonl from pack_dataset.py")
    ap.add_argument("--output", type=Path, required=True,
                    help="path for the capped output JSONL")
    ap.add_argument("--config", type=Path, required=True,
                    help="YAML config (config/corpus_caps.yaml)")
    ap.add_argument("--report", type=Path, required=True,
                    help="where to write the per-cap distribution report (JSON)")
    ap.add_argument("--dry-run", action="store_true",
                    help="compute caps + report without writing the output JSONL")
    args = ap.parse_args()

    if not args.input.exists():
        log.error("input does not exist: %s", args.input)
        return 2

    cfg = load_config(args.config)
    log.info("config: seed=%d per_source=%d per_action=%d non_eliza_max=%.2f whitelist=%s",
             cfg["seed"], cfg["max_per_source"], cfg["max_per_action"],
             cfg["max_non_eliza_fraction"], sorted(cfg["eliza_tier_whitelist"]))

    log.info("scanning %s", args.input)
    records, by_src, by_act, by_tt, by_src_tt = scan_corpus(args.input)
    log.info("scanned %d records / %d sources / %d distinct actions / %d task_types",
             len(records), len(by_src), len(by_act), len(by_tt))

    kept, drops = apply_caps(
        records,
        max_per_source=cfg["max_per_source"],
        max_per_action=cfg["max_per_action"],
        max_non_eliza_fraction=cfg["max_non_eliza_fraction"],
        eliza_whitelist=cfg["eliza_tier_whitelist"],
        seed=cfg["seed"],
    )
    log.info("kept %d / %d  (drops: %s)", len(kept), len(records), drops)

    config_used = {
        "seed": cfg["seed"],
        "max_per_source": cfg["max_per_source"],
        "max_per_action": cfg["max_per_action"],
        "max_non_eliza_fraction": cfg["max_non_eliza_fraction"],
    }
    report = build_report(
        records=records,
        kept=kept,
        drops=drops,
        by_source_before=by_src,
        by_action_before=by_act,
        by_task_type_before=by_tt,
        by_source_task_before=by_src_tt,
        eliza_whitelist=cfg["eliza_tier_whitelist"],
        config_used=config_used,
        input_path=args.input,
        output_path=args.output,
    )
    if args.dry_run:
        report["dry_run"] = True

    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2, sort_keys=False), encoding="utf-8")
    log.info("wrote report %s", args.report)

    if args.dry_run:
        log.info("--dry-run: skipping output write")
        # Print a one-line JSON summary so callers piping stdout see the answer.
        summary = {
            "dry_run": True,
            "before": report["totals"]["before"],
            "after": report["totals"]["after"],
            "dropped": report["totals"]["dropped"],
            "drop_reasons": report["drop_reasons"],
            "eliza_fraction_after": report["eliza_fraction"]["after"],
            "non_eliza_fraction_after": report["non_eliza_fraction"]["after"],
        }
        print(json.dumps(summary))
        return 0

    written = write_kept(args.input, args.output, kept)
    log.info("wrote %d records to %s", written, args.output)
    if written != len(kept):
        log.error("write count mismatch: kept=%d written=%d", len(kept), written)
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
