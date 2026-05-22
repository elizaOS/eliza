#!/usr/bin/env python3
"""Convert FloorSet Lite validation tensors into normalized internal records."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
PAYLOAD = ROOT / "external/datasets/intel-floorset/payload"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/floorset_lite"
CLAIM_BOUNDARY = "floorset_lite_conversion_training_only_no_e1_signoff_or_release_claim"
REVISION = "a01137f8cb0406fcb1eef4a76e09445d95aab863"


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


def file_record(path: Path) -> dict[str, Any]:
    return {
        "path": rel(path),
        "exists": path.is_file(),
        "bytes": path.stat().st_size if path.is_file() else 0,
        "sha256": sha256_file(path) if path.is_file() else None,
    }


def safe_id(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-").lower()


def finite_float(value: Any) -> float:
    return float(value.item() if hasattr(value, "item") else value)


def tensor_shape(value: Any) -> list[int]:
    return [int(item) for item in getattr(value, "shape", [])]


def tensor_summary(value: Any) -> dict[str, Any]:
    flat = value.flatten()
    return {
        "shape": tensor_shape(value),
        "dtype": str(getattr(value, "dtype", "")),
        "min": finite_float(flat.min()) if flat.numel() else None,
        "max": finite_float(flat.max()) if flat.numel() else None,
        "mean": finite_float(flat.float().mean()) if flat.numel() else None,
    }


def load_case(data_path: Path, label_path: Path) -> tuple[list[Any], list[Any]]:
    try:
        import torch
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(
            "FloorSet conversion requires a Python environment with torch; "
            "use /opt/miniconda3/bin/python on this host."
        ) from exc
    data = torch.load(data_path, map_location="cpu")
    label = torch.load(label_path, map_location="cpu")
    if not isinstance(data, list) or len(data) != 1 or not isinstance(data[0], list):
        raise ValueError(f"{rel(data_path)}: unexpected data tensor bundle")
    if not isinstance(label, list) or len(label) != 1 or not isinstance(label[0], list):
        raise ValueError(f"{rel(label_path)}: unexpected label tensor bundle")
    return data[0], label[0]


def build_records(config_dir: Path, payload: Path, out_dir: Path) -> list[dict[str, Any]]:
    data_path = config_dir / "litedata_1.pth"
    label_path = config_dir / "litelabel_1.pth"
    data, label = load_case(data_path, label_path)
    if len(data) != 4 or len(label) != 2:
        raise ValueError(f"{rel(config_dir)}: expected 4 input tensors and 2 label tensors")
    block_features, b2b, p2b, pins = data
    metrics, solution = label
    block_count = int(block_features.shape[0])
    case_id = f"floorset-lite-{safe_id(config_dir.name)}"
    source_records = [
        file_record(data_path),
        file_record(label_path),
        file_record(payload / "README.md"),
        file_record(payload / "LICENSE"),
        file_record(payload / "iccad2026contest/README.md"),
    ]
    metrics_values = [finite_float(item) for item in metrics.flatten().tolist()]
    width_height_area = []
    for row in solution:
        xs = row[:, 0]
        ys = row[:, 1]
        width = finite_float(xs.max() - xs.min())
        height = finite_float(ys.max() - ys.min())
        width_height_area.append(width * height)
    design_bundle = {
        "schema": "eda.design_bundle.v1",
        "id": f"{case_id}-design-bundle",
        "claim_boundary": CLAIM_BOUNDARY,
        "design": {
            "name": config_dir.name,
            "revision": REVISION,
            "top_module": f"floorset_lite_{block_count}_block_floorplan",
        },
        "sources": {
            "rtl": [],
            "manifests": ["external/datasets/intel-floorset/manifest.yaml"],
            "floorplan_defs": [],
            "reference_docs": source_records[2:],
        },
        "constraints": {"clocks": [], "resets": []},
        "technology": {
            "node": "synthetic_floorplanning_tensor_benchmark",
            "pdk": "none_training_only",
            "flow": "Intel FloorSet LiteTensorDataTest validation subset",
        },
    }
    graph_sample = {
        "schema": "eda.graph_sample.v1",
        "id": f"{case_id}-constraint-graph",
        "design_bundle_id": design_bundle["id"],
        "claim_boundary": CLAIM_BOUNDARY,
        "graph": {
            "coordinate_system": "floorset_lite_tensor_coordinates_no_e1_coordinates",
            "node_features": [
                {
                    "id": "blocks",
                    "node_type": "floorset_lite_blocks_with_constraints",
                    "block_count": block_count,
                    "feature_shape": tensor_shape(block_features),
                    "target_area_sum": finite_float(block_features[:, 0].sum()),
                    "hard_constraint_count": int((block_features[:, 1:] != 0).sum().item()),
                },
                {
                    "id": "b2b_connectivity",
                    "node_type": "weighted_block_to_block_connectivity",
                    "edge_count": int(b2b.shape[0]),
                    "shape": tensor_shape(b2b),
                },
                {
                    "id": "p2b_connectivity",
                    "node_type": "weighted_pin_to_block_connectivity",
                    "edge_count": int(p2b.shape[0]),
                    "shape": tensor_shape(p2b),
                },
                {
                    "id": "pins",
                    "node_type": "external_pin_positions",
                    "pin_count": int(pins.shape[0]),
                    "shape": tensor_shape(pins),
                },
            ],
            "edge_features": [
                {
                    "src": "blocks",
                    "dst": "b2b_connectivity",
                    "edge_type": "block_connectivity_context",
                },
                {
                    "src": "pins",
                    "dst": "p2b_connectivity",
                    "edge_type": "pin_block_connectivity_context",
                },
            ],
        },
        "labels": {
            "label_status": "floorset_lite_public_training_only_not_e1_signoff",
            "label_sources": source_records,
            "values": {
                "metrics": {
                    "area": metrics_values[0],
                    "num_pins": metrics_values[1],
                    "num_total_nets": metrics_values[2],
                    "num_b2b_nets": metrics_values[3],
                    "num_p2b_nets": metrics_values[4],
                    "num_hardconstraints": metrics_values[5],
                    "b2b_weighted_wl": metrics_values[6],
                    "p2b_weighted_wl": metrics_values[7],
                },
                "solution_shape": tensor_shape(solution),
                "solution_area_sum": sum(width_height_area),
                "input_summaries": {
                    "block_features": tensor_summary(block_features),
                    "b2b_connectivity": tensor_summary(b2b),
                    "p2b_connectivity": tensor_summary(p2b),
                    "pins_pos": tensor_summary(pins),
                    "solution": tensor_summary(solution),
                },
            },
        },
        "provenance": {
            "generated_by": "scripts/ai_eda/convert_floorset_lite_to_internal_records.py",
            "source_records": source_records,
        },
    }
    flow_run = {
        "schema": "eda.flow_run.v1",
        "id": f"{case_id}-tensor-conversion-flow-run",
        "design_bundle_id": design_bundle["id"],
        "claim_boundary": CLAIM_BOUNDARY,
        "toolchain": {
            "tools": ["PyTorch tensor loader", "FloorSet LiteTensorDataTest"],
            "version_capture": "external/datasets/intel-floorset/manifest.yaml",
        },
        "command": "python3 scripts/ai_eda/convert_floorset_lite_to_internal_records.py --run-id <run-id>",
        "inputs": {"data": file_record(data_path), "label": file_record(label_path)},
        "outputs": {"reports": [], "artifacts": source_records},
        "metrics": {
            "block_count": block_count,
            "b2b_edge_count": int(b2b.shape[0]),
            "p2b_edge_count": int(p2b.shape[0]),
            "pin_count": int(pins.shape[0]),
            "metric_area": metrics_values[0],
            "metric_num_hardconstraints": metrics_values[5],
            "metric_b2b_weighted_wl": metrics_values[6],
            "metric_p2b_weighted_wl": metrics_values[7],
        },
        "status": {
            "result": "CONVERTED_TRAINING_ONLY_NOT_E1_SIGNOFF",
            "blockers": [
                "FloorSet labels are public benchmark labels, not E1 signoff evidence",
                "generated floorplans remain quarantined until deterministic E1 replay/signoff",
            ],
        },
    }
    records = [design_bundle, graph_sample, flow_run]
    for record in records:
        path = out_dir / f"{record['id']}.json"
        path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return records


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument("--payload", type=Path, default=PAYLOAD)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--sample-limit", type=int, default=100)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    out_dir = args.out_root / args.run_id / "records"
    out_dir.mkdir(parents=True, exist_ok=True)
    converted: list[dict[str, Any]] = []
    config_dirs = sorted(
        (args.payload / "LiteTensorDataTest").glob("config_*"),
        key=lambda path: int(path.name.split("_")[-1]),
    )[: args.sample_limit]
    for config_dir in config_dirs:
        for record in build_records(config_dir, args.payload, out_dir):
            converted.append(
                {
                    "id": record["id"],
                    "schema": record["schema"],
                    "json": rel(out_dir / f"{record['id']}.json"),
                }
            )
    report = {
        "schema": "eliza.ai_eda.floorset_lite_conversion_report.v1",
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "source_revision": REVISION,
        "payload": file_record(args.payload / "README.md"),
        "converted_case_count": len(config_dirs),
        "converted_record_count": len(converted),
        "converted_records": converted,
        "policy": {
            "contains_external_payload": False,
            "release_use_allowed": False,
            "e1_signoff_evidence": False,
            "training_only": True,
            "deterministic_replay_required_for_optimization_claims": True,
        },
    }
    out_report_dir = args.out_root / args.run_id
    out_report_dir.mkdir(parents=True, exist_ok=True)
    report_path = out_report_dir / "conversion_report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "STATUS: PASS ai_eda.floorset_lite_conversion "
        f"cases={report['converted_case_count']} records={report['converted_record_count']} {rel(report_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
