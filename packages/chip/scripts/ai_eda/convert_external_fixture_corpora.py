#!/usr/bin/env python3
"""Convert tiny external-shape AI-EDA fixtures into internal schema records."""

from __future__ import annotations

import argparse
import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
FIXTURE_ROOT = ROOT / "docs/spec-db/ai-eda/external-fixtures"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/converted_external_fixtures"
CLAIM_BOUNDARY = "external_fixture_conversion_only_no_training_or_release_claim"


def parse_bookshelf_nodes(path: Path) -> list[dict[str, Any]]:
    nodes: list[dict[str, Any]] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("UCLA") or line.startswith("Num"):
            continue
        parts = line.split()
        if len(parts) < 3:
            continue
        nodes.append(
            {
                "id": parts[0],
                "type": "fixed" if "terminal" in parts[3:] else "softmacro",
                "width_um": float(parts[1]),
                "height_um": float(parts[2]),
            }
        )
    return nodes


def parse_bookshelf_pl(path: Path) -> dict[str, dict[str, float]]:
    placements: dict[str, dict[str, float]] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("UCLA"):
            continue
        parts = line.split()
        if len(parts) >= 3:
            placements[parts[0]] = {"x_um": float(parts[1]), "y_um": float(parts[2])}
    return placements


def def_diearea(path: Path) -> list[float]:
    match = re.search(
        r"DIEAREA\s+\(\s*(\d+)\s+(\d+)\s*\)\s+\(\s*(\d+)\s+(\d+)\s*\)",
        path.read_text(encoding="utf-8"),
    )
    if not match:
        return [0, 0, 1000, 1000]
    # DEF database units in the fixture are 1000/unit.
    return [float(value) / 1000.0 for value in match.groups()]


def write_json(out_dir: Path, record: dict[str, Any]) -> Path:
    out_path = out_dir / f"{record['id']}.json"
    out_path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
    return out_path


def convert_macroplacement(out_dir: Path) -> list[dict[str, Any]]:
    base = FIXTURE_ROOT / "macroplacement"
    nodes = parse_bookshelf_nodes(base / "e1_toy.nodes")
    placements = parse_bookshelf_pl(base / "e1_toy.pl")
    movable = []
    fixed = []
    for node in nodes:
        item = dict(node)
        item.update(placements.get(node["id"], {}))
        if node["type"] == "fixed":
            fixed.append(item)
        else:
            movable.append(item)
    record = {
        "schema": "eda.placement_case.v1",
        "id": "macroplacement-fixture-e1-toy-placement-case",
        "design_bundle_id": "macroplacement-fixture-e1-toy-design-bundle",
        "claim_boundary": CLAIM_BOUNDARY,
        "floorplan": {
            "die_area_um": [0, 0, 1000, 1000],
            "core_area_um": [50, 50, 950, 950],
            "rows": "bookshelf_fixture_rows",
        },
        "movable_objects": movable,
        "fixed_objects": fixed,
        "objective": {
            "primary": "macroplacement_bookshelf_fixture_conversion",
            "secondary": ["hpwl_proxy", "legality_proxy"],
        },
        "replay": {
            "deterministic_command": "make openlane-smoke",
            "expected_report": "build/ai_eda/converted_external_fixtures/validation/conversion_report.json",
        },
    }
    path = write_json(out_dir, record)
    return [
        {
            "source": "MacroPlacement/Bookshelf fixture",
            "schema": record["schema"],
            "json": str(path.relative_to(ROOT)),
        }
    ]


def convert_chipbench(out_dir: Path) -> list[dict[str, Any]]:
    base = FIXTURE_ROOT / "chipbench_d"
    manifest = json.loads((base / "case_manifest.json").read_text(encoding="utf-8"))
    files = manifest["files"]
    design_bundle = {
        "schema": "eda.design_bundle.v1",
        "id": "chipbench-d-fixture-e1-toy-design-bundle",
        "claim_boundary": CLAIM_BOUNDARY,
        "design": {
            "name": manifest["case_id"],
            "revision": "fixture",
            "top_module": manifest["top_module"],
        },
        "sources": {
            "rtl": [str((base / files["verilog"]).relative_to(ROOT))],
            "manifests": [str((base / "case_manifest.json").relative_to(ROOT))],
        },
        "constraints": {
            "clocks": [{"name": "clk", "period_ns": 10.0}],
            "resets": [{"name": "rst_n", "active": "low"}],
        },
        "technology": {
            "node": manifest["node"],
            "pdk": "sky130_fixture",
            "flow": "chipbench_d_fixture",
        },
    }
    placement_case = {
        "schema": "eda.placement_case.v1",
        "id": "chipbench-d-fixture-e1-toy-placement-case",
        "design_bundle_id": design_bundle["id"],
        "claim_boundary": CLAIM_BOUNDARY,
        "floorplan": {
            "die_area_um": def_diearea(base / files["pre_place_def"]),
            "core_area_um": [50, 50, 950, 950],
            "rows": "def_fixture_rows",
        },
        "movable_objects": [
            {"id": "npu_softmacro", "type": "macro", "width_um": 120, "height_um": 120}
        ],
        "fixed_objects": [],
        "objective": {
            "primary": "chipbench_d_macro_placed_def_fixture_conversion",
            "secondary": ["downstream_openroad_replay"],
        },
        "replay": {
            "deterministic_command": "make openlane-smoke",
            "expected_report": "build/ai_eda/converted_external_fixtures/validation/conversion_report.json",
        },
    }
    paths = [write_json(out_dir, design_bundle), write_json(out_dir, placement_case)]
    return [
        {
            "source": "ChiPBench-D fixture",
            "schema": design_bundle["schema"],
            "json": str(paths[0].relative_to(ROOT)),
        },
        {
            "source": "ChiPBench-D fixture",
            "schema": placement_case["schema"],
            "json": str(paths[1].relative_to(ROOT)),
        },
    ]


def convert_circuitnet(out_dir: Path) -> list[dict[str, Any]]:
    path = FIXTURE_ROOT / "circuitnet/feature.json"
    feature = json.loads(path.read_text(encoding="utf-8"))
    record = {
        "schema": "eda.graph_sample.v1",
        "id": "circuitnet-fixture-e1-toy-graph-sample",
        "design_bundle_id": "circuitnet-fixture-e1-toy-design-bundle",
        "claim_boundary": CLAIM_BOUNDARY,
        "graph": {
            "node_features": feature["node_features"],
            "edge_features": feature["edge_features"],
            "coordinate_system": "fixture_um",
        },
        "labels": {
            "label_status": feature["labels"]["label_status"],
            "label_sources": ["circuitnet_fixture_feature_json"],
        },
        "provenance": {
            "generated_by": "scripts/ai_eda/convert_external_fixture_corpora.py",
            "source_records": [str(path.relative_to(ROOT))],
        },
    }
    out_path = write_json(out_dir, record)
    return [
        {
            "source": "CircuitNet feature fixture",
            "schema": record["schema"],
            "json": str(out_path.relative_to(ROOT)),
        }
    ]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default=datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    out_dir = args.out_root / args.run_id / "records"
    out_dir.mkdir(parents=True, exist_ok=True)
    converted: list[dict[str, Any]] = []
    converted.extend(convert_macroplacement(out_dir))
    converted.extend(convert_chipbench(out_dir))
    converted.extend(convert_circuitnet(out_dir))
    report = {
        "schema": "eliza.ai_eda.external_fixture_conversion_report.v1",
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "release_use_allowed": False,
        "converted_record_count": len(converted),
        "converted_records": converted,
        "next_actions": [
            "Run the same converters against pinned external caches after license review.",
            "Attach file hashes and split IDs for real converted samples.",
            "Replay placement candidates through OpenROAD/OpenLane before accepting labels.",
        ],
    }
    report_path = args.out_root / args.run_id / "conversion_report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.external_fixture_conversion {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
