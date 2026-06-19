#!/usr/bin/env python3
"""STREAM bandwidth harness for the cache hierarchy gate.

Drives the standard McCalpin STREAM binary (Copy, Scale, Add, Triad)
across cache-resident and DRAM-resident working sets and writes a JSON
evidence artifact. Same fail-closed semantics as
`benchmarks/cpu/cache/lmbench_cache_curve.py`:

- Host runs produce host-local bandwidth, NOT phone-class evidence.
- Phone-class claims remain BLOCKED until the same JSON is produced from
  the 2028 phone SoC with documented frequency and thermal state.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]

KERNELS = ("Copy", "Scale", "Add", "Triad")


def find_stream_binary() -> str | None:
    for cand in (
        ROOT / "tools/bin/stream",
        ROOT / "external/oss-cad-suite/bin/stream",
    ):
        if cand.is_file() and os.access(cand, os.X_OK):
            return str(cand)
    return shutil.which("stream") or shutil.which("stream_c")


def parse_stream_output(text: str) -> dict[str, dict]:
    """Parse the canonical STREAM table:

    Function    Best Rate MB/s  Avg time     Min time     Max time
    Copy:               12345.6     0.012345     0.012000     0.013000
    ...
    """
    out: dict[str, dict] = {}
    line_re = re.compile(r"^\s*(Copy|Scale|Add|Triad):\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)")
    for line in text.splitlines():
        m = line_re.match(line)
        if not m:
            continue
        out[m.group(1)] = {
            "rate_mb_s": float(m.group(2)),
            "avg_time_s": float(m.group(3)),
            "min_time_s": float(m.group(4)),
            "max_time_s": float(m.group(5)),
        }
    return out


def build_artifact(measurements: object, source: str, binary: str | None) -> dict:
    return {
        "schema": "eliza.cache.stream_bandwidth.v1",
        "status": "host_scaffold_only_not_target_evidence",
        "captured_utc": dt.datetime.now(dt.UTC).isoformat(),
        "source": source,
        "binary": binary,
        "kernels": list(KERNELS),
        "measurements": measurements,
        "claim_boundary": (
            "Host STREAM run is methodology evidence only. Real-target "
            "sustained bandwidth is BLOCKED until the same JSON is produced "
            "on 2028 phone silicon with documented thermal and DVFS state."
        ),
        "next_unblock_steps": [
            "Run STREAM on representative silicon",
            "Capture sustained Triad GB/s with frequency and thermal context",
            "Write artifact to docs/evidence/cache/stream_bandwidth_report.json",
        ],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--output",
        default=None,
        help="Output JSON path (default build/reports/cache/stream_host.json)",
    )
    ap.add_argument(
        "--allow-missing-tool",
        action="store_true",
        help="Exit 0 with a BLOCKED stub artifact if STREAM is unavailable",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Write a methodology-only stub without invoking STREAM",
    )
    args = ap.parse_args()

    out_dir = ROOT / "build/reports/cache"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = Path(args.output) if args.output else (out_dir / "stream_host.json")

    binary = find_stream_binary()
    if args.dry_run or binary is None:
        if binary is None and not args.allow_missing_tool and not args.dry_run:
            print("STREAM binary not found in tools/bin, oss-cad-suite, or PATH", file=sys.stderr)
            return 2
        artifact = build_artifact(
            measurements={"status": "blocked", "reason": "stream binary missing"}
            if not args.dry_run
            else {"status": "dry_run", "reason": "methodology stub"},
            source="blocked_missing_tool" if not args.dry_run else "host_dry_run",
            binary=binary,
        )
        out_path.write_text(json.dumps(artifact, indent=2) + "\n")
        print(f"STREAM benchmark stub written to {out_path}")
        return 0

    try:
        proc = subprocess.run([binary], capture_output=True, text=True, timeout=120, check=False)
    except subprocess.TimeoutExpired:
        artifact = build_artifact(
            measurements={"status": "timeout"},
            source="host_local_run",
            binary=binary,
        )
        out_path.write_text(json.dumps(artifact, indent=2) + "\n")
        print(f"STREAM timed out; wrote {out_path}")
        return 0

    measurements = parse_stream_output(proc.stdout + proc.stderr)
    artifact = build_artifact(
        measurements=measurements
        or {
            "_parse_status": {
                "status": "no_parsed_rows",
                "raw_lines": len(proc.stdout.splitlines()),
            }
        },
        source="host_local_run",
        binary=binary,
    )
    out_path.write_text(json.dumps(artifact, indent=2) + "\n")
    print(f"STREAM benchmark written to {out_path}")
    for kernel in KERNELS:
        row = measurements.get(kernel, {})
        rate = row.get("rate_mb_s", "?")
        print(f"  {kernel}: {rate} MB/s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
