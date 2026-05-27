#!/usr/bin/env python3
"""Convert R-Zoo evaluation DEFs into normalized internal records."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
PAYLOAD = ROOT / "external/datasets/r-zoo-rectilinear-floorplan/payload"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/r_zoo_rectilinear_floorplan"
CLAIM_BOUNDARY = (
    "r_zoo_rectilinear_floorplan_conversion_training_only_no_e1_signoff_or_release_claim"
)
LABEL_STATUS = "public_r_zoo_rectilinear_floorplan_legality_training_only_not_e1_signoff"
REVISION = "986d5ca24362bc6fc0a4980afdafccb814d740e6"
FIXTURE_SOURCE = "generated_ci_fixture_missing_external_payload"
FIXTURE_LABELS = {
    "ariane133_single_notch.def": "LEGAL",
    "ariane133_multi_notch.def": "LEGAL",
    "ariane136_single_notch.def": "LEGAL",
    "ariane136_multi_notch.def": "LEGAL",
    "bp_be_single_notch.def": "LEGAL",
    "bp_be_multi_notch.def": "ILLEGAL",
    "bp_fe_single_notch.def": "LEGAL",
    "bp_fe_multi_notch.def": "LEGAL",
    "bp_multi_single_notch.def": "ILLEGAL",
    "bp_multi_multi_notch.def": "LEGAL",
    "sw_single_notch.def": "LEGAL",
    "sw_multi_notch.def": "ILLEGAL",
    "tr_single_notch.def": "LEGAL",
    "tr_multi_notch.def": "LEGAL",
}


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


def parse_legality_labels(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    labels: dict[str, str] = {}
    pattern = re.compile(
        r"\[([A-Za-z0-9_]+_(?:single|multi)_notch\.def)\]\([^)]*\)\s*\|\s*(Legal|Illegal)",
        re.IGNORECASE,
    )
    for line in read_text(path).splitlines():
        for filename, label in pattern.findall(line):
            labels[filename] = label.upper()
    return labels


def parse_diearea(path: Path) -> dict[str, Any]:
    point_pattern = re.compile(r"\(\s*(-?\d+)\s+(-?\d+)\s*\)")
    diearea = ""
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for raw in handle:
            line = raw.strip()
            if line.startswith("DIEAREA"):
                diearea = line
                while ";" not in diearea:
                    nxt = handle.readline()
                    if not nxt:
                        break
                    diearea += " " + nxt.strip()
                break
    points = [(int(x), int(y)) for x, y in point_pattern.findall(diearea)]
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    rectilinear_edges = (
        all(
            points[index][0] == points[(index + 1) % len(points)][0]
            or points[index][1] == points[(index + 1) % len(points)][1]
            for index in range(len(points))
        )
        if len(points) >= 2
        else False
    )
    width = (max(xs) - min(xs)) if xs else 0
    height = (max(ys) - min(ys)) if ys else 0
    return {
        "diearea_found": bool(diearea),
        "point_count": len(points),
        "rectilinear_edges": rectilinear_edges,
        "first_point_repeated_as_last": len(points) > 1 and points[0] == points[-1],
        "bbox_dbu": {
            "min_x": min(xs) if xs else None,
            "min_y": min(ys) if ys else None,
            "max_x": max(xs) if xs else None,
            "max_y": max(ys) if ys else None,
            "width": width,
            "height": height,
        },
        "points_dbu": [{"x": x, "y": y} for x, y in points],
    }


def fixture_diearea(index: int) -> str:
    width = 10_000 + index * 250
    height = 8_000 + index * 175
    notch_x = width - 2_000
    notch_y = height - 2_000
    return (
        f"( 0 0 ) ( {width} 0 ) ( {width} {notch_y} ) "
        f"( {notch_x} {notch_y} ) ( {notch_x} {height} ) ( 0 {height} )"
    )


def write_fixture_def(path: Path, index: int) -> None:
    design = path.stem
    diearea = fixture_diearea(index)
    width = 10_000 + index * 250
    track_count = 10 + index
    path.write_text(
        "\n".join(
            (
                "VERSION 5.8 ;",
                'DIVIDERCHAR "/" ;',
                'BUSBITCHARS "[]" ;',
                f"DESIGN {design} ;",
                "UNITS DISTANCE MICRONS 1000 ;",
                f"DIEAREA {diearea} ;",
                f"ROW ROW_0 CORE 0 0 N DO {width // 1000} BY 1 STEP 1000 1000 ;",
                f"TRACKS X 0 DO {track_count} STEP 1000 LAYER metal1 ;",
                f"END {design}",
                "",
            )
        ),
        encoding="utf-8",
    )


def materialize_fixture_payload(path: Path) -> dict[str, str]:
    eval_dir = path / "for_evaluation"
    eval_dir.mkdir(parents=True, exist_ok=True)
    path.mkdir(parents=True, exist_ok=True)
    path.joinpath("README.md").write_text(
        "Generated R-Zoo-shaped fixture for CI schema conversion only.\n",
        encoding="utf-8",
    )
    path.joinpath("LICENSE").write_text(
        "Generated fixture data. No external R-Zoo payload or release claim.\n",
        encoding="utf-8",
    )
    lines = [
        "# Generated R-Zoo-shaped evaluation fixture",
        "",
        "| DEF | Label |",
        "| --- | --- |",
    ]
    for index, (filename, label) in enumerate(FIXTURE_LABELS.items(), start=1):
        write_fixture_def(eval_dir / filename, index)
        lines.append(f"| [{filename}]({filename}) | {label.title()} |")
    eval_dir.joinpath("README.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return dict(FIXTURE_LABELS)


def count_keyword(path: Path, keyword: str) -> int:
    count = 0
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if line.lstrip().startswith(keyword):
                count += 1
    return count


def sibling_modeling_def(payload: Path, name: str) -> Path | None:
    stem = name.removesuffix(".def")
    parts = stem.split("_")
    if len(parts) < 3:
        return None
    design = "_".join(parts[:-2])
    notch = "_".join(parts[-2:])
    sample = payload / "for_modeling/dataset" / f"sample_{design}" / "def_files"
    candidates = sorted(sample.glob(f"*{notch}*.def")) if sample.is_dir() else []
    return candidates[0] if candidates else None


def build_records(def_path: Path, label: str, payload: Path, out_dir: Path) -> list[dict[str, Any]]:
    case = def_path.stem
    case_id = f"r-zoo-rectilinear-floorplan-{safe_id(case)}"
    diearea = parse_diearea(def_path)
    source_records = [
        file_record(def_path),
        file_record(payload / "for_evaluation/README.md"),
        file_record(payload / "README.md"),
        file_record(payload / "LICENSE"),
    ]
    modeling = sibling_modeling_def(payload, def_path.name)
    if modeling is not None:
        source_records.append(file_record(modeling))
    rows = count_keyword(def_path, "ROW")
    tracks = count_keyword(def_path, "TRACKS")
    design_name = case.rsplit("_", 2)[0]
    notch_class = "_".join(case.rsplit("_", 2)[1:])
    legal_bool = label == "LEGAL"
    bbox = diearea["bbox_dbu"]
    design_bundle = {
        "schema": "eda.design_bundle.v1",
        "id": f"{case_id}-design-bundle",
        "claim_boundary": CLAIM_BOUNDARY,
        "design": {
            "name": case,
            "revision": REVISION,
            "top_module": design_name,
        },
        "sources": {
            "rtl": [],
            "manifests": ["external/datasets/r-zoo-rectilinear-floorplan/manifest.yaml"],
            "floorplan_defs": [file_record(def_path)],
            "reference_docs": [
                file_record(payload / "for_evaluation/README.md"),
                file_record(payload / "README.md"),
                file_record(payload / "LICENSE"),
            ],
        },
        "constraints": {"clocks": [], "resets": []},
        "technology": {
            "node": "nangate45_public_floorplanning_dataset",
            "pdk": "public_lef_def_only_no_foundry_claim",
            "flow": "R-Zoo rectilinear floorplan evaluation subset",
        },
    }
    graph_sample = {
        "schema": "eda.graph_sample.v1",
        "id": f"{case_id}-diearea-legality-graph",
        "design_bundle_id": design_bundle["id"],
        "claim_boundary": CLAIM_BOUNDARY,
        "graph": {
            "coordinate_system": "def_dbu_from_r_zoo_diearea_no_e1_coordinates",
            "node_features": [
                {
                    "id": "diearea",
                    "node_type": "rectilinear_diearea_polygon",
                    "point_count": diearea["point_count"],
                    "rectilinear_edges": diearea["rectilinear_edges"],
                    "first_point_repeated_as_last": diearea["first_point_repeated_as_last"],
                    "bbox_dbu": bbox,
                },
                {
                    "id": "rows",
                    "node_type": "def_row_summary",
                    "count": rows,
                },
                {
                    "id": "tracks",
                    "node_type": "def_track_summary",
                    "count": tracks,
                },
                {
                    "id": "legality_label",
                    "node_type": "public_evaluation_label",
                    "legal": legal_bool,
                    "label": label,
                },
            ],
            "edge_features": [
                {
                    "src": "diearea",
                    "dst": "legality_label",
                    "edge_type": "diearea_geometry_to_public_legality_label",
                    "notch_class": notch_class,
                },
                {
                    "src": "diearea",
                    "dst": "rows",
                    "edge_type": "floorplan_grid_context",
                    "tracks": tracks,
                },
            ],
        },
        "labels": {
            "label_status": LABEL_STATUS,
            "label_sources": source_records,
            "values": {
                "public_legality": label,
                "is_legal": legal_bool,
                "notch_class": notch_class,
                "design_family": design_name,
                "diearea": diearea,
            },
        },
        "provenance": {
            "generated_by": "scripts/ai_eda/convert_r_zoo_to_internal_records.py",
            "source_records": source_records,
        },
    }
    flow_run = {
        "schema": "eda.flow_run.v1",
        "id": f"{case_id}-legality-label-flow-run",
        "design_bundle_id": design_bundle["id"],
        "claim_boundary": CLAIM_BOUNDARY,
        "toolchain": {
            "tools": ["R-Zoo public evaluation labels", "local DEF DIEAREA parser"],
            "version_capture": "external/datasets/r-zoo-rectilinear-floorplan/manifest.yaml",
        },
        "command": "python3 scripts/ai_eda/convert_r_zoo_to_internal_records.py --run-id <run-id>",
        "inputs": {
            "def_file": file_record(def_path),
            "label_readme": file_record(payload / "for_evaluation/README.md"),
        },
        "outputs": {"reports": [], "artifacts": source_records},
        "metrics": {
            "label_status": LABEL_STATUS,
            "public_legality": label,
            "is_legal": legal_bool,
            "diearea_point_count": diearea["point_count"],
            "rectilinear_edges": diearea["rectilinear_edges"],
            "first_point_repeated_as_last": diearea["first_point_repeated_as_last"],
            "bbox_width_dbu": bbox["width"],
            "bbox_height_dbu": bbox["height"],
            "row_count": rows,
            "track_statement_count": tracks,
        },
        "status": {
            "result": "CONVERTED_TRAINING_ONLY_NOT_E1_SIGNOFF",
            "blockers": [
                "CC BY-NC / conflicting subset license note must be resolved before release use",
                "R-Zoo legality labels are benchmark labels, not E1 signoff evidence",
                "E1 optimization claims require deterministic OpenLane/OpenROAD replay and comparison",
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
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    payload = args.payload
    payload_source = "external_payload"
    labels = parse_legality_labels(payload / "for_evaluation/README.md")
    if not labels:
        if (payload / "for_evaluation").is_dir():
            raise SystemExit(f"R-Zoo evaluation labels are missing in {rel(payload)}")
        payload = args.out_root / args.run_id / "source-fixtures"
        labels = materialize_fixture_payload(payload)
        payload_source = FIXTURE_SOURCE
    out_dir = args.out_root / args.run_id / "records"
    out_dir.mkdir(parents=True, exist_ok=True)
    converted: list[dict[str, Any]] = []
    for def_path in sorted((payload / "for_evaluation").glob("*.def")):
        label = labels.get(def_path.name)
        if label not in {"LEGAL", "ILLEGAL"}:
            continue
        for record in build_records(def_path, label, payload, out_dir):
            converted.append(
                {
                    "id": record["id"],
                    "schema": record["schema"],
                    "json": rel(out_dir / f"{record['id']}.json"),
                }
            )
    label_counts = {
        "LEGAL": sum(1 for value in labels.values() if value == "LEGAL"),
        "ILLEGAL": sum(1 for value in labels.values() if value == "ILLEGAL"),
    }
    report = {
        "schema": "eliza.ai_eda.r_zoo_rectilinear_floorplan_conversion_report.v1",
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "source_revision": REVISION,
        "payload_source": payload_source,
        "payload": file_record(payload / "for_evaluation/README.md"),
        "converted_case_count": len(converted) // 3,
        "converted_record_count": len(converted),
        "label_counts": label_counts,
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
        "STATUS: PASS ai_eda.r_zoo_rectilinear_floorplan_conversion "
        f"cases={report['converted_case_count']} records={report['converted_record_count']} {rel(report_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
