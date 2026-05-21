#!/usr/bin/env python3
"""Convert MLCAD 2023 FPGA macro-placement specs into internal records."""

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
PAYLOAD = ROOT / "external/datasets/mlcad-2023-fpga-macro/payload"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/mlcad_2023_fpga_macro"
CLAIM_BOUNDARY = "mlcad_2023_fpga_macro_conversion_training_only_no_e1_signoff_or_release_claim"
LABEL_STATUS = "public_mlcad_2023_fpga_macro_metadata_training_only_not_e1_signoff"


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


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def parse_clock_buckets(path: Path) -> list[dict[str, Any]]:
    buckets: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for raw in read_text(path).splitlines():
        line = raw.strip()
        if not line:
            continue
        match = re.match(r"Designs with\s+(\d+)\s+clocks?:?", line, re.IGNORECASE)
        if match:
            current = {"clock_count": int(match.group(1)), "design_ids": []}
            buckets.append(current)
            continue
        if current is not None and line.isdigit():
            current["design_ids"].append(int(line))
    return [bucket for bucket in buckets if bucket["design_ids"]]


def parse_scl(path: Path) -> dict[str, Any]:
    site_defs: dict[str, dict[str, int]] = {}
    resources: dict[str, list[str]] = {}
    site_map_counts: Counter[str] = Counter()
    dimensions: dict[str, int] = {}
    current_site: str | None = None
    in_resources = False
    in_sitemap = False
    for raw in read_text(path).splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) == 2 and parts[0] == "SITE":
            current_site = parts[1]
            site_defs[current_site] = {}
            in_resources = False
            in_sitemap = False
            continue
        if line == "END SITE":
            current_site = None
            continue
        if current_site and len(parts) == 2 and parts[1].isdigit():
            site_defs[current_site][parts[0]] = int(parts[1])
            continue
        if line == "RESOURCES":
            in_resources = True
            continue
        if line == "END RESOURCES":
            in_resources = False
            continue
        if in_resources and len(parts) >= 2:
            resources[parts[0]] = parts[1:]
            continue
        if len(parts) == 3 and parts[0] == "SITEMAP":
            dimensions = {"columns": int(parts[1]), "rows": int(parts[2])}
            in_sitemap = True
            continue
        if in_sitemap and len(parts) == 3 and parts[0].isdigit() and parts[1].isdigit():
            site_map_counts[parts[2]] += 1
    return {
        "site_definitions": site_defs,
        "resources": resources,
        "sitemap_dimensions": dimensions,
        "sitemap_site_counts": dict(sorted(site_map_counts.items())),
    }


def parse_lib(path: Path) -> list[dict[str, Any]]:
    cells: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for raw in read_text(path).splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) == 2 and parts[0] == "CELL":
            current = {"name": parts[1], "pins": []}
            cells.append(current)
            continue
        if line.startswith("END CELL"):
            current = None
            continue
        if current is not None and len(parts) >= 3 and parts[0] == "PIN":
            current["pins"].append(
                {"name": parts[1], "direction": parts[2], "attributes": parts[3:]}
            )
    return cells


def parse_cascade_instances(path: Path) -> list[dict[str, Any]]:
    instances: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for raw in read_text(path).splitlines():
        line = raw.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) == 4 and parts[1].isdigit() and parts[2].isdigit():
            current = {
                "shape": parts[0],
                "height": int(parts[1]),
                "width": int(parts[2]),
                "instance": parts[3],
                "component_count": 0,
            }
            instances.append(current)
            continue
        if line.upper() == "BEGIN" or line.upper() == "END":
            continue
        if current is not None:
            current["component_count"] += 1
    return instances


def discover_design_case_files(payload: Path) -> list[str]:
    names = {"design.nodes", "design.nets", "sample.pl"}
    found = []
    for path in payload.rglob("*"):
        if path.is_file() and path.name in names:
            found.append(rel(path))
    return sorted(found)


def write_json(out_dir: Path, record: dict[str, Any]) -> Path:
    path = out_dir / f"{record['id']}.json"
    path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def source_files(payload: Path) -> dict[str, Path]:
    return {
        "clock_key": payload / "Benchmark_Suite/Design_spcifications_key",
        "device_layout": payload / "Benchmark_Suite/design.scl",
        "library": payload / "Benchmark_Suite/design.lib",
        "cascade_instances": payload / "Benchmark_Suite/design.cascade_shape_instances",
        "benchmark_format": payload / "Documentation/BenchmarkFileFormat.md",
        "evaluation_ranking": payload / "Documentation/Evaluation_Ranking.md",
        "readme": payload / "Readme.md",
        "io_map": payload / "Flow/io_map.csv",
    }


def convert_bucket(
    bucket: dict[str, Any],
    summaries: dict[str, Any],
    payload: Path,
    out_dir: Path,
    full_case_files: list[str],
) -> list[dict[str, Any]]:
    clock_count = int(bucket["clock_count"])
    design_ids = list(bucket["design_ids"])
    case_id = f"mlcad-2023-fpga-macro-{clock_count}-clock-bucket"
    files = source_files(payload)
    source_records = [file_record(path) for path in files.values() if path.is_file()]
    site_count = sum(summaries["scl"]["sitemap_site_counts"].values())
    cascade_count = len(summaries["cascade_instances"])
    lib_cell_count = len(summaries["lib_cells"])
    result = (
        "CONVERTED_METADATA_ONLY_BLOCKED_MISSING_DESIGN_CASE_PAYLOAD"
        if not full_case_files
        else "CONVERTED_WITH_DISCOVERED_DESIGN_CASE_PAYLOAD_STILL_BLOCKED_FOR_E1_SIGNOFF"
    )
    blockers = [
        "per-design Bookshelf/Vivado files are not present in the local reviewed payload",
        "Vivado place-and-route replay is required for contest-score labels",
        "FPGA macro-placement transfer is advisory until replayed on deterministic E1 OpenLane/OpenROAD cases",
    ]
    if full_case_files:
        blockers[0] = (
            "per-design files are present but require a dedicated full Bookshelf parser before score claims"
        )

    design_bundle = {
        "schema": "eda.design_bundle.v1",
        "id": f"{case_id}-design-bundle",
        "claim_boundary": CLAIM_BOUNDARY,
        "design": {
            "name": f"MLCAD 2023 FPGA macro placement {clock_count}-clock public bucket",
            "revision": "mlcad_2023_public_spec_metadata",
            "top_module": "fpga_macro_placement_bucket_metadata_only",
        },
        "sources": {
            "rtl": [],
            "manifests": ["external/datasets/mlcad-2023-fpga-macro/manifest.yaml"],
            "benchmark_specs": source_records,
            "discovered_design_case_files": full_case_files,
        },
        "constraints": {"clocks": [{"count": clock_count, "design_ids": design_ids}], "resets": []},
        "technology": {
            "node": "fpga_ultrascaleplus_xcvu3p_public_contest",
            "pdk": "vivado_device_model_not_asic_pdk",
            "flow": "MLCAD 2023 FPGA Macro Placement Contest",
        },
    }
    graph_sample = {
        "schema": "eda.graph_sample.v1",
        "id": f"{case_id}-spec-graph",
        "design_bundle_id": design_bundle["id"],
        "claim_boundary": CLAIM_BOUNDARY,
        "graph": {
            "coordinate_system": "fpga_site_grid_metadata_only_no_macro_solution",
            "node_features": [
                {
                    "id": "clock_bucket",
                    "node_type": "clock_group",
                    "clock_count": clock_count,
                    "design_count": len(design_ids),
                },
                {
                    "id": "device_grid",
                    "node_type": "fpga_site_grid",
                    **summaries["scl"]["sitemap_dimensions"],
                },
                {
                    "id": "site_types",
                    "node_type": "resource_catalog",
                    "site_type_count": len(summaries["scl"]["site_definitions"]),
                },
                {"id": "library_cells", "node_type": "cell_catalog", "cell_count": lib_cell_count},
                {
                    "id": "cascade_shapes",
                    "node_type": "macro_cascade_catalog",
                    "instance_count": cascade_count,
                },
            ],
            "edge_features": [
                {
                    "src": "clock_bucket",
                    "dst": "device_grid",
                    "edge_type": "placement_constraint_context",
                },
                {
                    "src": "site_types",
                    "dst": "library_cells",
                    "edge_type": "legal_resource_mapping",
                },
                {
                    "src": "cascade_shapes",
                    "dst": "device_grid",
                    "edge_type": "macro_column_legality",
                },
            ],
        },
        "labels": {
            "label_status": LABEL_STATUS,
            "label_sources": source_records,
            "values": {
                "clock_count": clock_count,
                "design_ids": design_ids,
                "design_count": len(design_ids),
                "full_design_case_conversion_status": result,
            },
        },
        "provenance": {
            "generated_by": "scripts/ai_eda/convert_mlcad_2023_fpga_macro_to_internal_records.py",
            "source_records": source_records,
        },
    }
    flow_run = {
        "schema": "eda.flow_run.v1",
        "id": f"{case_id}-metadata-flow-run",
        "design_bundle_id": design_bundle["id"],
        "claim_boundary": CLAIM_BOUNDARY,
        "toolchain": {
            "tools": [
                "MLCAD 2023 FPGA Macro Placement Contest public specs",
                "Vivado contest flow metadata",
            ],
            "version_capture": "external/datasets/mlcad-2023-fpga-macro/manifest.yaml",
        },
        "command": "python3 scripts/ai_eda/convert_mlcad_2023_fpga_macro_to_internal_records.py --run-id <run-id>",
        "inputs": {
            "clock_key": file_record(files["clock_key"]),
            "device_layout": file_record(files["device_layout"]),
            "library": file_record(files["library"]),
            "cascade_instances": file_record(files["cascade_instances"]),
        },
        "outputs": {"reports": [], "artifacts": source_records},
        "metrics": {
            "label_status": LABEL_STATUS,
            "clock_count": clock_count,
            "design_count": len(design_ids),
            "site_type_count": len(summaries["scl"]["site_definitions"]),
            "site_count": site_count,
            "lib_cell_count": lib_cell_count,
            "lib_pin_count": sum(len(cell["pins"]) for cell in summaries["lib_cells"]),
            "cascade_instance_count": cascade_count,
            "discovered_design_case_file_count": len(full_case_files),
        },
        "status": {"result": result, "blockers": blockers},
    }
    records = (design_bundle, graph_sample, flow_run)
    paths = [write_json(out_dir, record) for record in records]
    return [
        {
            "id": record["id"],
            "schema": record["schema"],
            "json": rel(path),
            "clock_count": clock_count,
            "design_count": len(design_ids),
            "status": result,
        }
        for record, path in zip(records, paths, strict=False)
    ]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--payload", type=Path, default=PAYLOAD)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--run-id", default=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    files = source_files(args.payload)
    missing = [name for name, path in files.items() if name != "io_map" and not path.is_file()]
    if missing:
        print(
            f"STATUS: BLOCKED ai_eda.mlcad_2023_fpga_macro_conversion missing_files={','.join(missing)}"
        )
        return 2
    buckets = parse_clock_buckets(files["clock_key"])
    if not buckets:
        print("STATUS: BLOCKED ai_eda.mlcad_2023_fpga_macro_conversion missing_clock_buckets")
        return 2
    summaries = {
        "scl": parse_scl(files["device_layout"]),
        "lib_cells": parse_lib(files["library"]),
        "cascade_instances": parse_cascade_instances(files["cascade_instances"]),
    }
    full_case_files = discover_design_case_files(args.payload)
    out_dir = args.out_root / args.run_id / "records"
    out_dir.mkdir(parents=True, exist_ok=True)
    for stale in out_dir.glob("mlcad-2023-fpga-macro-*.json"):
        stale.unlink()
    converted: list[dict[str, Any]] = []
    for bucket in buckets:
        converted.extend(convert_bucket(bucket, summaries, args.payload, out_dir, full_case_files))
    result = (
        "BLOCKED_MISSING_DESIGN_CASE_PAYLOAD"
        if not full_case_files
        else "DISCOVERED_DESIGN_CASE_PAYLOAD_REQUIRES_FULL_BOOKSHELF_CONVERTER"
    )
    report = {
        "schema": "eliza.ai_eda.mlcad_2023_fpga_macro_conversion_report.v1",
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "payload": rel(args.payload),
        "converted_clock_bucket_count": len(buckets),
        "converted_design_id_count": sum(len(bucket["design_ids"]) for bucket in buckets),
        "converted_record_count": len(converted),
        "converted_records": converted,
        "full_design_case_conversion_status": result,
        "discovered_design_case_files": full_case_files,
        "summaries": {
            "sitemap_dimensions": summaries["scl"]["sitemap_dimensions"],
            "sitemap_site_counts": summaries["scl"]["sitemap_site_counts"],
            "site_definitions": summaries["scl"]["site_definitions"],
            "resource_keys": sorted(summaries["scl"]["resources"]),
            "lib_cell_count": len(summaries["lib_cells"]),
            "cascade_instance_count": len(summaries["cascade_instances"]),
        },
        "policy": {
            "contains_vivado_design_checkpoints": False,
            "contains_hidden_benchmarks": False,
            "contains_macro_solution_labels": False,
            "release_use_allowed": False,
            "e1_signoff_evidence": False,
            "deterministic_replay_required_for_ppa_claims": True,
        },
    }
    report_path = args.out_root / args.run_id / "conversion_report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "STATUS: PASS ai_eda.mlcad_2023_fpga_macro_conversion "
        f"clock_buckets={len(buckets)} records={len(converted)} "
        f"full_cases={len(full_case_files)} report={rel(report_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
