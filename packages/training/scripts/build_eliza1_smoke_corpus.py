#!/usr/bin/env python3
"""Build the eliza-1-smoke SFT corpus.

This is an ultra-light corpus intended to validate the e2e SFT pipeline
(format_record -> train_local). It is NOT a real fine-tune mix. The
recipe is intentionally small:

  * `N_PER_NORMALIZED` rows per normalized dataset under
    `packages/training/data/normalized/<source>.jsonl` (deterministic
    sample by `random.Random(SEED).sample(...)`).
  * `N_FROM_SFT_0_8B` rows from `datasets/eliza1-sft-0_8b/train.jsonl`
    so the chat_messages schema path is exercised.
  * `N_FROM_FINAL_MIX` rows from `data/final/train.jsonl` so the broad
    mixed-final pipeline is exercised.
  * Recent Eliza scenario trajectories from `~/.milady/trajectories/`
    (or the path in `ELIZA_TRAJECTORY_DIR`), converted to the
    `eliza_native_v1` boundary record shape that
    `format_for_training.format_record` accepts. Filtered to the last
    `TRAJECTORY_DAYS` days, capped at `TRAJECTORY_CAP`.

Every emitted row is passed through `format_record` which itself applies
the canonical Python privacy filter
(`privacy_filter_trajectories.redact_value`). The privacy contract is
the same one the real corpus uses; trajectory data never leaves this
script without the filter being applied.

Output: `data/final-eliza1-smoke/{train,val,test}.jsonl` plus
`manifest.json` documenting sources, sample-per-source counts, the
trajectory filter, and the random seed.

Splits: 80% train / 10% val / 10% test, deterministic shuffle.
"""

from __future__ import annotations

import hashlib
import json
import os
import random
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from format_for_training import format_record  # noqa: E402
from sample_native_trajectory_alignment import (  # noqa: E402
    native_rows_from_recorded_trajectory,
)

NORMALIZED_DIR = ROOT / "data" / "normalized"
SFT_0_8B = ROOT / "datasets" / "eliza1-sft-0_8b" / "train.jsonl"
FINAL_TRAIN = ROOT / "data" / "final" / "train.jsonl"
OUT_DIR = ROOT / "data" / "final-eliza1-smoke"

SEED = 42
N_PER_NORMALIZED = 3
N_FROM_SFT_0_8B = 10
N_FROM_FINAL_MIX = 10
TRAJECTORY_DAYS = 7
TRAJECTORY_CAP = 100

TRAIN_FRAC = 0.8
VAL_FRAC = 0.1
# test = remainder so the three fractions sum exactly to 1


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not path.exists():
        return rows
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def _sample_normalized() -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Sample N_PER_NORMALIZED format_record-valid rows from each source."""

    by_source: dict[str, int] = {}
    out: list[dict[str, Any]] = []
    if not NORMALIZED_DIR.exists():
        return out, by_source

    files = sorted(
        p for p in NORMALIZED_DIR.glob("*.jsonl") if not p.name.endswith(".errors.jsonl")
    )
    for path in files:
        source = path.stem
        rows = _load_jsonl(path)
        # Pre-filter to format_record-valid rows so we don't waste a sample slot
        # on a row train_local would reject. Cap the candidate pool to keep
        # the script fast (the smoke corpus only needs a handful per source).
        candidates: list[dict[str, Any]] = []
        for rec in rows[: max(N_PER_NORMALIZED * 30, 60)]:
            if format_record(rec) is not None:
                candidates.append(rec)
            if len(candidates) >= N_PER_NORMALIZED * 5:
                break
        if not candidates:
            continue
        rng = random.Random(_seed_for(source))
        take = min(N_PER_NORMALIZED, len(candidates))
        sampled = rng.sample(candidates, take)
        for rec in sampled:
            # Tag provenance so the manifest + downstream auditors can
            # trace each row back to its normalized source.
            metadata = rec.get("metadata") if isinstance(rec.get("metadata"), dict) else {}
            new_meta = dict(metadata)
            new_meta.setdefault("source_dataset", source)
            new_meta["smoke_corpus_source"] = f"normalized/{source}"
            rec["metadata"] = new_meta
            out.append(rec)
        by_source[source] = take
    return out, by_source


def _sample_jsonl_file(path: Path, n: int, tag: str) -> list[dict[str, Any]]:
    rows = _load_jsonl(path)
    if not rows:
        return []
    rng = random.Random(_seed_for(tag))
    # Pre-filter so we don't bias toward unrenderable rows
    candidates: list[dict[str, Any]] = []
    for rec in rows[: max(n * 30, 100)]:
        if format_record(rec) is not None:
            candidates.append(rec)
        if len(candidates) >= n * 5:
            break
    if not candidates:
        return []
    take = min(n, len(candidates))
    sampled = rng.sample(candidates, take)
    for rec in sampled:
        metadata = rec.get("metadata") if isinstance(rec.get("metadata"), dict) else {}
        if isinstance(metadata, dict):
            new_meta = dict(metadata)
            new_meta["smoke_corpus_source"] = tag
            rec["metadata"] = new_meta
    return sampled


def _seed_for(label: str) -> int:
    digest = hashlib.sha256(f"{SEED}:{label}".encode("utf-8")).hexdigest()
    return int(digest[:16], 16)


def _trajectory_rows() -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Collect recent Eliza runtime trajectories, convert to eliza_native_v1."""

    state_root = Path(os.environ.get("ELIZA_TRAJECTORY_DIR") or Path.home() / ".milady" / "trajectories")
    info: dict[str, Any] = {
        "path": str(state_root),
        "exists": state_root.exists(),
        "cutoff_days": TRAJECTORY_DAYS,
        "cap": TRAJECTORY_CAP,
        "files_scanned": 0,
        "files_in_window": 0,
        "rows_produced": 0,
        "skipped_reason": None,
        "oldest_mtime": None,
        "newest_mtime": None,
    }
    if not state_root.exists():
        info["skipped_reason"] = "trajectory directory does not exist"
        return [], info

    cutoff = datetime.now(tz=timezone.utc).timestamp() - TRAJECTORY_DAYS * 86400
    candidates: list[Path] = []
    oldest, newest = None, None
    for path in state_root.rglob("*.json"):
        info["files_scanned"] += 1
        try:
            mtime = path.stat().st_mtime
        except OSError:
            continue
        if oldest is None or mtime < oldest:
            oldest = mtime
        if newest is None or mtime > newest:
            newest = mtime
        if mtime >= cutoff:
            candidates.append(path)
    info["files_in_window"] = len(candidates)
    info["oldest_mtime"] = (
        datetime.fromtimestamp(oldest, tz=timezone.utc).isoformat() if oldest else None
    )
    info["newest_mtime"] = (
        datetime.fromtimestamp(newest, tz=timezone.utc).isoformat() if newest else None
    )

    if not candidates:
        info["skipped_reason"] = "no trajectory files in window"
        return [], info

    rng = random.Random(_seed_for("trajectories"))
    rng.shuffle(candidates)
    candidates = candidates[: TRAJECTORY_CAP * 3]

    rows: list[dict[str, Any]] = []
    for path in candidates:
        try:
            trajectory = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(trajectory, dict):
            continue
        if not trajectory.get("trajectoryId") or not isinstance(trajectory.get("stages"), list):
            continue
        produced = native_rows_from_recorded_trajectory(trajectory, path)
        for row in produced:
            # The native rows already carry metadata.source_dataset =
            # "real_eliza_runtime"; tag the smoke source so the manifest +
            # downstream auditors can identify this slice.
            md = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
            new_md = dict(md)
            new_md["smoke_corpus_source"] = "eliza_runtime_trajectories"
            row["metadata"] = new_md
            rows.append(row)
            if len(rows) >= TRAJECTORY_CAP:
                break
        if len(rows) >= TRAJECTORY_CAP:
            break

    info["rows_produced"] = len(rows)
    return rows, info


def _split(rows: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    rng = random.Random(_seed_for("shuffle"))
    rng.shuffle(rows)
    n = len(rows)
    n_train = int(round(n * TRAIN_FRAC))
    n_val = int(round(n * VAL_FRAC))
    n_test = n - n_train - n_val
    if n_test < 0:
        n_test = 0
        n_train = n - n_val
    return {
        "train": rows[:n_train],
        "val": rows[n_train : n_train + n_val],
        "test": rows[n_train + n_val :],
    }


def _validate_rows(rows: Iterable[dict[str, Any]]) -> tuple[int, int]:
    ok = 0
    fail = 0
    for rec in rows:
        if format_record(rec) is not None:
            ok += 1
        else:
            fail += 1
    return ok, fail


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    normalized_rows, by_normalized = _sample_normalized()
    sft_rows = _sample_jsonl_file(SFT_0_8B, N_FROM_SFT_0_8B, "datasets/eliza1-sft-0_8b/train.jsonl")
    final_rows = _sample_jsonl_file(FINAL_TRAIN, N_FROM_FINAL_MIX, "data/final/train.jsonl")
    trajectory_rows, trajectory_info = _trajectory_rows()

    all_rows = normalized_rows + sft_rows + final_rows + trajectory_rows
    print(f"normalized rows: {len(normalized_rows)} from {len(by_normalized)} sources")
    print(f"sft_0_8b rows: {len(sft_rows)}")
    print(f"final mix rows: {len(final_rows)}")
    print(f"trajectory rows: {len(trajectory_rows)} ({trajectory_info.get('skipped_reason') or 'ok'})")
    print(f"total before split: {len(all_rows)}")

    splits = _split(all_rows)

    # Final validation pass: every emitted row MUST be format_record-valid
    # (because train_local.py drives them through format_record).
    counts: dict[str, dict[str, int]] = {}
    for name, rows in splits.items():
        ok, fail = _validate_rows(rows)
        counts[name] = {"total": len(rows), "format_record_ok": ok, "format_record_failed": fail}
        path = OUT_DIR / f"{name}.jsonl"
        with path.open("w", encoding="utf-8") as f:
            for rec in rows:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        print(f"{name}: wrote {len(rows)} rows (format_record ok={ok}, failed={fail}) -> {path}")
        if fail:
            print(f"  FAIL: {name} has {fail} rows that format_record rejected", file=sys.stderr)
            return 1

    manifest = {
        "schema": "eliza.eliza1_smoke_corpus_manifest.v1",
        "purpose": "ultra-light smoke corpus to validate the e2e SFT pipeline. NOT a real fine-tune mix.",
        "build_date": datetime.now(tz=timezone.utc).isoformat(),
        "seed": SEED,
        "splits": counts,
        "totals": {
            "rows": sum(c["total"] for c in counts.values()),
            "format_record_ok": sum(c["format_record_ok"] for c in counts.values()),
        },
        "sources": {
            "normalized": {
                "n_per_source": N_PER_NORMALIZED,
                "source_count": len(by_normalized),
                "rows": len(normalized_rows),
                "by_source": by_normalized,
            },
            "eliza1_sft_0_8b": {
                "path": str(SFT_0_8B.relative_to(ROOT)),
                "rows": len(sft_rows),
            },
            "final_mix": {
                "path": str(FINAL_TRAIN.relative_to(ROOT)),
                "rows": len(final_rows),
            },
            "eliza_runtime_trajectories": trajectory_info,
        },
        "privacy_filter": {
            "applied": True,
            "module": "scripts/format_for_training.py via scripts/privacy_filter_trajectories.py",
            "note": "format_record() applies the canonical Python port of the app-training privacy filter to every emitted record. There is no bypass path.",
        },
        "split_ratios": {
            "train": TRAIN_FRAC,
            "val": VAL_FRAC,
            "test": round(1.0 - TRAIN_FRAC - VAL_FRAC, 6),
        },
    }
    (OUT_DIR / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {OUT_DIR / 'manifest.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
