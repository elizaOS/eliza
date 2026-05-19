#!/usr/bin/env python3
"""MPKI evaluation harness for the Eliza E1 BPU.

Runs the behavioural :class:`BPUSimulator` against a set of named workloads
and writes a JSON evidence file under ``benchmarks/results/`` describing the
geometry, the per-workload MPKI, and which workloads were sourced from
synthetic generators versus real traces. The synthetic generators carry an
explicit ``trace_class`` field so any downstream report cannot accidentally
treat them as silicon evidence.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from benchmarks.cpu.branch.bpu_model import BPUSimulator, DEFAULT_GEOMETRY  # noqa: E402
from benchmarks.cpu.branch.traces import (  # noqa: E402
    SYNTHETIC_GENERATORS,
    read_cbp5,
    read_jsonl,
)

RESULTS_DIR = ROOT / "benchmarks/results"
DEFAULT_SYNTHETIC = list(SYNTHETIC_GENERATORS.keys())


def _eval_one(events_factory, instruction_count: int) -> dict:
    sim = BPUSimulator()
    n = 0
    for event in events_factory():
        sim.feed([event])
        n += 1
    return {
        "branches": n,
        "instruction_count_estimate": instruction_count,
        "mpki": sim.mpki(instruction_count),
        "counters": sim.stats(),
    }


def evaluate_synthetic(
    generators: Iterable[str],
    instructions_per_branch_estimate: int = 5,
) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for name in generators:
        gen = SYNTHETIC_GENERATORS[name]
        # Estimate instruction count by running the generator once and
        # multiplying by the per-branch instruction approximation.
        events = list(gen())
        instructions = len(events) * instructions_per_branch_estimate
        sim = BPUSimulator()
        sim.feed(events)
        out[name] = {
            "trace_class": "synthetic_planning_only",
            "branches": len(events),
            "instruction_count_estimate": instructions,
            "mpki": sim.mpki(instructions),
            "counters": sim.stats(),
        }
    return out


def evaluate_external(traces: list[Path]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for path in traces:
        ext = path.suffix.lower()
        if ext == ".bin":
            iterator = read_cbp5(path)
            cls = "cbp5_binary_real_workload"
        elif ext == ".jsonl":
            iterator = read_jsonl(path)
            cls = "jsonl_external_trace"
        else:
            raise ValueError(f"unsupported trace extension {ext} on {path}")
        sim = BPUSimulator()
        branches = 0
        for event in iterator:
            sim.feed([event])
            branches += 1
        out[path.stem] = {
            "trace_class": cls,
            "branches": branches,
            "instruction_count_estimate": branches * 5,
            "mpki": sim.mpki(branches * 5),
            "counters": sim.stats(),
        }
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--synthetic",
        nargs="*",
        default=DEFAULT_SYNTHETIC,
        help="synthetic workload names to evaluate (default: all)",
    )
    parser.add_argument(
        "--trace",
        type=Path,
        action="append",
        default=[],
        help="path to an external trace file (.bin CBP-5 or .jsonl)",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=RESULTS_DIR / "branch-prediction-mpki.json",
        help="evidence JSON output path",
    )
    parser.add_argument(
        "--print-only",
        action="store_true",
        help="emit JSON to stdout without writing to disk",
    )
    args = parser.parse_args()

    for name in args.synthetic:
        if name not in SYNTHETIC_GENERATORS:
            print(f"unknown synthetic generator: {name}", file=sys.stderr)
            return 2

    synthetic_results = evaluate_synthetic(args.synthetic)
    external_results = evaluate_external(args.trace)

    evidence = {
        "schema": "eliza.bpu_mpki_eval.v1",
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "geometry": {
            key: list(value) if isinstance(value, tuple) else value
            for key, value in DEFAULT_GEOMETRY.items()
        },
        "workloads": {
            "synthetic": synthetic_results,
            "external": external_results,
        },
        "claim_policy": {
            "synthetic_workloads_are_planning_only": True,
            "real_workload_claims_require_external_traces": True,
            "spec2017_claim": False,
            "android_claim": False,
            "v8_claim": False,
            "reason": (
                "Synthetic workloads exercise the BPU control paths but do not"
                " represent SPEC2017, AOSP, or JS-engine workloads. Real-MPKI"
                " claims remain blocked until external traces are ingested."
            ),
        },
    }

    if args.print_only:
        json.dump(evidence, sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write("\n")
    else:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
        print(f"eliza-evidence: status=PASS path={args.out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
