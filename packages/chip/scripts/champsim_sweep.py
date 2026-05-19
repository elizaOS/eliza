#!/usr/bin/env python3
"""ChampSim prefetcher / replacement sweep wrapper.

Drives the ChampSim simulator (https://github.com/ChampSim/ChampSim) over
DPC-3 traces to produce per-prefetcher and per-replacement MPKI/IPC delta
JSON. The wrapper assumes ChampSim is built under
`external/ChampSim/bin/<config>` or that the path is supplied with
`--champsim-bin`.

This script is fail-closed:
- If ChampSim is not installed -> writes a BLOCKED stub artifact under
  `build/reports/cache/champsim_<mode>_blocked.json`.
- If traces are missing -> writes a BLOCKED stub.
- If `--blocked-evidence` is supplied, always writes a BLOCKED stub and
  exits 0; this is used by the `make champsim-prefetch-sweep` and
  `make mockingjay-vs-lru-sweep` fallback path.

A successful sweep writes
`docs/evidence/cache/champsim_prefetch_sweep_report.json` (prefetch mode)
or `docs/evidence/cache/mockingjay_vs_lru_report.json`
(mockingjay-vs-lru mode) only when explicit `--commit-evidence` is passed;
otherwise output goes to a `build/reports/cache/` scratch path.

Phone-class MPKI / IPC delta claims remain BLOCKED until the academic
infrastructure is wired in (ChampSim built locally, DPC-3 traces present)
and committed evidence is recorded against the gate.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shutil
import subprocess
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

PREFETCH_SWEEP_PREFETCHERS = ("no", "berti", "ipcp", "spp", "bop", "pythia")
MOCKINGJAY_SWEEP_REPLACEMENTS = ("lru", "mockingjay")

DEFAULT_TRACES = (
    "DPC3_400.gcc_s.champsimtrace.xz",
    "DPC3_403.gcc.champsimtrace.xz",
    "DPC3_429.mcf.champsimtrace.xz",
)

MODE_TO_SCHEMA = {
    "prefetch": "eliza.cache.champsim_prefetch_sweep.v1",
    "mockingjay-vs-lru": "eliza.cache.mockingjay_vs_lru.v1",
}
MODE_TO_EVIDENCE_NAME = {
    "prefetch": "champsim_prefetch_sweep_report.json",
    "mockingjay-vs-lru": "mockingjay_vs_lru_report.json",
}


def find_champsim_bin() -> str | None:
    candidate_files = [
        ROOT / "external/ChampSim/bin/champsim",
        ROOT / "tools/bin/champsim",
        ROOT / "tools/champsim",
    ]
    for cand in candidate_files:
        if cand.is_file() and os.access(cand, os.X_OK):
            return str(cand)
    # Scan external/ChampSim/bin for the first executable whose name starts
    # with "champsim" (the upstream build emits named binaries like
    # `champsim_default` etc.).
    chip_bin_dir = ROOT / "external/ChampSim/bin"
    if chip_bin_dir.is_dir():
        for entry in sorted(chip_bin_dir.iterdir()):
            if (
                entry.is_file()
                and os.access(entry, os.X_OK)
                and entry.name.lower().startswith("champsim")
            ):
                return str(entry)
    return shutil.which("champsim")


def find_traces() -> list[Path]:
    for candidate in (
        ROOT / "external/ChampSim/traces",
        ROOT / "external/dpc3-traces",
        ROOT / "tools/dpc3-traces",
        Path(os.environ.get("DPC3_TRACE_DIR", "/dev/null")),
    ):
        if candidate.is_dir():
            entries = sorted(candidate.glob("*.champsimtrace*"))
            if entries:
                return entries
    return []


def write_blocked_stub(path: Path, mode: str, reason: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema": MODE_TO_SCHEMA[mode],
        "status": "blocked",
        "mode": mode,
        "captured_utc": dt.datetime.now(dt.UTC).isoformat(),
        "blocked_reason": reason,
        "expected_prefetchers": list(PREFETCH_SWEEP_PREFETCHERS)
        if mode == "prefetch"
        else list(PREFETCHERS),
        "expected_replacements": list(MOCKINGJAY_SWEEP_REPLACEMENTS)
        if mode == "mockingjay-vs-lru"
        else list(REPLACEMENTS),
        "next_unblock_steps": [
            "Install ChampSim under external/ChampSim/",
            "Download DPC-3 traces to external/ChampSim/traces/",
            f"Rerun: python3 scripts/champsim_sweep.py --mode {mode}",
        ],
        "target_evidence_path": (f"docs/evidence/cache/{MODE_TO_EVIDENCE_NAME[mode]}"),
    }
    path.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"ChampSim {mode} sweep BLOCKED ({reason}); wrote stub to {path}")


def run_one(binary: str, trace: Path, prefetcher: str, replacement: str) -> dict:
    cmd = [
        binary,
        "--warmup_instructions",
        "25_000_000",
        "--simulation_instructions",
        "25_000_000",
        "--prefetcher",
        prefetcher,
        "--replacement",
        replacement,
        "--traces",
        str(trace),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=1200)
    return {
        "trace": trace.name,
        "prefetcher": prefetcher,
        "replacement": replacement,
        "returncode": proc.returncode,
        "stdout_tail": proc.stdout[-2000:] if proc.stdout else "",
        "stderr_tail": proc.stderr[-2000:] if proc.stderr else "",
    }


def real_sweep(binary: str, traces: list[Path], mode: str) -> dict:
    results: list[dict] = []
    if mode == "prefetch":
        for trace in traces[:6]:
            for pref in PREFETCH_SWEEP_PREFETCHERS:
                results.append(run_one(binary, trace, pref, "lru"))
    else:
        for trace in traces[:6]:
            for repl in MOCKINGJAY_SWEEP_REPLACEMENTS:
                results.append(run_one(binary, trace, "no", repl))
    return {
        "schema": MODE_TO_SCHEMA[mode],
        "status": "real_sweep",
        "mode": mode,
        "captured_utc": dt.datetime.now(dt.UTC).isoformat(),
        "champsim_binary": binary,
        "trace_count": len(traces),
        "results": results,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--mode",
        choices=tuple(MODE_TO_SCHEMA.keys()),
        default="prefetch",
        help="Which sweep to run (default: prefetch)",
    )
    ap.add_argument("--champsim-bin", default=None, help="Override ChampSim binary path")
    ap.add_argument("--output", default=None, help="Output JSON path (defaults to scratch)")
    ap.add_argument(
        "--commit-evidence",
        action="store_true",
        help="Write the artifact under docs/evidence/cache/",
    )
    ap.add_argument(
        "--blocked-evidence",
        action="store_true",
        help=(
            "Force-write a BLOCKED evidence artifact and exit 0. Used by the "
            "Makefile fallback when ChampSim is unavailable."
        ),
    )
    args = ap.parse_args()

    scratch = ROOT / f"build/reports/cache/champsim_{args.mode}_sweep.json"
    blocked = ROOT / f"build/reports/cache/champsim_{args.mode}_blocked.json"
    evidence = ROOT / f"docs/evidence/cache/{MODE_TO_EVIDENCE_NAME[args.mode]}"

    if args.blocked_evidence:
        write_blocked_stub(blocked, args.mode, "blocked_evidence_forced")
        return 0

    out_path = Path(args.output) if args.output else (evidence if args.commit_evidence else scratch)

    binary = args.champsim_bin or find_champsim_bin()
    if binary is None:
        write_blocked_stub(blocked, args.mode, "champsim_binary_missing")
        return 0

    traces = find_traces()
    if not traces:
        write_blocked_stub(blocked, args.mode, "champsim_traces_missing")
        return 0

    artifact = real_sweep(binary, traces, args.mode)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(artifact, indent=2) + "\n")
    print(f"ChampSim {args.mode} sweep complete; {len(artifact['results'])} runs")
    print(f"  evidence: {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
