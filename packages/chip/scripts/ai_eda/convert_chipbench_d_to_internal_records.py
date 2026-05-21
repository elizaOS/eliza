#!/usr/bin/env python3
"""Convert bounded real ChiPBench-D payload cases into internal records."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PAYLOAD = ROOT / "external/datasets/chipbench-d/payload"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/chipbench_d"
CLAIM_BOUNDARY = "chipbench_d_conversion_training_only_no_e1_signoff_or_release_claim"


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
        "exists": path.exists(),
        "bytes": path.stat().st_size if path.exists() else None,
        "sha256": sha256_file(path) if path.exists() else None,
    }


def safe_id(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", text)


def def_units(text: str) -> float:
    match = re.search(r"UNITS\s+DISTANCE\s+MICRONS\s+(\d+)\s*;", text)
    return float(match.group(1)) if match else 1000.0


def parse_die_area(text: str, units: float) -> list[float]:
    match = re.search(
        r"DIEAREA\s+\(\s*(-?\d+)\s+(-?\d+)\s*\)\s+\(\s*(-?\d+)\s+(-?\d+)\s*\)\s*;",
        text,
    )
    if not match:
        return [0.0, 0.0, 0.0, 0.0]
    return [round(float(value) / units, 6) for value in match.groups()]


def row_summary(text: str, units: float) -> dict[str, Any]:
    rows = []
    for match in re.finditer(
        r"^ROW\s+(\S+)\s+(\S+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s+DO\s+(\d+)\s+BY\s+(\d+)\s+STEP\s+(-?\d+)\s+(-?\d+)\s*;",
        text,
        flags=re.MULTILINE,
    ):
        rows.append(
            {
                "name": match.group(1),
                "site": match.group(2),
                "x_um": round(float(match.group(3)) / units, 6),
                "y_um": round(float(match.group(4)) / units, 6),
                "orient": match.group(5),
                "do_x": int(match.group(6)),
                "do_y": int(match.group(7)),
                "step_x_um": round(float(match.group(8)) / units, 6),
                "step_y_um": round(float(match.group(9)) / units, 6),
            }
        )
    if not rows:
        return {"count": 0, "sample": []}
    return {
        "count": len(rows),
        "sample": rows[:5],
        "min_y_um": min(row["y_um"] for row in rows),
        "max_y_um": max(row["y_um"] for row in rows),
    }


def parse_macro_sizes(lef_dir: Path) -> dict[str, dict[str, Any]]:
    sizes: dict[str, dict[str, Any]] = {}
    for lef in sorted(lef_dir.glob("*.lef")):
        if lef.name.startswith("NangateOpenCellLibrary"):
            continue
        text = lef.read_text(encoding="utf-8", errors="replace")
        for match in re.finditer(
            r"MACRO\s+(\S+).*?SIZE\s+([-+0-9.eE]+)\s+BY\s+([-+0-9.eE]+)\s*;",
            text,
            flags=re.DOTALL,
        ):
            sizes[match.group(1)] = {
                "width_um": float(match.group(2)),
                "height_um": float(match.group(3)),
                "lef": rel(lef),
            }
    return sizes


def parse_components(
    def_path: Path, macro_sizes: dict[str, dict[str, Any]]
) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    text = def_path.read_text(encoding="utf-8", errors="replace")
    units = def_units(text)
    components: dict[str, dict[str, Any]] = {}
    total = 0
    for match in re.finditer(
        r"^\s*-\s+(\S+)\s+(\S+)\s+\+\s+(PLACED|FIXED|COVER)\s+\(\s*(-?\d+)\s+(-?\d+)\s*\)\s+(\S+)\s*;",
        text,
        flags=re.MULTILINE,
    ):
        total += 1
        inst, master, status, x_raw, y_raw, orient = match.groups()
        if master not in macro_sizes:
            continue
        size = macro_sizes[master]
        components[inst] = {
            "id": inst,
            "type": "hard_macro",
            "macro_name": master,
            "status": status,
            "x_um": round(float(x_raw) / units, 6),
            "y_um": round(float(y_raw) / units, 6),
            "orientation": orient,
            "width_um": size["width_um"],
            "height_um": size["height_um"],
            "source_lef": size["lef"],
        }
    return components, {
        "component_count": total,
        "macro_component_count": len(components),
        "units_per_micron": units,
        "die_area_um": parse_die_area(text, units),
        "rows": row_summary(text, units),
    }


def case_dirs(payload: Path) -> list[Path]:
    data_dir = payload / "data"
    if not data_dir.exists():
        return []
    return sorted(path for path in data_dir.iterdir() if path.is_dir())


def find_netlist(case_dir: Path, case_name: str) -> Path | None:
    preferred = case_dir / f"{case_name}.v"
    if preferred.exists():
        return preferred
    matches = sorted(case_dir.glob("*.v"))
    return matches[0] if matches else None


def convert_case(case_dir: Path, out_dir: Path, payload: Path) -> list[dict[str, Any]]:
    case_name = case_dir.name
    case_id = safe_id(case_name)
    pre_def = case_dir / "def/pre_place.def"
    placed_def = case_dir / "def/macro_placed.def"
    lef_dir = case_dir / "lef"
    lib_dir = case_dir / "lib"
    sdc = case_dir / "constraint.sdc"
    netlist = find_netlist(case_dir, case_name)
    if not pre_def.exists() or not placed_def.exists() or not lef_dir.exists() or netlist is None:
        raise ValueError(f"{case_dir}: missing required ChiPBench-D files")

    macro_sizes = parse_macro_sizes(lef_dir)
    pre_macros, pre_summary = parse_components(pre_def, macro_sizes)
    placed_macros, placed_summary = parse_components(placed_def, macro_sizes)
    movable = []
    for inst, item in sorted((pre_macros or placed_macros).items()):
        target = placed_macros.get(inst)
        record = dict(item)
        if target:
            record["target_placement"] = {
                "x_um": target["x_um"],
                "y_um": target["y_um"],
                "orientation": target["orientation"],
                "source": rel(placed_def),
            }
        movable.append(record)

    design_id = f"chipbench-d-{case_id}-design-bundle"
    placement_id = f"chipbench-d-{case_id}-placement-case"
    flow_id = f"chipbench-d-{case_id}-flow-run"
    lef_files = sorted(lef_dir.glob("*.lef"))
    lib_files = sorted(lib_dir.glob("*.lib")) if lib_dir.exists() else []
    design_bundle = {
        "schema": "eda.design_bundle.v1",
        "id": design_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "design": {
            "name": case_name,
            "revision": "chipbench_d_local_payload",
            "top_module": case_name,
        },
        "sources": {
            "rtl": [file_record(netlist)],
            "manifests": [
                file_record(payload / "README.md"),
                file_record(payload / "chipbench_meta_data.json"),
                file_record(pre_def),
                file_record(placed_def),
                file_record(sdc),
            ],
            "lef": [file_record(path) for path in lef_files],
            "lib": [file_record(path) for path in lib_files],
        },
        "constraints": {"clocks": [], "resets": [], "sdc": file_record(sdc)},
        "technology": {
            "node": "Nangate45_FreePDK45_public_benchmark",
            "pdk": "Nangate45_OpenROAD_benchmark_collateral",
            "flow": "ChiPBench-D/OpenROAD Hier-RTLMP macro placement",
        },
    }
    placement_case = {
        "schema": "eda.placement_case.v1",
        "id": placement_id,
        "design_bundle_id": design_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "floorplan": {
            "die_area_um": pre_summary["die_area_um"],
            "core_area_um": pre_summary["die_area_um"],
            "rows": pre_summary["rows"],
            "pre_place_def": file_record(pre_def),
            "macro_placed_def": file_record(placed_def),
        },
        "movable_objects": movable,
        "fixed_objects": [],
        "objective": {
            "primary": "learn_or_compare_macro_placement_against_chipbench_hier_rtlmp_target",
            "secondary": [
                "downstream_openroad_replay_required",
                "ppa_labels_must_come_from_deterministic_replay",
                "do_not_use_as_e1_signoff",
            ],
        },
        "replay": {
            "deterministic_command": "python3 scripts/ai_eda/convert_chipbench_d_to_internal_records.py --run-id <run-id>",
            "expected_report": "build/ai_eda/chipbench_d/<run-id>/conversion_report.json",
        },
    }
    flow_run = {
        "schema": "eda.flow_run.v1",
        "id": flow_id,
        "design_bundle_id": design_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "toolchain": {
            "tools": ["ChiPBench-D public dataset export", "OpenROAD Hier-RTLMP target placement"],
            "version_capture": "external/datasets/chipbench-d/manifest.yaml",
        },
        "command": "python3 scripts/ai_eda/convert_chipbench_d_to_internal_records.py --run-id <run-id>",
        "inputs": {
            "pre_place_def": file_record(pre_def),
            "macro_placed_def": file_record(placed_def),
            "design_bundle": design_id,
            "placement_case": placement_id,
        },
        "outputs": {"reports": [], "artifacts": [rel(pre_def), rel(placed_def)]},
        "metrics": {
            "label_status": "public_chipbench_d_macro_targets_training_only_not_e1_signoff",
            "pre_place": pre_summary,
            "macro_placed": placed_summary,
            "macro_target_count": len([item for item in movable if "target_placement" in item]),
        },
        "status": {
            "result": "CONVERTED_PUBLIC_DATASET_LABELS_NOT_REPLAYED",
            "blockers": [
                "not generated from local E1 OpenLane/OpenROAD replay",
                "ChiPBench-D target placement must be replayed before PPA claims",
                "license/provenance review remains required before release use",
            ],
        },
    }
    paths = []
    for record in (design_bundle, placement_case, flow_run):
        path = out_dir / f"{record['id']}.json"
        path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        paths.append(path)
    return [
        {
            "case": case_name,
            "schema": record["schema"],
            "json": rel(path),
            "macro_count": len(movable),
            "target_count": flow_run["metrics"]["macro_target_count"],
        }
        for record, path in zip((design_bundle, placement_case, flow_run), paths)
    ]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--payload", type=Path, default=DEFAULT_PAYLOAD)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument("--sample-limit", type=int, default=3)
    parser.add_argument(
        "--all-records",
        action="store_true",
        help="Convert every discovered case unless --case filters are provided.",
    )
    parser.add_argument("--case", action="append", default=[])
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.all_records and args.sample_limit <= 0:
        raise SystemExit("--sample-limit must be positive")
    if not args.payload.exists():
        print(f"STATUS: BLOCKED ai_eda.chipbench_d missing_payload {args.payload}")
        return 2
    available = case_dirs(args.payload)
    if args.case:
        wanted = set(args.case)
        selected = [path for path in available if path.name in wanted]
        missing = sorted(wanted - {path.name for path in selected})
        if missing:
            raise SystemExit(f"missing ChiPBench-D cases: {', '.join(missing)}")
    else:
        selected = available if args.all_records else available[: args.sample_limit]
    out_dir = args.out_root / args.run_id / "records"
    out_dir.mkdir(parents=True, exist_ok=True)
    for stale_record in out_dir.glob("chipbench-d-*.json"):
        stale_record.unlink()
    converted: list[dict[str, Any]] = []
    for case_dir in selected:
        converted.extend(convert_case(case_dir, out_dir, args.payload))
    report = {
        "schema": "eliza.ai_eda.chipbench_d_conversion_report.v1",
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "payload": rel(args.payload),
        "available_case_count": len(available),
        "converted_case_count": len(selected),
        "conversion_mode": "all_records" if args.all_records and not args.case else "case_filter" if args.case else "sample_limit",
        "sample_limit": None if args.all_records or args.case else args.sample_limit,
        "record_count": len(converted),
        "converted": converted,
        "policy": {
            "release_use_allowed": False,
            "training_use_only_until_license_review": True,
            "e1_signoff_evidence": False,
            "deterministic_replay_required_for_ppa_claims": True,
        },
    }
    report_path = args.out_root / args.run_id / "conversion_report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "STATUS: PASS ai_eda.chipbench_d_conversion "
        f"cases={len(selected)} records={len(converted)} available_cases={len(available)} {report_path}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
