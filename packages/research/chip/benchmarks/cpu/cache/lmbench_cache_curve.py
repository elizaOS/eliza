#!/usr/bin/env python3
"""lmbench `lat_mem_rd` cache latency curve harness.

Drives the host's `lat_mem_rd` binary (under tools/bin or oss-cad-suite)
across five working-set points: 1 KiB, 64 KiB, 1 MiB, 16 MiB, 256 MiB.

Writes a JSON evidence artifact suitable for the cache evidence gate.

This harness is host-relative: when run on a developer workstation, the
output represents the developer's CPU and memory subsystem, NOT the
2028 SoC. It is shipped for two reasons:

1. Functional path validation: prove the parser, output schema, and
   evidence-gate wiring work end-to-end before silicon exists.
2. Methodology template: the same parser will produce the canonical
   phone-class curve once a real target is available.

Phone-class claims remain BLOCKED until the same JSON is produced from
the target SoC; see docs/evidence/cache/cache-evidence-gate.yaml.
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
from collections.abc import Iterable
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]

# Working sets to walk (size in bytes, label)
DEFAULT_WORKING_SETS = (
    ("1KiB", 1 * 1024),
    ("64KiB", 64 * 1024),
    ("1MiB", 1 * 1024 * 1024),
    ("16MiB", 16 * 1024 * 1024),
    ("256MiB", 256 * 1024 * 1024),
)

DEFAULT_STRIDE_BYTES = 64
DEFAULT_RUN_SECONDS = 1


def find_lat_mem_rd() -> str | None:
    for cand in (
        ROOT / "tools/bin/lat_mem_rd",
        ROOT / "external/oss-cad-suite/bin/lat_mem_rd",
    ):
        if cand.is_file() and os.access(cand, os.X_OK):
            return str(cand)
    on_path = shutil.which("lat_mem_rd")
    return on_path


def run_lat_mem_rd(binary: str, size_bytes: int, stride: int, timeout: int) -> str:
    """Invoke lat_mem_rd for a given working set, returning the raw stdout.

    lat_mem_rd reports latency for one (size, stride) pair per invocation.
    Size is provided in megabytes; for sub-megabyte working sets we round
    up to 1 MB which is the smallest unit the lmbench binary accepts.
    """
    size_mb = max(1, size_bytes // (1024 * 1024))
    cmd = [binary, str(size_mb), str(stride)]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
    return proc.stdout + proc.stderr


def parse_lat_mem_rd_output(text: str) -> list[dict]:
    """Extract `<stride_kib> <latency_ns>` rows."""
    out: list[dict] = []
    line_re = re.compile(r"^\s*([\d.]+)\s+([\d.]+)\s*$")
    for line in text.splitlines():
        m = line_re.match(line)
        if not m:
            continue
        try:
            stride_kib = float(m.group(1))
            latency_ns = float(m.group(2))
            out.append({"stride_kib": stride_kib, "latency_ns": latency_ns})
        except ValueError:
            continue
    return out


def build_artifact(
    measurements: dict,
    source: str,
    working_sets: Iterable[tuple[str, int]],
    stride_bytes: int,
    binary: str | None,
) -> dict:
    return {
        "schema": "eliza.cache.lmbench_curve.v1",
        "status": "host_scaffold_only_not_target_evidence",
        "captured_utc": dt.datetime.now(dt.UTC).isoformat(),
        "source": source,
        "binary": binary,
        "working_sets": [{"label": label, "size_bytes": size} for label, size in working_sets],
        "stride_bytes": stride_bytes,
        "measurements": measurements,
        "claim_boundary": (
            "Host scaffold only. Real-target curve is BLOCKED until the same "
            "schema is produced from the 2028 phone SoC under "
            "documented frequency and thermal state."
        ),
        "next_unblock_steps": [
            "Run on representative silicon",
            "Capture frequency / thermal context",
            "Write artifact to docs/evidence/cache/lmbench_lat_mem_rd_curve.json",
        ],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--output",
        default=None,
        help="Output JSON path. Defaults to build/reports/cache/lmbench_host_curve.json",
    )
    ap.add_argument(
        "--allow-missing-tool",
        action="store_true",
        help="Exit 0 with a BLOCKED stub artifact if lat_mem_rd is unavailable",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Write a methodology-only stub without invoking lat_mem_rd",
    )
    ap.add_argument(
        "--per-set-timeout",
        type=int,
        default=8,
        help="Seconds per working-set invocation (default 8)",
    )
    args = ap.parse_args()

    binary = find_lat_mem_rd()
    out_dir = ROOT / "build/reports/cache"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = Path(args.output) if args.output else (out_dir / "lmbench_host_curve.json")

    if binary is None:
        if not args.allow_missing_tool:
            print("lat_mem_rd not found in tools/bin, oss-cad-suite, or PATH", file=sys.stderr)
            return 2
        artifact = build_artifact(
            measurements={"status": "blocked", "reason": "lat_mem_rd missing"},
            source="blocked_missing_tool",
            working_sets=DEFAULT_WORKING_SETS,
            stride_bytes=DEFAULT_STRIDE_BYTES,
            binary=None,
        )
        out_path.write_text(json.dumps(artifact, indent=2) + "\n")
        print(f"lat_mem_rd missing; wrote BLOCKED stub to {out_path}")
        return 0

    if args.dry_run:
        artifact = build_artifact(
            measurements={"status": "dry_run", "reason": "methodology stub"},
            source="host_dry_run",
            working_sets=DEFAULT_WORKING_SETS,
            stride_bytes=DEFAULT_STRIDE_BYTES,
            binary=binary,
        )
        out_path.write_text(json.dumps(artifact, indent=2) + "\n")
        print(f"dry-run; wrote methodology stub to {out_path}")
        return 0

    measurements: dict = {}
    # Working sets >= 16 MiB are slow on developer hosts (`lat_mem_rd` walks
    # the full set under each stride). They are gated behind
    # `CACHE_CURVE_LARGE=1` so the methodology validation path stays fast.
    large_threshold = 16 * 1024 * 1024
    for label, size in DEFAULT_WORKING_SETS:
        if size >= large_threshold and not os.environ.get("CACHE_CURVE_LARGE"):
            measurements[label] = {
                "size_bytes": size,
                "rows": [],
                "skipped": "set CACHE_CURVE_LARGE=1 to include",
            }
            continue
        try:
            raw = run_lat_mem_rd(
                binary,
                size,
                DEFAULT_STRIDE_BYTES,
                timeout=args.per_set_timeout,
            )
            rows = parse_lat_mem_rd_output(raw)
            measurements[label] = {
                "size_bytes": size,
                "rows": rows,
                "raw_lines": len(raw.splitlines()),
            }
        except subprocess.TimeoutExpired:
            measurements[label] = {
                "size_bytes": size,
                "rows": [],
                "error": "timeout",
            }

    artifact = build_artifact(
        measurements=measurements,
        source="host_local_run",
        working_sets=DEFAULT_WORKING_SETS,
        stride_bytes=DEFAULT_STRIDE_BYTES,
        binary=binary,
    )
    out_path.write_text(json.dumps(artifact, indent=2) + "\n")
    print(f"lmbench cache curve written to {out_path}")
    print(f"  source: {artifact['source']}")
    print(f"  binary: {artifact['binary']}")
    for label, _ in DEFAULT_WORKING_SETS:
        rows = measurements.get(label, {}).get("rows", [])
        print(f"  {label}: {len(rows)} stride samples")
    return 0


if __name__ == "__main__":
    sys.exit(main())
