#!/usr/bin/env python3
"""Sustained bandwidth evidence checker.

Parses STREAM and lmbench output and writes a normalised parser-output
JSON record.  This intentionally uses a distinct schema from real target
memory evidence so parser dry-runs cannot be misclassified as release
evidence.  Fails closed if the input lacks the required fields or if the
SKU declared on the command line does not match gate-tracked thresholds.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
GATE = ROOT / "docs/evidence/memory/uma-dram-evidence-gate.yaml"
FALSE_CLAIM_FLAGS = {
    "release_claim_allowed": False,
    "phone_memory_claim_allowed": False,
    "real_target_memory_claim_allowed": False,
    "contended_bandwidth_claim_allowed": False,
}


def parse_int(value: str) -> int:
    return int(value, 0)


def parse_lmbench_bw(text: str) -> dict | None:
    """lmbench bw_mem prints `<size> <bw_MB_per_s>` per line."""
    if not text:
        return None
    best_mb = 0.0
    sample_count = 0
    for line in text.splitlines():
        values = re.findall(r"[-+]?(?:\d+\.\d+|\d+)", line)
        if len(values) < 2:
            continue
        val = float(values[1])
        if val > best_mb:
            best_mb = val
        sample_count += 1
    if sample_count == 0:
        return None
    return {"samples": sample_count, "best_mb_per_s": best_mb}


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


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
    return {
        "phone_2028_target_profile": data.get("phone_2028_target_profile") or {},
        "sku_split_decision": data.get("sku_split_decision") or {},
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--stream-json", help="STREAM JSON output file.")
    ap.add_argument("--lmbench-rd-raw", help="lmbench bw_mem 1024M rd output.")
    ap.add_argument("--lmbench-wr-raw", help="lmbench bw_mem 1024M wr output.")
    ap.add_argument("--lmbench-lat-raw", help="lmbench lat_mem_rd output.")
    ap.add_argument("--target-id", required=True, help="phone-baseline or phone-ai")
    ap.add_argument("--output", required=True, help="Path to write the normalised JSON report.")
    args = ap.parse_args()

    gate_data = load_gate_skus()
    sku_split = gate_data.get("sku_split_decision") or {}
    target_skus = {
        "phone-baseline": "baseline_sku",
        "phone-ai": "ai_sku",
    }
    sku_key = target_skus.get(args.target_id)
    if sku_key is None:
        print(f"target-id {args.target_id} is not supported", file=sys.stderr)
        return 1
    sku_data = sku_split.get(sku_key) or {}
    if not sku_data:
        print(f"target-id {args.target_id} not found in gate sku_split_decision", file=sys.stderr)
        return 1
    target_profile = gate_data.get("phone_2028_target_profile") or {}
    external_memory = target_profile.get("external_memory") or {}

    record = {
        "schema": "eliza.memory.bandwidth_latency_threshold_parser.v1",
        "evidence_class": "threshold_parser_output",
        "claim_boundary": (
            "Parser output only. This is not release evidence unless target identity, "
            "real-target raw artifacts, contention workload, and process-contract hashes "
            "also satisfy the memory evidence template validator."
        ),
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
        "raw_artifacts": [],
        "parsed_metrics": {},
        "pass_fail_against_phone_2028_target_profile": {
            "capacity_gib_min_12": "downgraded",
            "peak_bandwidth_gbps_min_180": "downgraded",
            "sustained_bandwidth_gbps_min_120": "downgraded",
            "p95_random_read_latency_ns_max_120": "downgraded",
            "contended_trace_present": "downgraded",
            "overall": "downgraded",
        },
        "target_thresholds_status": "blocked_until_parse",
        "release_claim_allowed": False,
        "false_claim_flags": FALSE_CLAIM_FLAGS,
    }
    process_contract = ROOT / "docs/spec-db/process-14a-effects.yaml"
    process_sha = sha256_file(process_contract) if process_contract.is_file() else None
    record["target"] = {
        "target_id": args.target_id,
        "target_kind": "unspecified_target",
        "is_host": None,
        "is_simulator": None,
        "capture_utc": record["capture_utc"],
    }
    record["process_corners"] = {
        "process_effects_contract": {
            "path": "docs/spec-db/process-14a-effects.yaml",
            "sha256": process_sha,
        },
        "process_corner_count": record["process_corner_count"],
        "worst_process_corner": record["worst_process_corner"],
        "pdk_signoff_claim": "none",
    }
    record["memory_config"] = {
        "memory_type": record["memory_type"],
        "capacity_gib": record["capacity_gib"],
    }
    record["runtime_state"] = {
        "clock_state": record["clock_state"],
        "thermal_state": record["thermal_state"],
    }

    def add_raw_artifact(path_text: str) -> None:
        path = Path(path_text)
        raw_path = path if path.is_absolute() else ROOT / path
        artifact_path = path_text
        try:
            artifact_path = str(raw_path.resolve().relative_to(ROOT.resolve()))
        except ValueError:
            artifact_path = str(path)
        entry = {"path": artifact_path}
        if raw_path.is_file():
            entry["sha256"] = sha256_file(raw_path)
        record["raw_artifacts"].append(entry)

    if args.stream_json and Path(args.stream_json).is_file():
        stream = json.loads(Path(args.stream_json).read_text())
        triad = next((k for k in stream.get("kernels", []) if k.get("name") == "triad"), None)
        record["benchmark_commands"].append("./stream")
        record["raw_log_paths"].append(args.stream_json)
        add_raw_artifact(args.stream_json)
        if triad:
            record["parsed_metrics"]["peak_bandwidth_gbps"] = triad.get("best_gbps")
            record["parsed_metrics"]["sustained_bandwidth_gbps"] = triad.get("avg_gbps")

    missing: list[str] = []

    if args.lmbench_rd_raw and Path(args.lmbench_rd_raw).is_file():
        text = Path(args.lmbench_rd_raw).read_text()
        parsed = parse_lmbench_bw(text)
        if parsed:
            record["parsed_metrics"]["lmbench_rd_mb_per_s"] = parsed["best_mb_per_s"]
        else:
            missing.append("lmbench_rd_mb_per_s")
        record["benchmark_commands"].append("./bw_mem 1024M rd")
        record["raw_log_paths"].append(args.lmbench_rd_raw)
        add_raw_artifact(args.lmbench_rd_raw)
    elif args.lmbench_rd_raw:
        missing.append("lmbench_rd_raw")

    if args.lmbench_wr_raw and Path(args.lmbench_wr_raw).is_file():
        text = Path(args.lmbench_wr_raw).read_text()
        parsed = parse_lmbench_bw(text)
        if parsed:
            record["parsed_metrics"]["lmbench_wr_mb_per_s"] = parsed["best_mb_per_s"]
        else:
            missing.append("lmbench_wr_mb_per_s")
        record["benchmark_commands"].append("./bw_mem 1024M wr")
        record["raw_log_paths"].append(args.lmbench_wr_raw)
        add_raw_artifact(args.lmbench_wr_raw)
    elif args.lmbench_wr_raw:
        missing.append("lmbench_wr_raw")

    if args.lmbench_lat_raw and Path(args.lmbench_lat_raw).is_file():
        text = Path(args.lmbench_lat_raw).read_text()
        parsed = parse_lmbench_lat(text)
        if parsed:
            record["parsed_metrics"]["p95_random_read_latency_ns"] = parsed[
                "p95_random_read_latency_ns"
            ]
        else:
            missing.append("p95_random_read_latency_ns")
        record["benchmark_commands"].append("./lat_mem_rd 1024 128")
        record["raw_log_paths"].append(args.lmbench_lat_raw)
        add_raw_artifact(args.lmbench_lat_raw)
    elif args.lmbench_lat_raw:
        missing.append("lmbench_lat_raw")

    required_metrics = {
        "peak_bandwidth_gbps",
        "sustained_bandwidth_gbps",
        "lmbench_rd_mb_per_s",
        "lmbench_wr_mb_per_s",
        "p95_random_read_latency_ns",
    }
    missing.extend(sorted(required_metrics - set(record["parsed_metrics"])))
    for metric in sorted(required_metrics & set(record["parsed_metrics"])):
        value = record["parsed_metrics"].get(metric)
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            missing.append(metric)
    if not record["raw_log_paths"]:
        missing.append("raw_log_paths")
    threshold_failures: list[str] = []
    metrics = record["parsed_metrics"]
    peak_min = external_memory.get("peak_bandwidth_gbps_min")
    sustained_min = external_memory.get("sustained_bandwidth_gbps_min")
    latency_max = external_memory.get("p95_random_read_latency_ns_max")
    capacity_min = external_memory.get("capacity_gib_min")
    pass_fail = {
        "capacity_gib_min_12": "blocked",
        "peak_bandwidth_gbps_min_180": "blocked",
        "sustained_bandwidth_gbps_min_120": "blocked",
        "p95_random_read_latency_ns_max_120": "blocked",
        "contended_trace_present": "downgraded",
        "overall": "downgraded",
    }
    record["sku_threshold_context"] = {
        "sku_peak_bandwidth_gbps": sku_data.get("peak_bandwidth_gbps"),
        "sku_sustained_target_gbps_min": sku_data.get("sustained_target_gbps_min"),
        "phone_profile_peak_bandwidth_gbps_min": external_memory.get("peak_bandwidth_gbps_min"),
        "phone_profile_sustained_bandwidth_gbps_min": external_memory.get(
            "sustained_bandwidth_gbps_min"
        ),
    }
    target_downgrades: list[str] = []
    if not missing:
        if isinstance(capacity_min, (int, float)) and record["capacity_gib"] < capacity_min:
            pass_fail["capacity_gib_min_12"] = "fail"
            threshold_failures.append(
                f"capacity_gib {record['capacity_gib']} < target {capacity_min}"
            )
        else:
            pass_fail["capacity_gib_min_12"] = "pass"
        sku_peak = sku_data.get("peak_bandwidth_gbps")
        if isinstance(peak_min, (int, float)):
            if metrics["peak_bandwidth_gbps"] >= peak_min:
                pass_fail["peak_bandwidth_gbps_min_180"] = "pass"
            elif (
                isinstance(sku_peak, (int, float))
                and sku_peak < peak_min
                and metrics["peak_bandwidth_gbps"] >= sku_peak
            ):
                pass_fail["peak_bandwidth_gbps_min_180"] = "downgraded"
                target_downgrades.append(
                    "peak_bandwidth_gbps_min_180 exceeds declared SKU peak "
                    f"({peak_min} > {sku_peak})"
                )
            else:
                pass_fail["peak_bandwidth_gbps_min_180"] = "fail"
                threshold_failures.append(
                    f"peak_bandwidth_gbps {metrics['peak_bandwidth_gbps']} < target {peak_min}"
                )
        else:
            pass_fail["peak_bandwidth_gbps_min_180"] = "downgraded"
        sku_sustained_min = sku_data.get("sustained_target_gbps_min")
        if isinstance(sustained_min, (int, float)) and isinstance(sku_sustained_min, (int, float)):
            sustained_floor = max(sustained_min, sku_sustained_min)
            if metrics["sustained_bandwidth_gbps"] >= sustained_floor:
                pass_fail["sustained_bandwidth_gbps_min_120"] = "pass"
            elif (
                sku_sustained_min < sustained_min
                and metrics["sustained_bandwidth_gbps"] >= sku_sustained_min
            ):
                pass_fail["sustained_bandwidth_gbps_min_120"] = "downgraded"
                target_downgrades.append(
                    "sustained_bandwidth_gbps_min_120 exceeds declared SKU sustained target "
                    f"({sustained_min} > {sku_sustained_min})"
                )
            else:
                pass_fail["sustained_bandwidth_gbps_min_120"] = "fail"
                threshold_failures.append(
                    "sustained_bandwidth_gbps "
                    f"{metrics['sustained_bandwidth_gbps']} < required {sustained_floor}"
                )
        elif (
            isinstance(sustained_min, (int, float))
            and metrics["sustained_bandwidth_gbps"] < sustained_min
        ):
            pass_fail["sustained_bandwidth_gbps_min_120"] = "fail"
            threshold_failures.append(
                "sustained_bandwidth_gbps "
                f"{metrics['sustained_bandwidth_gbps']} < target {sustained_min}"
            )
        else:
            pass_fail["sustained_bandwidth_gbps_min_120"] = "pass"
        if (
            isinstance(latency_max, (int, float))
            and metrics["p95_random_read_latency_ns"] > latency_max
        ):
            pass_fail["p95_random_read_latency_ns_max_120"] = "fail"
            threshold_failures.append(
                f"p95_random_read_latency_ns {metrics['p95_random_read_latency_ns']} > target {latency_max}"
            )
        else:
            pass_fail["p95_random_read_latency_ns_max_120"] = "pass"

    if target_downgrades:
        record["target_downgrades"] = target_downgrades

    if missing or threshold_failures:
        if threshold_failures:
            pass_fail["overall"] = "fail"
            record["pass_fail_against_phone_2028_target_profile"] = pass_fail
            record["target_thresholds_status"] = "fail"
            record["threshold_failures"] = threshold_failures
            out = Path(args.output)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(json.dumps(record, indent=2))
            print(
                "STATUS: BLOCKED memory.lmbench - metrics below target thresholds: "
                + "; ".join(threshold_failures),
                file=sys.stderr,
            )
            return 2
        print(
            "STATUS: BLOCKED memory.lmbench - missing or unparseable required metrics: "
            + ", ".join(sorted(set(missing))),
            file=sys.stderr,
        )
        return 2
    # Parser-only reports can show that parsed metrics meet simple thresholds,
    # but they are still not complete phone memory evidence without real target
    # identity and contention/QoS traces.
    pass_fail["overall"] = "downgraded"
    record["pass_fail_against_phone_2028_target_profile"] = pass_fail
    record["target_thresholds_status"] = "downgraded" if target_downgrades else "pass"

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(record, indent=2))
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
