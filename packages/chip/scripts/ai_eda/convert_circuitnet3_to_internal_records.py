#!/usr/bin/env python3
"""Convert a bounded CircuitNet 3.0 payload sample into internal records."""

from __future__ import annotations

import argparse
import json
import math
import re
import zipfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ZIP = ROOT / "external/datasets/circuitnet3/payload/circuitNetv3.zip"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/circuitnet3"
CLAIM_BOUNDARY = "circuitnet3_conversion_training_pretraining_only_no_e1_signoff_or_release_claim"


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def write_json(out_dir: Path, record: dict[str, Any]) -> Path:
    out_path = out_dir / f"{record['id']}.json"
    out_path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return out_path


def finite_float(value: Any) -> float | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.upper() == "N/A":
        return None
    try:
        parsed = float(text)
    except ValueError:
        return None
    return parsed if math.isfinite(parsed) else None


def numeric_tokens(value: Any) -> list[float]:
    values = []
    for token in str(value or "").replace(",", " ").split():
        parsed = finite_float(token)
        if parsed is not None:
            values.append(parsed)
    return values


def mean_or_none(values: list[float]) -> float | None:
    return round(sum(values) / len(values), 8) if values else None


def parse_power_summary(text: str) -> float | None:
    match = re.search(r"Total\s+Power:\s*([-+0-9.eE]+)", text)
    return finite_float(match.group(1)) if match else None


def final_case_prefixes(zip_file: zipfile.ZipFile) -> list[str]:
    prefixes = set()
    for name in zip_file.namelist():
        match = re.match(r"(circuitNetv3/dataset/Final/[^/]+)/feature\.json$", name)
        if match:
            prefixes.add(match.group(1))
    return sorted(prefixes)


def feature_records(
    features: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    cell_histogram: Counter[str] = Counter()
    slack_values: list[float] = []
    at_values: list[float] = []
    fanout_values: list[float] = []
    delay_values: list[float] = []
    slew_values: list[float] = []
    setup_values: list[float] = []

    for instance_id, raw in sorted(features.items()):
        if not isinstance(raw, dict):
            continue
        cell_name = str(raw.get("cellName", "UNKNOWN"))
        cell_histogram[cell_name] += 1
        fanout_num = finite_float(raw.get("fanoutNum"))
        fanout_res = finite_float(raw.get("fanoutRes"))
        fanout_load = numeric_tokens(raw.get("fanoutLoad (rise fall)"))
        drive_strength = finite_float(raw.get("driveStrength"))
        slack = finite_float(raw.get("slack"))
        at = finite_float(raw.get("AT"))
        setup = numeric_tokens(raw.get("setup (rise fall)"))
        if fanout_num is not None:
            fanout_values.append(fanout_num)
        if slack is not None:
            slack_values.append(slack)
        if at is not None:
            at_values.append(at)
        setup_values.extend(setup)

        delay_by_pin: dict[str, float | None] = {}
        slew_by_pin: dict[str, float | None] = {}
        for key, value in raw.items():
            if key.startswith("Delay "):
                match = re.search(r"Pin:([^-\s]+)->", key)
                values = numeric_tokens(value)
                if values:
                    delay_values.extend(values)
                    delay_by_pin[match.group(1) if match else key] = mean_or_none(values)
            elif key.startswith("Input slew ") or key.startswith("Output slew "):
                match = re.search(r"Pin:([^-\s]+)->", key)
                values = numeric_tokens(value)
                if values:
                    slew_values.extend(values)
                    slew_by_pin[match.group(1) if match else key] = mean_or_none(values)

        nodes.append(
            {
                "id": instance_id,
                "cell_name": cell_name,
                "drive_strength": drive_strength,
                "fanout_num": fanout_num,
                "fanout_res": fanout_res,
                "fanout_load_mean": mean_or_none(fanout_load),
                "at": at,
                "slack": slack,
                "setup_mean": mean_or_none(setup),
            }
        )
        output_pin = str(raw.get("outputPin", ""))
        for input_pin in str(raw.get("inputPins", "")).split():
            edges.append(
                {
                    "src": f"{instance_id}.{input_pin}",
                    "dst": f"{instance_id}.{output_pin}" if output_pin else instance_id,
                    "edge_type": "cell_timing_arc",
                    "delay_mean": delay_by_pin.get(input_pin),
                    "slew_mean": slew_by_pin.get(input_pin),
                }
            )

    labels = {
        "timing_label_count": len(slack_values),
        "min_slack": round(min(slack_values), 8) if slack_values else None,
        "mean_slack": mean_or_none(slack_values),
        "max_at": round(max(at_values), 8) if at_values else None,
        "mean_delay": mean_or_none(delay_values),
        "mean_slew": mean_or_none(slew_values),
        "mean_setup": mean_or_none(setup_values),
        "mean_fanout": mean_or_none(fanout_values),
        "cell_histogram_top": dict(cell_histogram.most_common(20)),
    }
    return nodes, edges, labels


def convert_case(
    zip_file: zipfile.ZipFile, prefix: str, out_dir: Path, archive_path: Path
) -> list[dict[str, Any]]:
    case_name = prefix.rsplit("/", 1)[-1]
    safe_case = re.sub(r"[^A-Za-z0-9_.-]+", "_", case_name)
    feature_path = f"{prefix}/feature.json"
    netlist_path = f"{prefix}/final_netlist.v"
    power_path = f"{prefix}/power_summary.txt"
    features = json.loads(zip_file.read(feature_path))
    if not isinstance(features, dict):
        raise ValueError(f"{feature_path}: expected object")
    nodes, edges, labels = feature_records(features)
    power_total = parse_power_summary(zip_file.read(power_path).decode("utf-8", errors="replace"))
    if power_total is not None:
        labels["total_power"] = power_total

    design_bundle = {
        "schema": "eda.design_bundle.v1",
        "id": f"circuitnet3-{safe_case}-design-bundle",
        "claim_boundary": CLAIM_BOUNDARY,
        "design": {
            "name": case_name,
            "revision": "circuitnet3_payload_zip",
            "top_module": case_name,
        },
        "sources": {
            "rtl": [],
            "netlists": [f"{rel(archive_path)}::{netlist_path}"],
            "manifests": [
                f"{rel(archive_path)}::{feature_path}",
                f"{rel(archive_path)}::{power_path}",
            ],
        },
        "constraints": {"clocks": [], "resets": []},
        "technology": {
            "node": "45nm_circuitnet3_public_dataset",
            "pdk": "public_dataset_no_pdk_collateral",
            "flow": "CircuitNet3.0",
        },
    }
    graph_sample = {
        "schema": "eda.graph_sample.v1",
        "id": f"circuitnet3-{safe_case}-graph-sample",
        "design_bundle_id": design_bundle["id"],
        "claim_boundary": CLAIM_BOUNDARY,
        "graph": {
            "node_features": nodes,
            "edge_features": edges,
            "coordinate_system": "circuitnet3_final_netlist_timing_arcs_no_layout_coordinates",
        },
        "labels": {
            "label_status": "public_circuitnet3_training_pretraining_labels_not_e1_signoff",
            "label_sources": [
                f"{rel(archive_path)}::{feature_path}",
                f"{rel(archive_path)}::{power_path}",
            ],
            "values": labels,
        },
        "provenance": {
            "generated_by": "scripts/ai_eda/convert_circuitnet3_to_internal_records.py",
            "source_records": [
                f"{rel(archive_path)}::{feature_path}",
                f"{rel(archive_path)}::{power_path}",
            ],
        },
    }
    flow_run = {
        "schema": "eda.flow_run.v1",
        "id": f"circuitnet3-{safe_case}-flow-run",
        "design_bundle_id": design_bundle["id"],
        "claim_boundary": CLAIM_BOUNDARY,
        "toolchain": {
            "tools": ["CircuitNet3.0 public dataset export"],
            "version_capture": "external/datasets/circuitnet3/manifest.yaml",
        },
        "command": "python3 scripts/ai_eda/convert_circuitnet3_to_internal_records.py --run-id <run-id>",
        "inputs": {
            "archive": rel(archive_path),
            "feature_json": feature_path,
            "final_netlist": netlist_path,
            "power_summary": power_path,
        },
        "outputs": {
            "reports": [],
            "artifacts": [
                f"{rel(archive_path)}::{feature_path}",
                f"{rel(archive_path)}::{power_path}",
            ],
        },
        "metrics": {"instance_count": len(nodes), "timing_arc_count": len(edges), **labels},
        "status": {
            "result": "CONVERTED_PUBLIC_DATASET_LABELS_NOT_REPLAYED",
            "blockers": [
                "not generated from local E1 OpenLane/OpenROAD replay",
                "layout coordinates and signoff collateral are not present in this archive subset",
                "license/provenance review still required before release use",
            ],
        },
    }
    paths = [write_json(out_dir, record) for record in (design_bundle, graph_sample, flow_run)]
    return [
        {
            "case": case_name,
            "schema": record["schema"],
            "json": rel(path),
            "instance_count": len(nodes),
            "timing_arc_count": len(edges),
        }
        for record, path in zip((design_bundle, graph_sample, flow_run), paths)
    ]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, default=DEFAULT_ZIP)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--run-id", default=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--sample-limit", type=int, default=3)
    parser.add_argument(
        "--all-records",
        action="store_true",
        help="Convert every available final case instead of the smoke sample limit.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.all_records and args.sample_limit <= 0:
        raise SystemExit("--sample-limit must be positive")
    if not args.archive.exists():
        print(f"STATUS: BLOCKED ai_eda.circuitnet3 missing_archive {args.archive}")
        return 2
    out_dir = args.out_root / args.run_id / "records"
    out_dir.mkdir(parents=True, exist_ok=True)
    for stale_record in out_dir.glob("circuitnet3-*.json"):
        stale_record.unlink()
    converted: list[dict[str, Any]] = []
    with zipfile.ZipFile(args.archive) as zip_file:
        prefixes = final_case_prefixes(zip_file)
        selected = prefixes if args.all_records else prefixes[: args.sample_limit]
        for prefix in selected:
            converted.extend(convert_case(zip_file, prefix, out_dir, args.archive))
        report = {
            "schema": "eliza.ai_eda.circuitnet3_conversion_report.v1",
            "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
            "run_id": args.run_id,
            "claim_boundary": CLAIM_BOUNDARY,
            "release_use_allowed": False,
            "archive": rel(args.archive),
            "archive_bytes": args.archive.stat().st_size,
            "zip_entry_count": len(zip_file.infolist()),
            "available_final_case_count": len(prefixes),
            "converted_case_count": len(selected),
            "conversion_mode": "all_records" if args.all_records else "sample_limit",
            "sample_limit": None if args.all_records else args.sample_limit,
            "converted_record_count": len(converted),
            "converted_records": converted,
            "next_required_gates": [
                "convert source-level train validation test partitions when upstream split metadata is mapped",
                "train timing/power/routability predictors only after leakage checks are recorded",
                "never use CircuitNet labels as E1 signoff; compare only against local replayed E1 OpenLane/OpenROAD labels",
            ],
        }
    report_path = args.out_root / args.run_id / "conversion_report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "STATUS: PASS ai_eda.circuitnet3_conversion "
        f"cases={len(selected)} records={len(converted)} available_cases={len(prefixes)} {rel(report_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
