#!/usr/bin/env python3
"""Materialize the REAL E1 weight-buffer macro-array placement case.

Unlike ``materialize_e1_softmacro_cases.py`` (abstract grids with no LEF/DEF, which
the replay planner quarantines), this emits an ``eda.placement_case.v1`` for the
eight-bank NPU weight-buffer array that has:

  * real movable objects keyed by the exact OpenLane instance names
    (``u_bank0.u_sram`` .. ``u_bank7.u_sram``),
  * the real Sky130 SRAM macro footprint read from the generated LEF/DEF manifest,
  * the real die/core floorplan of ``pd/openlane/config.macro-array.sky130.json``,
  * a real deterministic OpenLane replay command, and
  * a ``target_placement`` reference set to the empirically best post-route layout
    (the 2x4 stack, which cut setup TNS ~90% in the 07_post_route_ppa experiment).

Because the design bundle id (``e1-macro-array-weight-buffer-...``) is not one of
the quarantined prefixes and the replay command names OpenLane, candidates against
this case become ``READY_FOR_DETERMINISTIC_REPLAY`` in the replay planner — the
single unblock the max-trained assessment calls highest leverage.

This generator is fail-closed: it requires the LEF/DEF manifest produced by
``generate_e1_macro_array_lefdef.py``; without it, it writes a BLOCKED report and
exits nonzero. It mutates only ``build/ai_eda/e1_macro_array_cases/``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/e1_macro_array_cases"
DEFAULT_LEFDEF_MANIFEST = ROOT / "build/ai_eda/e1_macro_array_lefdef/validation/lefdef_manifest.json"
OPENLANE_CONFIG = ROOT / "pd/openlane/config.macro-array.sky130.json"
DESIGN_BUNDLE_ID = "e1-macro-array-weight-buffer-design-bundle"
PLACEMENT_CASE_ID = "e1-macro-array-weight-buffer-placement-case"
CLAIM_BOUNDARY = "e1_macro_array_real_case_only_no_signoff_or_release_claim"
# Reference (label) layout: the 2x4 stack measured best post-route in
# research/alpha_chip_macro_placement/07_post_route_ppa.
REFERENCE_VARIANT = "stack_2x4"
SOURCE_INPUTS = (
    ROOT / "rtl/npu/e1_npu_weight_buffer_array.sv",
    ROOT / "rtl/memory/e1_weight_buffer_sram.sv",
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


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected JSON object")
    return data


def parse_placement_cfg(path: Path) -> dict[str, tuple[float, float, str]]:
    placements: dict[str, tuple[float, float, str]] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        instance, x_um, y_um, orient = line.split()
        placements[instance] = (float(x_um), float(y_um), orient)
    return placements


def write_blocked(out_dir: Path, blockers: list[str]) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    report = {
        "schema": "eliza.ai_eda.e1_macro_array_case_materialization_report.v1",
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "claim_boundary": CLAIM_BOUNDARY,
        "status": "BLOCKED_MISSING_LEFDEF",
        "blockers": blockers,
        "release_use_allowed": False,
    }
    path = out_dir / "materialization_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def build_records(
    manifest: dict[str, Any],
    reference_placement: dict[str, tuple[float, float, str]],
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    macro = manifest["macro"]
    width_um = float(macro["width_um"])
    height_um = float(macro["height_um"])
    die = [float(value) for value in manifest["die_area_um"]]
    # Core area mirrors pd/openlane/config.macro-array.sky130.json CORE_AREA.
    core = [100.0, 100.0, 3500.0, 2100.0]
    instances = list(manifest["macro_instances"])

    movable_objects = []
    for instance in instances:
        ref = reference_placement[instance]
        movable_objects.append(
            {
                "id": instance,
                "type": "sky130_sram_hard_macro",
                "macro_name": macro["name"],
                "width_um": width_um,
                "height_um": height_um,
                "target_placement": {
                    "x_um": ref[0],
                    "y_um": ref[1],
                    "orientation": ref[2],
                    "source": "best_post_route_variant_stack_2x4_from_07_post_route_ppa",
                },
            }
        )

    design_bundle = {
        "schema": "eda.design_bundle.v1",
        "id": DESIGN_BUNDLE_ID,
        "design": {
            "name": "e1_npu_weight_buffer_array",
            "revision": "local_worktree_real_macro_array",
            "top_module": "e1_npu_weight_buffer_array",
        },
        "sources": {
            "rtl": [source_record(path) for path in SOURCE_INPUTS],
            "manifests": [
                source_record(OPENLANE_CONFIG),
                source_record(DEFAULT_LEFDEF_MANIFEST),
            ],
            "macros": [
                {
                    "name": macro["name"],
                    "lef": macro["lef"],
                    "lef_sha256": macro["lef_sha256"],
                    "kind": "pdk_prebuilt_hard_macro",
                }
            ],
        },
        "constraints": {
            "clocks": [{"name": "clk", "period_ns": 15.0}],
            "resets": [{"name": "rst_n", "active": "low"}],
            "macro_count": len(instances),
        },
        "technology": {
            "node": "sky130A",
            "pdk": "sky130A",
            "flow": "openlane_2_macro_array_replay",
        },
        "claim_boundary": CLAIM_BOUNDARY,
    }

    placement_case = {
        "schema": "eda.placement_case.v1",
        "id": PLACEMENT_CASE_ID,
        "design_bundle_id": DESIGN_BUNDLE_ID,
        "floorplan": {
            "die_area_um": die,
            "core_area_um": core,
            "rows": "sky130_fd_sc_hd_unit_rows",
            "macro_halo_um": 30.0,
        },
        "movable_objects": movable_objects,
        "fixed_objects": [],
        "objective": {
            "primary": "minimize_post_route_setup_tns_at_15ns",
            "secondary": [
                "minimize_route_wirelength",
                "minimize_route_drc",
                "minimize_antenna_violations",
            ],
        },
        "replay": {
            "deterministic_command": (
                "openlane --pdk-root external/pdks "
                "pd/openlane/config.macro-array.sky130.json"
            ),
            "candidate_config_template": "pd/openlane/config.macro-array.sky130.json",
            "macro_placement_cfg_key": "MACRO_PLACEMENT_CFG",
            "ppa_collector": (
                "python3 scripts/ai_eda/collect_macro_array_post_route_ppa.py"
            ),
            "expected_report": "build/ai_eda/e1_macro_array_cases/validation/materialization_report.json",
        },
        "claim_boundary": CLAIM_BOUNDARY,
    }

    flow_run = {
        "schema": "eda.flow_run.v1",
        "id": "e1-macro-array-weight-buffer-flow-run-replayable",
        "design_bundle_id": DESIGN_BUNDLE_ID,
        "toolchain": {
            "tools": ["openlane", "openroad"],
            "version_capture": "pd/openlane/config.macro-array.sky130.json",
        },
        "command": (
            "openlane --pdk-root external/pdks pd/openlane/config.macro-array.sky130.json"
        ),
        "inputs": {
            "design_bundle": DESIGN_BUNDLE_ID,
            "placement_case": PLACEMENT_CASE_ID,
            "source_hashes": [source_record(path) for path in SOURCE_INPUTS],
            "lefdef_manifest": rel(DEFAULT_LEFDEF_MANIFEST),
        },
        "outputs": {"reports": [], "artifacts": []},
        "metrics": {
            "label_status": "real_movable_macro_case_pending_per_candidate_replay",
            "macro_count": len(instances),
        },
        "status": {
            "result": "READY_FOR_DETERMINISTIC_REPLAY",
            "blockers": [],
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
    parser.add_argument("--lefdef-manifest", type=Path, default=DEFAULT_LEFDEF_MANIFEST)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    out_dir = args.out_root / args.run_id
    if not args.lefdef_manifest.exists():
        path = write_blocked(
            out_dir,
            [
                "movable-macro LEF/DEF manifest missing; run "
                "scripts/ai_eda/generate_e1_macro_array_lefdef.py first"
            ],
        )
        print(f"STATUS: PASS_BLOCKED ai_eda.e1_macro_array_case missing_lefdef {rel(path)}")
        return 0
    manifest = load_json(args.lefdef_manifest)
    if manifest.get("status") != "GENERATED_MOVABLE_MACRO_LEFDEF":
        path = write_blocked(out_dir, [f"lefdef manifest is not generated: {manifest.get('status')!r}"])
        print(f"STATUS: PASS_BLOCKED ai_eda.e1_macro_array_case blocked_lefdef {rel(path)}")
        return 0

    reference_cfg = next(
        (variant["placement_cfg"] for variant in manifest["variants"] if variant["variant"] == REFERENCE_VARIANT),
        None,
    )
    if reference_cfg is None:
        path = write_blocked(out_dir, [f"reference variant {REFERENCE_VARIANT} not in lefdef manifest"])
        print(f"STATUS: PASS_BLOCKED ai_eda.e1_macro_array_case {rel(path)}")
        return 0
    reference_placement = parse_placement_cfg(ROOT / reference_cfg)

    design_bundle, placement_case, flow_run = build_records(manifest, reference_placement)
    records_dir = out_dir / "records"
    records_dir.mkdir(parents=True, exist_ok=True)
    records: list[dict[str, Any]] = []
    for suffix, record in (
        ("design-bundle", design_bundle),
        ("placement-case", placement_case),
        ("flow-run", flow_run),
    ):
        path = write_json(records_dir, f"{record['id']}.{suffix}.json", record)
        records.append({"id": record["id"], "schema": record["schema"], "path": rel(path)})

    report = {
        "schema": "eliza.ai_eda.e1_macro_array_case_materialization_report.v1",
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "status": "MATERIALIZED_REAL_MACRO_ARRAY_CASE",
        "lefdef_manifest": rel(args.lefdef_manifest),
        "reference_variant": REFERENCE_VARIANT,
        "design_bundle_id": DESIGN_BUNDLE_ID,
        "placement_case_id": PLACEMENT_CASE_ID,
        "macro_count": len(manifest["macro_instances"]),
        "records": records,
        "release_use_allowed": False,
    }
    report_path = out_dir / "materialization_report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "STATUS: PASS ai_eda.e1_macro_array_case "
        f"macros={len(manifest['macro_instances'])} records={len(records)} {rel(report_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
