#!/usr/bin/env python3
"""Pointer-chase cache latency micro-benchmark harness.

Walks a randomized linked list through working sets that span L1 / L2 /
L3 / SLC / DRAM and reports the per-hop latency. The implementation is
intentionally small and pure Python so the methodology validation path
runs in seconds on any host. The Python timings are NOT silicon evidence;
they exist to:

- prove the JSON schema and evidence wiring,
- carry the methodology forward to a target benchmark (compiled C or
  RISC-V SBI binary on real silicon).

Phone-class pointer-chase claims remain BLOCKED until the same JSON
schema is produced from real silicon.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import random
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def build_chain(n_nodes: int, seed: int = 0xCAFE_BABE) -> list[int]:
    """Build a randomized cycle of indices over [0, n_nodes). Returns the
    `next` array; following it n_nodes times traverses every node exactly
    once before returning to the start."""
    rng = random.Random(seed)
    perm = list(range(n_nodes))
    rng.shuffle(perm)
    next_idx = [0] * n_nodes
    for i in range(n_nodes):
        next_idx[perm[i]] = perm[(i + 1) % n_nodes]
    return next_idx


def walk(chain: list[int], hops: int) -> float:
    """Walk the chain for `hops` steps, return wall-clock seconds."""
    pos = 0
    t0 = time.perf_counter_ns()
    for _ in range(hops):
        pos = chain[pos]
    t1 = time.perf_counter_ns()
    if pos == -1:
        # Force `pos` to live across the timer; prevents the compiler
        # eliminating the loop in a hypothetical optimized port.
        raise RuntimeError("unreachable")
    return (t1 - t0) / 1e9


def benchmark_one(set_bytes: int, hops: int) -> dict:
    n_nodes = max(1, set_bytes // 8)
    chain = build_chain(n_nodes)
    seconds = walk(chain, hops)
    return {
        "set_bytes": set_bytes,
        "node_count": n_nodes,
        "hops": hops,
        "seconds": seconds,
        "ns_per_hop": (seconds * 1e9) / hops,
    }


def build_artifact(measurements: list[dict], emit_stub: bool) -> dict:
    return {
        "schema": "eliza.cache.pointer_chase.v1",
        "status": (
            "methodology_stub_python" if emit_stub else "host_python_run_not_target_evidence"
        ),
        "captured_utc": dt.datetime.now(dt.UTC).isoformat(),
        "language": "python",
        "host": os.uname().sysname + "-" + os.uname().machine,
        "measurements": measurements,
        "claim_boundary": (
            "Python-host pointer-chase timings are methodology evidence "
            "only and bear no relationship to silicon cache latency. The "
            "phone-class latency curve is BLOCKED until the same schema is "
            "produced from compiled native code on the 2028 phone SoC."
        ),
        "next_unblock_steps": [
            "Port walker to native code (C or RISC-V baremetal)",
            "Run on target silicon with HW PMU counters captured",
            "Write artifact to docs/evidence/cache/pointer_chase_curve.json",
        ],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--output",
        default=None,
        help="Output JSON path",
    )
    ap.add_argument(
        "--emit-stub",
        action="store_true",
        help="Skip walks and emit only the methodology stub",
    )
    ap.add_argument(
        "--hops",
        type=int,
        default=1_000_000,
        help="Hops per working-set point (default 1M)",
    )
    args = ap.parse_args()

    out_dir = ROOT / "build/reports/cache"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = Path(args.output) if args.output else (out_dir / "pointer_chase_host.json")

    measurements: list[dict] = []
    if not args.emit_stub:
        working_sets = (1 * 1024, 32 * 1024, 256 * 1024, 4 * 1024 * 1024)
        for set_bytes in working_sets:
            measurements.append(benchmark_one(set_bytes, args.hops))

    artifact = build_artifact(measurements, emit_stub=args.emit_stub)
    out_path.write_text(json.dumps(artifact, indent=2) + "\n")
    print(f"pointer-chase artifact written to {out_path}")
    for row in measurements:
        print(f"  set={row['set_bytes']:>10} B  ns/hop={row['ns_per_hop']:.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
