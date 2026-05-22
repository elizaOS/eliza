#!/usr/bin/env python3
"""Convert checked-in E1 OpenLane inputs into internal AI-EDA records."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = ROOT / "pd/openlane/config.sky130.json"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/e1_openlane_conversion"
CLAIM_BOUNDARY = "e1_openlane_conversion_only_no_training_inference_ppa_or_release_claim"
KNOWN_MACRO_SIZES_UM = {
    "sky130_sram_2kbyte_1rw1r_32x512_8": {
        "width_um": 659.98,
        "height_um": 398.18,
        "source": "known_sky130_sram_macros_lef_size_fallback",
    },
}


def sha256(path: Path) -> str | None:
    if not path.exists() or not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"{path}: expected JSON object")
    return data


def resolve_openlane_path(value: str, config_dir: Path) -> Path:
    if value.startswith("dir::"):
        return (config_dir / value.removeprefix("dir::")).resolve()
    return (ROOT / value).resolve()


def lef_size(path: Path) -> tuple[float, float] | None:
    if not path.is_file():
        return None
    match = re.search(
        r"\bSIZE\s+([0-9.]+)\s+BY\s+([0-9.]+)\s*;",
        path.read_text(encoding="utf-8", errors="ignore"),
        flags=re.IGNORECASE,
    )
    if not match:
        return None
    return float(match.group(1)), float(match.group(2))


def parse_area(area: str | list[Any]) -> list[float]:
    if isinstance(area, str):
        return [float(part) for part in area.split()]
    return [float(part) for part in area]


def file_record(path: Path) -> dict[str, Any]:
    exists = path.exists()
    return {
        "path": rel(path) if path.exists() or ROOT in path.parents else str(path),
        "exists": exists,
        "sha256": sha256(path),
    }


def rtl_records(config: dict[str, Any], config_dir: Path) -> list[dict[str, Any]]:
    records = []
    for item in config.get("VERILOG_FILES", []):
        path = resolve_openlane_path(str(item), config_dir)
        records.append(file_record(path))
    return records


def manifest_records(
    config_path: Path, config: dict[str, Any], config_dir: Path
) -> list[dict[str, Any]]:
    paths = [config_path, ROOT / "sw/platform/e1_platform_contract.json"]
    for key in ("PNR_SDC_FILE", "SIGNOFF_SDC_FILE", "IO_PIN_ORDER_CFG"):
        value = config.get(key)
        if isinstance(value, str):
            paths.append(resolve_openlane_path(value, config_dir))
    return [file_record(path) for path in paths]


def macro_objects(config: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    movable: list[dict[str, Any]] = []
    fixed: list[dict[str, Any]] = []
    for macro_name, macro in config.get("MACROS", {}).items():
        if not isinstance(macro, dict):
            continue
        lef_paths_value = macro.get("lef")
        lef_paths: list[Any] = lef_paths_value if isinstance(lef_paths_value, list) else []
        size = None
        size_source = None
        for lef_value in lef_paths:
            if not isinstance(lef_value, str):
                continue
            parsed = lef_size(resolve_openlane_path(lef_value, ROOT / "pd/openlane"))
            if parsed:
                size = parsed
                size_source = "lef"
                break
        if size is None and macro_name in KNOWN_MACRO_SIZES_UM:
            fallback: dict[str, Any] = KNOWN_MACRO_SIZES_UM[macro_name]
            size = (float(fallback["width_um"]), float(fallback["height_um"]))
            size_source = str(fallback["source"])
        for inst_name, inst in macro.get("instances", {}).items():
            location = (
                inst.get("location", [None, None]) if isinstance(inst, dict) else [None, None]
            )
            x_um = float(location[0]) if location[0] is not None else 0.0
            y_um = float(location[1]) if location[1] is not None else 0.0
            width_um, height_um = size if size else (1.0, 1.0)
            item = {
                "id": inst_name,
                "type": "hard_macro",
                "macro_name": macro_name,
                "width_um": width_um,
                "height_um": height_um,
                "x_um": x_um,
                "y_um": y_um,
                "orientation": inst.get("orientation") if isinstance(inst, dict) else None,
                "source": "pd/openlane/MACROS",
                "size_source": size_source or "missing_lef_size_default_1um",
                "target_placement": {
                    "x_um": x_um,
                    "y_um": y_um,
                    "orientation": inst.get("orientation") if isinstance(inst, dict) else "N",
                    "source": "checked_in_openlane_macro_seed",
                },
            }
            movable.append(item)
    return movable, fixed


def build_records(config_path: Path, run_id: str) -> dict[str, Any]:
    config = load_json(config_path)
    config_dir = config_path.parent
    design_name = str(config.get("DESIGN_NAME", "e1_chip_top"))
    pdk = str(config.get("PDK", "unknown"))
    design_bundle_id = f"{design_name}-{pdk}-openlane-design-bundle"
    placement_case_id = f"{design_name}-{pdk}-openlane-placement-case"
    flow_run_id = f"{design_name}-{pdk}-openlane-flow-run-{run_id}"
    rtl = rtl_records(config, config_dir)
    manifests = manifest_records(config_path, config, config_dir)
    movable, fixed = macro_objects(config)
    openlane_run_dir = ROOT / "build/openlane" / design_name
    reports_dir = openlane_run_dir / "reports"
    results_dir = openlane_run_dir / "results"
    run_present = reports_dir.exists() or results_dir.exists()

    design_bundle = {
        "schema": "eda.design_bundle.v1",
        "id": design_bundle_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "design": {
            "name": design_name,
            "revision": "local_worktree",
            "top_module": design_name,
        },
        "sources": {
            "rtl": rtl,
            "manifests": manifests,
            "missing_files": [item for item in [*rtl, *manifests] if not item["exists"]],
        },
        "constraints": {
            "clocks": [
                {
                    "name": str(config.get("CLOCK_PORT", "CLK_IN")),
                    "period_ns": float(config.get("CLOCK_PERIOD", 0)),
                }
            ],
            "resets": [{"name": "RST_N", "active": "low"}],
            "sdc": config.get("PNR_SDC_FILE") or config.get("SIGNOFF_SDC_FILE"),
            "io_pin_order": config.get("IO_PIN_ORDER_CFG"),
        },
        "technology": {
            "node": pdk,
            "pdk": pdk,
            "flow": "openlane_openroad",
            "std_cell_library": config.get("STD_CELL_LIBRARY"),
        },
    }

    placement_case = {
        "schema": "eda.placement_case.v1",
        "id": placement_case_id,
        "design_bundle_id": design_bundle_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "floorplan": {
            "die_area_um": parse_area(config.get("DIE_AREA", "0 0 0 0")),
            "core_area_um": parse_area(config.get("CORE_AREA", "0 0 0 0")),
            "rows": "openlane_generated_rows_after_floorplan",
            "core_utilization_pct": config.get("FP_CORE_UTIL"),
            "target_density": config.get("PL_TARGET_DENSITY"),
            "macro_halo_um": {
                "horizontal": config.get("FP_MACRO_HORIZONTAL_HALO"),
                "vertical": config.get("FP_MACRO_VERTICAL_HALO"),
            },
        },
        "movable_objects": movable,
        "fixed_objects": fixed,
        "objective": {
            "primary": "deterministic_openlane_replay_pass",
            "secondary": [
                "timing_wns_non_negative",
                "magic_drc_zero",
                "lvs_clean",
                "reduce_wirelength_and_congestion",
            ],
        },
        "replay": {
            "deterministic_command": f"openlane --config {rel(config_path)}",
            "expected_report": f"build/ai_eda/e1_openlane_conversion/{run_id}/records/flow-run.json",
        },
    }

    flow_run = {
        "schema": "eda.flow_run.v1",
        "id": flow_run_id,
        "design_bundle_id": design_bundle_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "toolchain": {
            "tools": ["openlane", "openroad", "yosys", "magic", "netgen", "klayout"],
            "version_capture": "scripts/tool_versions.sh",
        },
        "command": f"openlane --config {rel(config_path)}",
        "inputs": {
            "config": file_record(config_path),
            "design_bundle": design_bundle_id,
            "placement_case": placement_case_id,
        },
        "outputs": {
            "reports": [rel(reports_dir)] if reports_dir.exists() else [],
            "artifacts": [rel(results_dir)] if results_dir.exists() else [],
        },
        "metrics": {
            "label_status": "blocked_until_deterministic_openlane_run"
            if not run_present
            else "reports_present_unparsed",
            "required_metrics": [
                "timing_wns_ns",
                "timing_tns_ns",
                "die_area_um2",
                "wirelength_um",
                "congestion_overflow",
                "drc_count",
                "lvs_errors",
                "power_mw",
            ],
        },
        "status": {
            "result": "BLOCKED_NO_OPENLANE_RUN_ARTIFACTS"
            if not run_present
            else "PRESENT_REPORTS_REQUIRE_PARSE",
            "blockers": []
            if run_present
            else ["run OpenLane/OpenROAD replay before using as training labels or PPA evidence"],
        },
    }

    return {
        "design_bundle": design_bundle,
        "placement_case": placement_case,
        "flow_run": flow_run,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--run-id", default=datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    config_path = args.config.resolve()
    records = build_records(config_path, args.run_id)
    out_dir = args.out_root / args.run_id
    records_dir = out_dir / "records"
    records_dir.mkdir(parents=True, exist_ok=True)
    paths = {
        "design_bundle": records_dir / "design-bundle.json",
        "placement_case": records_dir / "placement-case.json",
        "flow_run": records_dir / "flow-run.json",
    }
    for key, path in paths.items():
        path.write_text(json.dumps(records[key], indent=2, sort_keys=True) + "\n")

    report = {
        "schema": "eliza.ai_eda.e1_openlane_conversion_report.v1",
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "config": rel(config_path),
        "records": {key: rel(path) for key, path in paths.items()},
        "release_use_allowed": False,
        "flow_status": records["flow_run"]["status"],
    }
    report_path = out_dir / "conversion-report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.e1_openlane_conversion {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
