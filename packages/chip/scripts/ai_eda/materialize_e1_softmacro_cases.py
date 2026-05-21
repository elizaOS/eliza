#!/usr/bin/env python3
"""Materialize generated E1 softmacro placement cases for local baselines."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/e1_softmacro_cases"
CLAIM_BOUNDARY = "generated_e1_softmacro_case_only_no_openroad_replay_or_release_claim"
SOURCE_INPUTS = (
    ROOT / "rtl/npu/e1_npu.sv",
    ROOT / "research/alpha_chip_macro_placement/06_e1_notes/softmacro_benchmark_2026-05-19.md",
    ROOT / "research/alpha_chip_macro_placement/06_e1_notes/macro_inventory.md",
)


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


def source_record(path: Path) -> dict[str, Any]:
    return {
        "path": rel(path),
        "exists": path.exists(),
        "sha256": sha256_file(path) if path.exists() else None,
    }


def softmacro_objects(grid: int, *, origin_um: float, pitch_um: float, size_um: float) -> list[dict[str, Any]]:
    objects: list[dict[str, Any]] = []
    for row in range(grid):
        for col in range(grid):
            objects.append(
                {
                    "id": f"e1_npu_tile_r{row}_c{col}",
                    "type": "e1_generated_softmacro",
                    "width_um": size_um,
                    "height_um": size_um,
                    "source": "generated_from_e1_npu_tile_grid",
                    "target_placement": {
                        "x_um": origin_um + col * pitch_um,
                        "y_um": origin_um + row * pitch_um,
                        "orientation": "N",
                        "source": "deterministic_grid_reference",
                    },
                }
            )
    return objects


def build_records(grid: int) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    die_max = 3200.0 if grid <= 4 else 5200.0
    core_margin = 160.0
    size = 180.0 if grid <= 4 else 120.0
    pitch = (die_max - 2 * core_margin - size) / max(grid - 1, 1)
    objects = softmacro_objects(grid, origin_um=core_margin, pitch_um=pitch, size_um=size)
    design_id = f"e1-generated-softmacro-{grid}x{grid}-design-bundle"
    case_id = f"e1-generated-softmacro-{grid}x{grid}-placement-case"
    design_bundle = {
        "schema": "eda.design_bundle.v1",
        "id": design_id,
        "design": {
            "name": f"e1_npu_softmacro_{grid}x{grid}",
            "revision": "local_worktree_generated",
            "top_module": "e1_npu",
        },
        "sources": {
            "rtl": [source_record(ROOT / "rtl/npu/e1_npu.sv")],
            "manifests": [source_record(path) for path in SOURCE_INPUTS[1:]],
        },
        "constraints": {
            "clocks": [{"name": "clk", "period_ns": 10.0}],
            "resets": [{"name": "rst_n", "active": "low"}],
            "softmacro_grid": f"{grid}x{grid}",
        },
        "technology": {
            "node": "E1 softmacro abstract",
            "pdk": "none_abstract_case",
            "flow": "generated_ai_eda_case_for_policy_training",
        },
        "claim_boundary": CLAIM_BOUNDARY,
    }
    placement_case = {
        "schema": "eda.placement_case.v1",
        "id": case_id,
        "design_bundle_id": design_id,
        "floorplan": {
            "die_area_um": [0.0, 0.0, die_max, die_max],
            "core_area_um": [core_margin, core_margin, die_max - core_margin, die_max - core_margin],
            "rows": f"abstract_{grid}x{grid}_softmacro_rows",
            "macro_pitch_um": pitch,
        },
        "movable_objects": objects,
        "fixed_objects": [
            {
                "id": "e1_io_ring_keepout",
                "type": "boundary_keepout",
                "margin_um": core_margin,
            }
        ],
        "objective": {
            "primary": "deterministic_openroad_replay_pass_when_converted_to_real_macros",
            "secondary": [
                "preserve_npu_tile_locality",
                "minimize_inter_tile_wirelength_proxy",
                "leave_io_and_pdn_keepouts",
            ],
        },
        "replay": {
            "deterministic_command": "python3 scripts/ai_eda/materialize_e1_softmacro_cases.py --run-id validation",
            "expected_report": "build/ai_eda/e1_softmacro_cases/validation/materialization_report.json",
        },
        "claim_boundary": CLAIM_BOUNDARY,
    }
    flow_run = {
        "schema": "eda.flow_run.v1",
        "id": f"e1-generated-softmacro-{grid}x{grid}-flow-run-blocked",
        "design_bundle_id": design_id,
        "toolchain": {
            "tools": ["abstract-generator"],
            "version_capture": "scripts/ai_eda/materialize_e1_softmacro_cases.py",
        },
        "command": "python3 scripts/ai_eda/materialize_e1_softmacro_cases.py --run-id validation",
        "inputs": {
            "design_bundle": design_id,
            "placement_case": case_id,
            "source_hashes": [source_record(path) for path in SOURCE_INPUTS],
        },
        "outputs": {
            "reports": [],
            "artifacts": [],
        },
        "metrics": {
            "label_status": "generated_reference_grid_no_openroad_replay",
            "macro_count": len(objects),
            "grid": f"{grid}x{grid}",
        },
        "status": {
            "result": "BLOCKED_ABSTRACT_CASE_NO_OPENROAD_REPLAY",
            "blockers": [
                "softmacro case must be converted to real macro LEF/DEF before PD evidence",
                "OpenLane/OpenROAD replay not run",
            ],
        },
        "claim_boundary": CLAIM_BOUNDARY,
    }
    return design_bundle, placement_case, flow_run


def write_json(out_dir: Path, filename: str, record: dict[str, Any]) -> Path:
    path = out_dir / filename
    path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--grid", action="append", type=int, default=[])
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    grids = args.grid or [4, 8]
    out_dir = args.out_root / args.run_id / "records"
    out_dir.mkdir(parents=True, exist_ok=True)
    records: list[dict[str, Any]] = []
    for grid in grids:
        if grid < 1:
            raise SystemExit("--grid must be positive")
        design_bundle, placement_case, flow_run = build_records(grid)
        for suffix, record in (
            ("design-bundle", design_bundle),
            ("placement-case", placement_case),
            ("flow-run", flow_run),
        ):
            path = write_json(out_dir, f"{record['id']}.{suffix}.json", record)
            records.append({"id": record["id"], "schema": record["schema"], "path": rel(path)})

    report = {
        "schema": "eliza.ai_eda.e1_softmacro_case_materialization_report.v1",
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "grids": grids,
        "records": records,
        "source_inputs": [source_record(path) for path in SOURCE_INPUTS],
        "release_use_allowed": False,
    }
    report_path = args.out_root / args.run_id / "materialization_report.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "STATUS: PASS ai_eda.e1_softmacro_cases "
        f"grids={','.join(str(grid) for grid in grids)} records={len(records)} {rel(report_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
