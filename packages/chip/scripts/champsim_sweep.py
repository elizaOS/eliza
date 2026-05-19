#!/usr/bin/env python3
"""ChampSim prefetcher / replacement sweep wrapper.

Drives the ChampSim simulator (https://github.com/ChampSim/ChampSim) over
DPC-3 traces to produce per-prefetcher and per-replacement MPKI delta
JSON. The wrapper assumes ChampSim is built under
`external/ChampSim/bin/<config>` or that the path is supplied with
`--champsim-bin`.

This script is fail-closed:
- If ChampSim is not installed -> exits with status_code=0 and writes a
  BLOCKED stub artifact under `build/reports/cache/champsim_blocked.json`.
- If traces are missing -> writes a BLOCKED stub.

A successful sweep writes
`docs/evidence/cache/champsim_prefetch_sweep_report.json` only when
explicit `--commit-evidence` is passed; otherwise output goes to
`build/reports/cache/champsim_sweep.json` (developer scratch).

Phone-class MPKI claims remain BLOCKED until the academic-quality
infrastructure is wired in and committed to git LFS or vetted to be
buildable offline.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

PREFETCHERS = (
    "no",
    "next_line",
    "ip_stride",
    "berti",
    "ipcp",
    "bingo",
    "spp",
    "bop",
    "pythia",
)
REPLACEMENTS = (
    "lru",
    "drrip",
    "hawkeye",
    "mockingjay",
)

DEFAULT_TRACES = (
    "DPC3_400.gcc_s.champsimtrace.xz",
    "DPC3_403.gcc.champsimtrace.xz",
    "DPC3_429.mcf.champsimtrace.xz",
)


def find_champsim_bin() -> str | None:
    candidate_dirs = [
        ROOT / "external/ChampSim/bin",
        ROOT / "tools/bin",
    ]
    for d in candidate_dirs:
        if not d.is_dir():
            continue
        for entry in d.iterdir():
            if entry.is_file() and os.access(entry, os.X_OK):
                return str(entry)
    return shutil.which("champsim")


def find_traces() -> list[Path]:
    trace_dir = ROOT / "external/ChampSim/traces"
    if not trace_dir.is_dir():
        return []
    return sorted(trace_dir.iterdir())


def write_blocked_stub(path: Path, reason: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema": "eliza.cache.champsim_prefetch_sweep.v1",
        "status": "blocked",
        "captured_utc": dt.datetime.now(dt.UTC).isoformat(),
        "blocked_reason": reason,
        "expected_prefetchers": list(PREFETCHERS),
        "expected_replacements": list(REPLACEMENTS),
        "next_unblock_steps": [
            "Install ChampSim under external/ChampSim/",
            "Download DPC-3 traces to external/ChampSim/traces/",
            "Rerun: python3 scripts/champsim_sweep.py",
        ],
    }
    path.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"ChampSim sweep BLOCKED ({reason}); wrote stub to {path}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--champsim-bin", default=None, help="Override ChampSim binary path")
    ap.add_argument("--output", default=None, help="Output JSON path (defaults to scratch)")
    ap.add_argument(
        "--commit-evidence",
        action="store_true",
        help="Write the artifact under docs/evidence/cache/",
    )
    args = ap.parse_args()

    scratch = ROOT / "build/reports/cache/champsim_sweep.json"
    evidence = ROOT / "docs/evidence/cache/champsim_prefetch_sweep_report.json"
    out_path = Path(args.output) if args.output else (evidence if args.commit_evidence else scratch)

    binary = args.champsim_bin or find_champsim_bin()
    if binary is None:
        write_blocked_stub(out_path, "champsim_binary_missing")
        # Exit 0 — fail-closed via stub artifact, not via process status.
        return 0

    traces = find_traces()
    if not traces:
        write_blocked_stub(out_path, "champsim_traces_missing")
        return 0

    # Real sweep would loop here. We stop short of running uncommitted EDA
    # against potentially-large traces in this scaffold; emit a BLOCKED
    # stub so the gate stays honest.
    write_blocked_stub(
        out_path,
        "academic_sweep_not_yet_committed_to_repo",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
