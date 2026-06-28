#!/usr/bin/env python3
"""ChampSim prefetcher / replacement sweep wrapper.

Drives the ChampSim simulator (https://github.com/ChampSim/ChampSim) over
DPC-3 traces and emits per-prefetcher / per-replacement MPKI/IPC JSON.

ChampSim bakes the prefetcher and replacement choice at configure time, so
the wrapper expects one binary per variant under `external/ChampSim/bin/`:

  - prefetch mode:        champsim_pref_<name>   for each name in
                          PREFETCH_SWEEP_PREFETCHERS
  - mockingjay-vs-lru:    champsim_repl_<name>   for each name in
                          MOCKINGJAY_SWEEP_REPLACEMENTS

The binaries are produced by `external/ChampSim/build-configs/*.json`
passed to `./config.sh --join chain`. See
`docs/evidence/cache/cache-evidence-gate.yaml` for the gate that consumes
this output.

Fail-closed:
  - ChampSim base binary missing -> BLOCKED stub.
  - No DPC-3 traces -> BLOCKED stub.
  - Specific variant binary missing -> the variant row records
    `status: missing_binary` but the rest of the sweep still runs.

Phone-class IPC claims remain BLOCKED. The output is explicitly tagged
`evidence_class: champsim_dpc3_traces_only`.
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
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CHAMPSIM_BIN_DIR = ROOT / "external/ChampSim/bin"

# Full sweep universe (for reporting); the variants actually exercised are
# constrained to whichever variant binaries exist on disk.
PREFETCHERS = (
    "no",
    "next_line",
    "ip_stride",
    "spp_dev",
    "va_ampm_lite",
    # The following live behind third-party drop-ins (CRC submissions) and
    # are not part of the upstream ChampSim 2024-12 module set:
    "berti",
    "ipcp",
    "bingo",
    "bop",
    "pythia",
)
REPLACEMENTS = (
    "lru",
    "drrip",
    "srrip",
    "ship",
    "random",
    # Third-party CRC submissions (not in upstream ChampSim 2024-12):
    "hawkeye",
    "mockingjay",
)

PREFETCH_SWEEP_PREFETCHERS = (
    "no",
    "next_line",
    "ip_stride",
    "spp_dev",
    "va_ampm_lite",
    "berti",
    "ipcp",
    "bingo",
    "bop",
    "pythia",
)
MOCKINGJAY_SWEEP_REPLACEMENTS = (
    "lru",
    "drrip",
    "ship",
    "srrip",
)

# Prefetchers/replacements that we know are external-only (not built into
# the upstream ChampSim 2024-12 tag); their absence is reported but not a
# hard failure. Berti, IPCP, Bingo, BOP, Pythia are CRC-style drop-ins;
# faithful ports for the ChampSim 2024-12 module API now live under
# `external/ChampSim/prefetcher/{berti,ipcp,bingo,bop,pythia}/` and so
# are no longer EXTERNAL_ONLY for the purposes of this sweep — the
# variant binaries are produced from `build-configs/pref_<name>.json`.
EXTERNAL_ONLY_PREFETCHERS: set[str] = set()
EXTERNAL_ONLY_REPLACEMENTS = {"hawkeye", "mockingjay"}

DEFAULT_TRACE_GLOBS = ("*.champsimtrace.xz", "*.champsimtrace")

MODE_TO_SCHEMA = {
    "prefetch": "eliza.cache.champsim_prefetch_sweep.v1",
    "mockingjay-vs-lru": "eliza.cache.mockingjay_vs_lru.v1",
}
MODE_TO_EVIDENCE_NAME = {
    "prefetch": "champsim_prefetch_sweep_report.json",
    "mockingjay-vs-lru": "mockingjay_vs_lru_report.json",
}


def find_base_binary() -> str | None:
    for cand in (
        CHAMPSIM_BIN_DIR / "champsim",
        ROOT / "tools/bin/champsim",
    ):
        if cand.is_file() and os.access(cand, os.X_OK):
            return str(cand)
    return shutil.which("champsim")


def find_variant_binary(mode: str, variant: str) -> str | None:
    prefix = "champsim_pref_" if mode == "prefetch" else "champsim_repl_"
    cand = CHAMPSIM_BIN_DIR / f"{prefix}{variant}"
    if cand.is_file() and os.access(cand, os.X_OK):
        return str(cand)
    return None


def find_traces() -> list[Path]:
    for candidate in (
        ROOT / "external/dpc3-traces",
        ROOT / "external/ChampSim/traces",
        ROOT / "tools/dpc3-traces",
        Path(os.environ.get("DPC3_TRACE_DIR", "/dev/null")),
    ):
        if candidate.is_dir():
            entries: list[Path] = []
            for glob in DEFAULT_TRACE_GLOBS:
                entries.extend(sorted(candidate.glob(glob)))
            if entries:
                # Dedup + sort
                return sorted(set(entries))
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
            "Download DPC-3 traces to external/dpc3-traces/",
            f"Rerun: python3 scripts/champsim_sweep.py --mode {mode}",
        ],
        "target_evidence_path": (f"docs/evidence/cache/{MODE_TO_EVIDENCE_NAME[mode]}"),
    }
    path.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"ChampSim {mode} sweep BLOCKED ({reason}); wrote stub to {path}")


def run_one(
    binary: str,
    trace: Path,
    warmup: int,
    sim: int,
    log_dir: Path,
    label: str,
) -> dict:
    json_path = log_dir / f"{label}__{trace.stem}.json"
    log_path = log_dir / f"{label}__{trace.stem}.log"
    cmd = [
        binary,
        "--warmup-instructions",
        str(warmup),
        "--simulation-instructions",
        str(sim),
        "--hide-heartbeat",
        "--json",
        str(json_path),
        str(trace),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=3600)
    log_path.write_text(
        f"$ {' '.join(cmd)}\n--- STDOUT ---\n{proc.stdout}\n--- STDERR ---\n{proc.stderr}\n"
    )
    stats = parse_champsim_json(json_path)
    return {
        "trace": trace.name,
        "label": label,
        "binary": binary,
        "returncode": proc.returncode,
        "warmup_instructions": warmup,
        "simulation_instructions": sim,
        "json_path": str(json_path.relative_to(ROOT)) if json_path.exists() else None,
        "log_path": str(log_path.relative_to(ROOT)),
        **stats,
    }


def parse_champsim_json(json_path: Path) -> dict:
    if not json_path.is_file():
        return {"parsed": False, "parse_reason": "missing_json"}
    try:
        data = json.loads(json_path.read_text())
    except json.JSONDecodeError as e:
        return {"parsed": False, "parse_reason": f"json_decode_error:{e}"}
    if not isinstance(data, list) or not data:
        return {"parsed": False, "parse_reason": "unexpected_shape"}
    run = data[0]
    sim_block = run.get("sim", {}) or {}
    cores = sim_block.get("cores", []) or []
    if not cores:
        return {"parsed": False, "parse_reason": "no_cores"}
    core0 = cores[0]
    instrs = core0.get("instructions")
    cycles = core0.get("cycles")
    ipc = None
    if isinstance(instrs, int) and isinstance(cycles, int) and cycles > 0:
        ipc = float(instrs) / float(cycles)

    # ChampSim 2024-12 emits cache-level stats at sim.LLC / sim.cpu0_L2C /
    # sim.cpu0_L1D as `{LOAD: {hit: [n], miss: [n]}, RFO: ..., ...}` —
    # one element per CPU. Aggregate across access types + CPUs.
    def _sum_cache_block(cache: dict) -> dict[str, int]:
        total_hit = 0
        total_miss = 0
        for kind in ("LOAD", "RFO", "PREFETCH", "WRITE", "TRANSLATION"):
            block = cache.get(kind)
            if not isinstance(block, dict):
                continue
            hits = block.get("hit") or []
            misses = block.get("miss") or []
            if isinstance(hits, list):
                total_hit += sum(int(x) for x in hits)
            elif isinstance(hits, int):
                total_hit += hits
            if isinstance(misses, list):
                total_miss += sum(int(x) for x in misses)
            elif isinstance(misses, int):
                total_miss += misses
        return {
            "hit": total_hit,
            "miss": total_miss,
            "access": total_hit + total_miss,
        }

    llc_stats: dict[str, int] = {}
    l2c_stats: dict[str, int] = {}
    l1d_stats: dict[str, int] = {}
    llc = sim_block.get("LLC")
    if isinstance(llc, dict):
        llc_stats = _sum_cache_block(llc)
    l2c = sim_block.get("cpu0_L2C")
    if isinstance(l2c, dict):
        l2c_stats = _sum_cache_block(l2c)
    l1d = sim_block.get("cpu0_L1D")
    if isinstance(l1d, dict):
        l1d_stats = _sum_cache_block(l1d)

    llc_mpki = None
    if instrs and llc_stats.get("miss") is not None:
        llc_mpki = 1000.0 * float(llc_stats["miss"]) / float(instrs)
    l2c_mpki = None
    if instrs and l2c_stats.get("miss") is not None:
        l2c_mpki = 1000.0 * float(l2c_stats["miss"]) / float(instrs)
    return {
        "parsed": True,
        "ipc": ipc,
        "instructions": instrs,
        "cycles": cycles,
        "llc": llc_stats,
        "l2c": l2c_stats,
        "l1d": l1d_stats,
        "llc_mpki": llc_mpki,
        "l2c_mpki": l2c_mpki,
    }


def aggregate(results: list[dict], group_by: str) -> dict[str, dict[str, Any]]:
    by_label: dict[str, dict[str, Any]] = {}
    for r in results:
        label = r[group_by]
        agg = by_label.setdefault(
            label,
            {
                "runs": 0,
                "parsed_runs": 0,
                "sum_ipc": 0.0,
                "sum_llc_mpki": 0.0,
                "sum_l2c_mpki": 0.0,
                "trace_count": set(),
            },
        )
        agg["runs"] += 1
        agg["trace_count"].add(r["trace"])
        if r.get("parsed") and r.get("ipc") is not None:
            agg["parsed_runs"] += 1
            agg["sum_ipc"] += float(r["ipc"])
            if r.get("llc_mpki") is not None:
                agg["sum_llc_mpki"] += float(r["llc_mpki"])
            if r.get("l2c_mpki") is not None:
                agg["sum_l2c_mpki"] += float(r["l2c_mpki"])
    out: dict[str, dict[str, Any]] = {}
    for label, a in by_label.items():
        n = max(a["parsed_runs"], 1)
        out[label] = {
            "runs": a["runs"],
            "parsed_runs": a["parsed_runs"],
            "trace_count": len(a["trace_count"]),
            "mean_ipc": a["sum_ipc"] / n if a["parsed_runs"] else None,
            "mean_llc_mpki": a["sum_llc_mpki"] / n if a["parsed_runs"] else None,
            "mean_l2c_mpki": a["sum_l2c_mpki"] / n if a["parsed_runs"] else None,
        }
    return out


def real_sweep(mode: str, traces: list[Path], warmup: int, sim: int, log_dir: Path) -> dict:
    log_dir.mkdir(parents=True, exist_ok=True)
    results: list[dict] = []
    missing: list[str] = []

    variants: tuple[str, ...]
    if mode == "prefetch":
        variants = PREFETCH_SWEEP_PREFETCHERS
        external_only = EXTERNAL_ONLY_PREFETCHERS
    else:
        variants = MOCKINGJAY_SWEEP_REPLACEMENTS
        external_only = EXTERNAL_ONLY_REPLACEMENTS

    for variant in variants:
        binary = find_variant_binary(mode, variant)
        if binary is None:
            note = "external_only" if variant in external_only else "binary_missing"
            print(
                f"[champsim_sweep] {mode}:{variant} -> SKIP ({note}); "
                "build a variant binary if you want this row."
            )
            missing.append(variant)
            continue
        for trace in traces:
            print(f"[champsim_sweep] running {variant} on {trace.name}")
            res = run_one(binary, trace, warmup, sim, log_dir, variant)
            results.append(res)

    grouped = aggregate(results, group_by="label")
    payload: dict[str, Any] = {
        "schema": MODE_TO_SCHEMA[mode],
        "status": "ok" if results else "blocked",
        "mode": mode,
        "evidence_class": "champsim_dpc3_traces_only",
        "captured_utc": dt.datetime.now(dt.UTC).isoformat(),
        "champsim_bin_dir": str(CHAMPSIM_BIN_DIR.relative_to(ROOT)),
        "trace_count": len(traces),
        "trace_files": [t.name for t in traces],
        "warmup_instructions": warmup,
        "simulation_instructions": sim,
        "variants_requested": list(variants),
        "variants_missing": missing,
        "results": results,
        "aggregate": grouped,
    }
    if mode == "mockingjay-vs-lru":
        # Derive the LRU-vs-best-other-variant IPC delta for the gate.
        lru = grouped.get("lru")
        deltas: dict[str, dict[str, float | None]] = {}
        if lru and lru.get("mean_ipc") is not None:
            base = lru["mean_ipc"]
            for variant, agg in grouped.items():
                if variant == "lru" or agg.get("mean_ipc") is None:
                    continue
                deltas[variant] = {
                    "mean_ipc": agg["mean_ipc"],
                    "ipc_delta_pct": 100.0 * (agg["mean_ipc"] - base) / base,
                    "llc_mpki_delta_pct": (
                        100.0 * (agg["mean_llc_mpki"] - lru["mean_llc_mpki"]) / lru["mean_llc_mpki"]
                    )
                    if (lru.get("mean_llc_mpki") and agg.get("mean_llc_mpki") is not None)
                    else None,
                }
        payload["lru_vs_others"] = {
            "lru_mean_ipc": lru.get("mean_ipc") if lru else None,
            "lru_mean_llc_mpki": lru.get("mean_llc_mpki") if lru else None,
            "deltas": deltas,
        }
    return payload


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--mode",
        choices=tuple(MODE_TO_SCHEMA.keys()),
        default="prefetch",
        help="Which sweep to run (default: prefetch)",
    )
    ap.add_argument(
        "--traces",
        default=None,
        help="Override trace directory (defaults to external/dpc3-traces/)",
    )
    ap.add_argument(
        "--warmup",
        type=int,
        default=10_000_000,
        help="Warmup instructions per run (default: 10M)",
    )
    ap.add_argument(
        "--sim",
        type=int,
        default=10_000_000,
        help="Simulation instructions per run (default: 10M)",
    )
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
    log_dir = ROOT / f"build/reports/cache/champsim_{args.mode}_logs"

    if args.blocked_evidence:
        write_blocked_stub(blocked, args.mode, "blocked_evidence_forced")
        return 0

    out_path = Path(args.output) if args.output else (evidence if args.commit_evidence else scratch)

    base = find_base_binary()
    if base is None:
        write_blocked_stub(blocked, args.mode, "champsim_binary_missing")
        return 0

    if args.traces:
        trace_dir = Path(args.traces)
        traces: list[Path] = []
        for glob in DEFAULT_TRACE_GLOBS:
            traces.extend(sorted(trace_dir.glob(glob)))
        traces = sorted(set(traces))
    else:
        traces = find_traces()
    if not traces:
        write_blocked_stub(blocked, args.mode, "champsim_traces_missing")
        return 0

    artifact = real_sweep(args.mode, traces, args.warmup, args.sim, log_dir)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(artifact, indent=2) + "\n")
    print(
        f"ChampSim {args.mode} sweep complete; "
        f"{len(artifact['results'])} runs across "
        f"{len(artifact['variants_requested'])} variants"
    )
    print(f"  evidence: {out_path}")
    if artifact.get("variants_missing"):
        print(f"  missing variants: {artifact['variants_missing']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
