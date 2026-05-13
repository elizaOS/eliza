"""Summarize a heartbeat JSONL produced by `scripts.inference.heartbeat`.

Pure operator tool — prints a one-screen rollup of the most recent
intervals so a human can spot-check a running serve. The Eliza Cloud UI
reads the same JSONL through a different code path.

Usage from `training/`:

    python -m scripts.inference.stats_summary \\
        --in ~/.eliza/inference-stats.jsonl \\
        --label adhoc-h200-eliza-1-4b \\
        --last-minutes 30
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
from pathlib import Path


def _parse_ts(value: str) -> dt.datetime | None:
    try:
        parsed = dt.datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed


def _load_records(
    path: Path, label_filter: str | None, last_minutes: float | None
) -> tuple[list[dict], int]:
    if not path.exists() or path.is_dir():
        return [], 0
    cutoff: dt.datetime | None = None
    if last_minutes is not None and last_minutes > 0:
        cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=last_minutes)
    records: list[dict] = []
    error_count = 0
    with path.open("r", encoding="utf-8") as fh:
        for raw in fh:
            raw = raw.strip()
            if not raw:
                continue
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if label_filter and obj.get("label") != label_filter:
                continue
            if cutoff is not None:
                ts = _parse_ts(obj.get("ts", ""))
                if ts is None or ts < cutoff:
                    continue
            if "error" in obj:
                error_count += 1
                # error rows still count toward the window for the error %
                records.append(obj)
                continue
            records.append(obj)
    return records, error_count


def _quantile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    s = sorted(values)
    if len(s) == 1:
        return s[0]
    idx = q * (len(s) - 1)
    lo = int(idx)
    hi = min(lo + 1, len(s) - 1)
    frac = idx - lo
    return s[lo] + (s[hi] - s[lo]) * frac


def _mean(values: list[float]) -> float | None:
    return (sum(values) / len(values)) if values else None


def _collect(records: list[dict], key: str) -> list[float]:
    out: list[float] = []
    for r in records:
        if "error" in r:
            continue
        v = r.get(key)
        if v is None:
            continue
        try:
            out.append(float(v))
        except (TypeError, ValueError):
            continue
    return out


def _fmt(value: float | None, suffix: str = "", *, precision: int = 2) -> str:
    if value is None:
        return "n/a"
    return f"{value:.{precision}f}{suffix}"


def _fmt_int(value: float | None, suffix: str = "") -> str:
    if value is None:
        return "n/a"
    return f"{int(value)}{suffix}"


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__.split("\n\n", 1)[0],
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--in", dest="in_path", required=True,
                    help="Path to a heartbeat JSONL.")
    ap.add_argument("--label", default=None,
                    help="Only consider records with this label.")
    ap.add_argument("--last-minutes", type=float, default=None,
                    help="Only consider records newer than N minutes.")
    args = ap.parse_args()

    path = Path(os.path.expanduser(args.in_path))
    records, errors = _load_records(path, args.label, args.last_minutes)
    if not records:
        print(f"no data: {path}"
              + (f" (label={args.label})" if args.label else "")
              + (f" (last_minutes={args.last_minutes})" if args.last_minutes else ""))
        return 0

    tps = _collect(records, "tokens_per_sec")
    p50_tpot = _collect(records, "p50_tpot_ms")
    p95_tpot = _collect(records, "p95_tpot_ms")
    kv = _collect(records, "kv_cache_usage_pct")
    vram = _collect(records, "peak_vram_mb")
    spec = _collect(records, "spec_decode_accept_rate")
    apc = _collect(records, "apc_hit_rate")

    error_pct = 100.0 * errors / len(records) if records else 0.0

    width = 72
    title = f"heartbeat summary  {path}"
    if args.label:
        title += f"  label={args.label}"
    if args.last_minutes:
        title += f"  last={args.last_minutes:g}min"
    print(title)
    print("=" * width)
    print(f"intervals      : {len(records)}  (errors: {errors}, {error_pct:.1f}%)")
    print(f"tokens/sec     : p50={_fmt(_quantile(tps, 0.50))}  "
          f"p95={_fmt(_quantile(tps, 0.95))}  "
          f"mean={_fmt(_mean(tps))}")
    print(f"tpot ms        : p50={_fmt(_quantile(p50_tpot, 0.50))}  "
          f"p95={_fmt(_quantile(p95_tpot, 0.95))}")
    print(f"kv cache usage : mean={_fmt(_mean(kv), '%')}  "
          f"max={_fmt(max(kv) if kv else None, '%')}")
    print(f"peak VRAM (MB) : max={_fmt_int(max(vram) if vram else None)}  "
          f"mean={_fmt_int(_mean(vram))}")
    print(f"spec accept    : mean={_fmt(_mean(spec))}"
          + ("  (no data)" if not spec else ""))
    print(f"APC hit rate   : mean={_fmt(_mean(apc))}"
          + ("  (no data)" if not apc else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
