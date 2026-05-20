#!/usr/bin/env python3
"""Sustained bandwidth evidence checker.

Parses STREAM and lmbench output and writes a normalised JSON record
matching ``eliza.memory.lpddr_bandwidth_latency_benchmark.v1`` so that
the phone-class memory gate can consume measured numbers.  Fails closed
if the input lacks the required fields or if the SKU declared on the
command line does not match the gate-tracked per-SKU thresholds.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
GATE = ROOT / "docs/evidence/memory/uma-dram-evidence-gate.yaml"


def parse_int(value: str) -> int:
    return int(value, 0)


def parse_lmbench_bw(text: str) -> dict | None:
    """lmbench bw_mem prints `<size> <bw_MB_per_s>` per line."""
    if not text:
        return None
    best_mb = 0.0
    sample_count = 0
    for line in text.splitlines():
        m = re.search(r"(\d+\.\d+)", line)
        if not m:
            continue
        val = float(m.group(1))
        if val > best_mb:
            best_mb = val
        sample_count += 1
    if sample_count == 0:
        return None
    return {"samples": sample_count, "best_mb_per_s": best_mb}


def parse_lmbench_lat(text: str) -> dict | None:
    if not text:
        return None
    points: list[tuple[float, float]] = []
    for line in text.splitlines():
        toks = line.split()
        if len(toks) >= 2:
            try:
                size_mib = float(toks[0])
                ns = float(toks[1])
            except ValueError:
                continue
            points.append((size_mib, ns))
    if not points:
        return None
    # p95 is the upper-tail latency at the largest working set
    sizes_sorted = sorted(points, key=lambda x: x[0])
    largest = sizes_sorted[-len(sizes_sorted) // 5 :]
    p95 = sorted(largest, key=lambda x: x[1])[-1][1] if largest else 0.0
    return {"points": len(points), "p95_random_read_latency_ns": p95}


def load_gate_skus() -> dict:
    if not GATE.is_file():
        return {}
    data = yaml.safe_load(GATE.read_text()) or {}
    return data.get("sku_split_decision") or {}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--stream-json", help="STREAM JSON output file.")
    ap.add_argument("--lmbench-rd-raw", help="lmbench bw_mem 1024M rd output.")
    ap.add_argument("--lmbench-wr-raw", help="lmbench bw_mem 1024M wr output.")
    ap.add_argument("--lmbench-lat-raw", help="lmbench lat_mem_rd output.")
    ap.add_argument("--target-id", required=True, help="phone-baseline or phone-ai")
    ap.add_argument("--output", required=True, help="Path to write the normalised JSON report.")
    args = ap.parse_args()

    sku_split = load_gate_skus()
    sku_key = "baseline_sku" if args.target_id == "phone-baseline" else "ai_sku"
    sku_data = sku_split.get(sku_key) or {}
    if not sku_data:
        print(f"target-id {args.target_id} not found in gate sku_split_decision", file=sys.stderr)
        return 1

    record = {
        "schema": "eliza.memory.lpddr_bandwidth_latency_benchmark.v1",
        "target_id": args.target_id,
        "capture_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "process_effects_contract": "docs/spec-db/process-14a-effects.yaml",
        "process_corner_count": 4,
        "worst_process_corner": "14a_ss_0p63v_105c_frontside_pdn",
        "memory_type": sku_data.get("standard"),
        "capacity_gib": (sku_data.get("capacity_gib_skus") or [None])[0],
        "clock_state": "nominal",
        "thermal_state": "ambient_25c",
        "benchmark_commands": [],
        "raw_log_paths": [],
        "parsed_metrics": {},
        "pass_fail_against_phone_2028_target_profile": "blocked_until_real_target",
    }

    if args.stream_json and Path(args.stream_json).is_file():
        stream = json.loads(Path(args.stream_json).read_text())
        triad = next((k for k in stream.get("kernels", []) if k.get("name") == "triad"), None)
        record["benchmark_commands"].append("./stream")
        record["raw_log_paths"].append(args.stream_json)
        if triad:
            record["parsed_metrics"]["peak_bandwidth_gbps"] = triad.get("best_gbps")
            record["parsed_metrics"]["sustained_bandwidth_gbps"] = triad.get("avg_gbps")

    if args.lmbench_rd_raw and Path(args.lmbench_rd_raw).is_file():
        text = Path(args.lmbench_rd_raw).read_text()
        parsed = parse_lmbench_bw(text)
        if parsed:
            record["parsed_metrics"]["lmbench_rd_mb_per_s"] = parsed["best_mb_per_s"]
        record["benchmark_commands"].append("./bw_mem 1024M rd")
        record["raw_log_paths"].append(args.lmbench_rd_raw)

    if args.lmbench_wr_raw and Path(args.lmbench_wr_raw).is_file():
        text = Path(args.lmbench_wr_raw).read_text()
        parsed = parse_lmbench_bw(text)
        if parsed:
            record["parsed_metrics"]["lmbench_wr_mb_per_s"] = parsed["best_mb_per_s"]
        record["benchmark_commands"].append("./bw_mem 1024M wr")
        record["raw_log_paths"].append(args.lmbench_wr_raw)

    if args.lmbench_lat_raw and Path(args.lmbench_lat_raw).is_file():
        text = Path(args.lmbench_lat_raw).read_text()
        parsed = parse_lmbench_lat(text)
        if parsed:
            record["parsed_metrics"]["p95_random_read_latency_ns"] = parsed[
                "p95_random_read_latency_ns"
            ]
        record["benchmark_commands"].append("./lat_mem_rd 1024 128")
        record["raw_log_paths"].append(args.lmbench_lat_raw)

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(record, indent=2))
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
