#!/usr/bin/env python3
"""Convert a bounded OpenABC-D BENCH sample into internal graph records."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_BENCH_DIR = ROOT / "external/datasets/openabc-d/payload/bench_openabcd"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/openabc_d"
CLAIM_BOUNDARY = "openabc_d_conversion_training_only_no_e1_signoff_or_release_claim"

ASSIGNMENT_RE = re.compile(r"^([A-Za-z0-9_.$\\[\\]-]+)\s*=\s*([A-Za-z0-9_.$]+)\((.*)\)$")
PINNED_REVISION = "ecd7dde67740556eaf842ccab4dc941c348ad8f6"


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_id(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", value)


def split_args(raw: str) -> list[str]:
    return [item.strip() for item in raw.split(",") if item.strip()]


def parse_bench(path: Path) -> dict[str, Any]:
    inputs: list[str] = []
    outputs: list[str] = []
    assignments: list[dict[str, Any]] = []
    gate_histogram: Counter[str] = Counter()
    signal_refs: Counter[str] = Counter()

    for raw_line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if not line:
            continue
        if line.startswith("INPUT(") and line.endswith(")"):
            signal = line.removeprefix("INPUT(").removesuffix(")").strip()
            inputs.append(signal)
            continue
        if line.startswith("OUTPUT(") and line.endswith(")"):
            signal = line.removeprefix("OUTPUT(").removesuffix(")").strip()
            outputs.append(signal)
            continue
        match = ASSIGNMENT_RE.match(line)
        if not match:
            continue
        dst, gate, raw_args = match.groups()
        args = split_args(raw_args)
        gate_upper = gate.upper()
        gate_histogram[gate_upper] += 1
        for arg in args:
            signal_refs[arg] += 1
        assignments.append({"dst": dst, "gate": gate_upper, "args": args})

    node_features: list[dict[str, Any]] = []
    for signal in sorted(set(inputs)):
        node_features.append(
            {
                "id": signal,
                "node_type": "primary_input",
                "fanout": signal_refs.get(signal, 0),
            }
        )
    assigned_outputs = {item["dst"] for item in assignments}
    output_set = set(outputs)
    for item in assignments:
        node_features.append(
            {
                "id": item["dst"],
                "node_type": "logic_gate",
                "gate_type": item["gate"],
                "fanin": len(item["args"]),
                "fanout": signal_refs.get(item["dst"], 0) + (1 if item["dst"] in output_set else 0),
                "is_primary_output": item["dst"] in output_set,
            }
        )
    for signal in sorted(output_set - assigned_outputs):
        node_features.append(
            {
                "id": signal,
                "node_type": "primary_output_alias",
                "fanin": 1 if signal in signal_refs else 0,
                "fanout": 0,
                "is_primary_output": True,
            }
        )

    edge_features: list[dict[str, Any]] = []
    for item in assignments:
        for index, src in enumerate(item["args"]):
            edge_features.append(
                {
                    "src": src,
                    "dst": item["dst"],
                    "edge_type": "bench_logic_fanin",
                    "pin_index": index,
                    "dst_gate": item["gate"],
                }
            )

    return {
        "inputs": inputs,
        "outputs": outputs,
        "assignments": assignments,
        "node_features": node_features,
        "edge_features": edge_features,
        "gate_histogram": dict(gate_histogram.most_common()),
    }


def write_json(out_dir: Path, record: dict[str, Any]) -> Path:
    out_path = out_dir / f"{record['id']}.json"
    out_path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return out_path


def convert_bench(path: Path, out_dir: Path) -> list[dict[str, Any]]:
    design_name = path.stem.removesuffix("_orig")
    record_prefix = f"openabc-d-{safe_id(design_name)}"
    parsed = parse_bench(path)
    source = {"path": rel(path), "sha256": sha256_file(path)}
    design_bundle = {
        "schema": "eda.design_bundle.v1",
        "id": f"{record_prefix}-design-bundle",
        "claim_boundary": CLAIM_BOUNDARY,
        "design": {
            "name": design_name,
            "revision": PINNED_REVISION,
            "top_module": design_name,
        },
        "sources": {
            "rtl": [],
            "netlists": [source],
            "manifests": ["external/datasets/openabc-d/manifest.yaml"],
        },
        "constraints": {"clocks": [], "resets": []},
        "technology": {
            "node": "openabc_d_public_bench_logic_network",
            "pdk": "none_bench_boolean_network",
            "flow": "OpenABC-D",
        },
    }
    graph_sample = {
        "schema": "eda.graph_sample.v1",
        "id": f"{record_prefix}-logic-graph",
        "design_bundle_id": design_bundle["id"],
        "claim_boundary": CLAIM_BOUNDARY,
        "graph": {
            "node_features": parsed["node_features"],
            "edge_features": parsed["edge_features"],
            "coordinate_system": "openabc_d_bench_boolean_network_no_physical_coordinates",
        },
        "labels": {
            "label_status": "public_openabc_d_logic_network_training_only_not_e1_signoff",
            "label_sources": [source],
            "values": {
                "input_count": len(parsed["inputs"]),
                "output_count": len(parsed["outputs"]),
                "logic_gate_count": len(parsed["assignments"]),
                "edge_count": len(parsed["edge_features"]),
                "gate_histogram": parsed["gate_histogram"],
            },
        },
        "provenance": {
            "generated_by": "scripts/ai_eda/convert_openabc_d_to_internal_records.py",
            "source_records": [source],
        },
    }
    flow_run = {
        "schema": "eda.flow_run.v1",
        "id": f"{record_prefix}-flow-run",
        "design_bundle_id": design_bundle["id"],
        "claim_boundary": CLAIM_BOUNDARY,
        "toolchain": {"tools": ["OpenABC-D public BENCH export"], "version_capture": "external/datasets/openabc-d/manifest.yaml"},
        "command": "python3 scripts/ai_eda/convert_openabc_d_to_internal_records.py --run-id <run-id>",
        "inputs": {"bench": source},
        "outputs": {"reports": [], "artifacts": [source]},
        "metrics": {
            "input_count": len(parsed["inputs"]),
            "output_count": len(parsed["outputs"]),
            "logic_gate_count": len(parsed["assignments"]),
            "edge_count": len(parsed["edge_features"]),
            "gate_histogram": parsed["gate_histogram"],
        },
        "status": {
            "result": "CONVERTED_PUBLIC_LOGIC_NETWORK_NOT_REPLAYED",
            "blockers": [
                "public benchmark logic network is not local E1 synthesis evidence",
                "recipe labels still require OpenABC-D sequence extraction and leakage review",
                "release use requires deterministic E1 replay and equivalence checking",
            ],
        },
    }
    records = (design_bundle, graph_sample, flow_run)
    paths = [write_json(out_dir, record) for record in records]
    return [
        {
            "bench": rel(path),
            "schema": record["schema"],
            "json": rel(out_path),
            "logic_gate_count": len(parsed["assignments"]),
            "edge_count": len(parsed["edge_features"]),
        }
        for record, out_path in zip(records, paths)
    ]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bench-dir", type=Path, default=DEFAULT_BENCH_DIR)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--run-id", default=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--sample-limit", type=int, default=8)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.sample_limit <= 0:
        raise SystemExit("--sample-limit must be positive")
    if not args.bench_dir.exists():
        print(f"STATUS: BLOCKED ai_eda.openabc_d_conversion missing_bench_dir {args.bench_dir}")
        return 2
    benches = sorted(args.bench_dir.glob("*_orig.bench"))[: args.sample_limit]
    if not benches:
        print(f"STATUS: BLOCKED ai_eda.openabc_d_conversion no_bench_files {args.bench_dir}")
        return 2

    out_dir = args.out_root / args.run_id / "records"
    out_dir.mkdir(parents=True, exist_ok=True)
    converted: list[dict[str, Any]] = []
    for bench in benches:
        converted.extend(convert_bench(bench, out_dir))

    report = {
        "schema": "eliza.ai_eda.openabc_d_conversion_report.v1",
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "release_use_allowed": False,
        "bench_dir": rel(args.bench_dir),
        "available_bench_count": len(list(args.bench_dir.glob("*_orig.bench"))),
        "converted_bench_count": len(benches),
        "converted_record_count": len(converted),
        "converted_records": converted,
        "next_required_gates": [
            "extract OpenABC-D synthesis sequence labels into a separate recipe-ranking table",
            "partition benchmark families to prevent train/test leakage",
            "compare any learned recipe only through E1 Yosys/OpenROAD replay plus equivalence checks",
        ],
    }
    report_path = args.out_root / args.run_id / "conversion_report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "STATUS: PASS ai_eda.openabc_d_conversion "
        f"benches={len(benches)} records={len(converted)} {rel(report_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
