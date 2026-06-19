#!/usr/bin/env python3
"""Convert pinned TILOS MacroPlacement cases into internal AI-EDA records."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
PAYLOAD = ROOT / "external/repos/tilos-macroplacement/payload"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/tilos_macroplacement"
CLAIM_BOUNDARY = "tilos_macroplacement_conversion_only_no_training_inference_ppa_or_release_claim"

DEFAULT_CASES = (
    "NanGate45/ariane133",
    "NanGate45/ariane136",
    "NanGate45/bp_quad",
    "NanGate45/mempool_tile",
    "NanGate45/mempool_group",
    "NanGate45/nvdla",
    "ASAP7/ariane133",
    "ASAP7/ariane136",
    "ASAP7/bp_quad",
    "ASAP7/mempool_tile",
    "ASAP7/mempool_group",
    "ASAP7/nvdla",
    "SKY130HD/ariane133",
    "SKY130HD/ariane136",
    "SKY130HD/mempool_tile",
    "SKY130HD/nvdla",
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


def git_revision(path: Path) -> str:
    head = path / ".git/HEAD"
    if not head.exists():
        return "UNKNOWN_NO_GIT_HEAD"
    text = head.read_text(encoding="utf-8").strip()
    if text.startswith("ref: "):
        ref = path / ".git" / text.removeprefix("ref: ")
        if ref.exists():
            return ref.read_text(encoding="utf-8").strip()
    return text


def source_record(path: Path) -> dict[str, Any]:
    return {
        "path": rel(path),
        "sha256": sha256_file(path),
        "exists": path.exists(),
    }


def parse_lef_macros(path: Path) -> dict[str, dict[str, float]]:
    text = path.read_text(encoding="utf-8", errors="replace")
    macros: dict[str, dict[str, float]] = {}
    for match in re.finditer(
        r"MACRO\s+(\S+).*?SIZE\s+([0-9.]+)\s+BY\s+([0-9.]+)\s*;",
        text,
        flags=re.DOTALL,
    ):
        macros[match.group(1)] = {
            "width_um": float(match.group(2)),
            "height_um": float(match.group(3)),
        }
    return macros


def parse_technology_lefs(
    payload: Path, technology: str
) -> tuple[dict[str, dict[str, float]], list[Path]]:
    lef_dir = payload / "Enablements" / technology / "lef"
    macros: dict[str, dict[str, float]] = {}
    lef_paths = sorted(lef_dir.glob("*.lef")) + sorted(lef_dir.glob("*.tlef"))
    for path in lef_paths:
        macros.update(parse_lef_macros(path))
    return macros, lef_paths


def def_units(text: str) -> float:
    match = re.search(r"UNITS\s+DISTANCE\s+MICRONS\s+([0-9]+)\s*;", text)
    return float(match.group(1)) if match else 1000.0


def diearea(text: str, units: float) -> list[float]:
    match = re.search(
        r"DIEAREA\s+\(\s*(-?[0-9]+)\s+(-?[0-9]+)\s*\)\s+\(\s*(-?[0-9]+)\s+(-?[0-9]+)\s*\)",
        text,
    )
    if not match:
        return [0.0, 0.0, 1000.0, 1000.0]
    return [float(value) / units for value in match.groups()]


def core_area(text: str, fallback: list[float]) -> list[float]:
    values: dict[str, float] = {}
    for key in ("LL_X", "LL_Y", "UR_X", "UR_Y"):
        match = re.search(rf"DESIGN\s+FE_CORE_BOX_{key}\s+REAL\s+([0-9.]+)\s*;", text)
        if match:
            values[key] = float(match.group(1))
    if len(values) == 4:
        return [values["LL_X"], values["LL_Y"], values["UR_X"], values["UR_Y"]]
    return fallback


def component_entries(text: str) -> list[str]:
    match = re.search(r"COMPONENTS\s+[0-9]+\s*;(.*?)END COMPONENTS", text, flags=re.DOTALL)
    if not match:
        return []
    entries = []
    for raw in match.group(1).split(";"):
        entry = " ".join(raw.strip().split())
        if entry.startswith("- "):
            entries.append(entry)
    return entries


def parse_components(
    text: str, units: float, lef_macros: dict[str, dict[str, float]]
) -> dict[str, dict[str, Any]]:
    components: dict[str, dict[str, Any]] = {}
    for entry in component_entries(text):
        head = re.match(r"-\s+(.+?)\s+(\S+)(?:\s+\+|$)", entry)
        if not head:
            continue
        name = head.group(1)
        macro_name = head.group(2)
        item: dict[str, Any] = {
            "id": name,
            "type": "hard_macro",
            "macro_name": macro_name,
        }
        item.update(lef_macros.get(macro_name, {}))
        placed = re.search(
            r"\+\s+(PLACED|FIXED)\s+\(\s*(-?[0-9]+)\s+(-?[0-9]+)\s*\)\s+(\S+)",
            entry,
        )
        if placed:
            item["placement_status"] = placed.group(1)
            item["x_um"] = float(placed.group(2)) / units
            item["y_um"] = float(placed.group(3)) / units
            item["orientation"] = placed.group(4)
        components[name] = item
    return components


def slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def discover_cases(payload: Path) -> list[dict[str, str]]:
    cases: list[dict[str, str]] = []
    flows = payload / "Flows"
    for placed_def in sorted(flows.glob("*/*/def/*_fp_placed_macros.def")):
        try:
            _flows, technology, design, _def_dir, filename = placed_def.relative_to(payload).parts
        except ValueError:
            continue
        source_def = placed_def.with_name(filename.replace("_placed_macros.def", ".def"))
        if not source_def.exists():
            continue
        cases.append(
            {
                "technology": technology,
                "design": design,
                "def": rel(source_def),
                "placed_def": rel(placed_def),
            }
        )
    return cases


def select_cases(
    discovered: list[dict[str, str]],
    requested_cases: list[str],
    *,
    include_all: bool,
) -> tuple[list[dict[str, str]], list[str]]:
    by_key = {f"{case['technology']}/{case['design']}": case for case in discovered}
    requested = sorted(by_key) if include_all else (requested_cases or list(DEFAULT_CASES))
    selected: list[dict[str, str]] = []
    errors: list[str] = []
    seen: set[str] = set()
    for key in requested:
        case = by_key.get(key)
        if case is None:
            errors.append(f"missing TILOS case {key}")
            continue
        if key in seen:
            continue
        seen.add(key)
        selected.append(case)
    return selected, errors


def write_json(out_dir: Path, name: str, record: dict[str, Any]) -> Path:
    path = out_dir / name
    path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def convert_case(
    payload: Path,
    case: dict[str, str],
    out_dir: Path,
    report_path: Path,
) -> tuple[list[dict[str, Any]], list[str], dict[str, Any]]:
    errors: list[str] = []
    technology = case["technology"]
    design = case["design"]
    case_slug = f"{slug(technology)}-{slug(design)}"
    source_def = ROOT / case["def"]
    placed_def = ROOT / case["placed_def"]
    macros, lef_paths = parse_technology_lefs(payload, technology)
    for path in (source_def, placed_def):
        if not path.exists():
            errors.append(f"{technology}/{design}: missing required source {path}")
    if not lef_paths:
        errors.append(f"{technology}/{design}: no LEF files found for technology {technology}")
    if errors:
        return [], errors, {"case": case, "status": "failed", "errors": errors}

    source_text = source_def.read_text(encoding="utf-8", errors="replace")
    placed_text = placed_def.read_text(encoding="utf-8", errors="replace")
    units = def_units(source_text)
    source_die = diearea(source_text, units)
    source_core = core_area(source_text, source_die)
    unplaced_components = parse_components(source_text, units, macros)
    placed_components = parse_components(placed_text, units, macros)
    component_source = "source_def"
    if not unplaced_components:
        unplaced_components = placed_components
        component_source = "placed_def_fallback_no_source_components"
    if not unplaced_components:
        errors.append(f"{technology}/{design}: no components parsed from source or placed DEF")
        return [], errors, {"case": case, "status": "failed", "errors": errors}

    movable_objects: list[dict[str, Any]] = []
    missing_size_count = 0
    for name, item in sorted(unplaced_components.items()):
        width = item.get("width_um")
        height = item.get("height_um")
        if width is None or height is None:
            missing_size_count += 1
        converted = {
            "id": name,
            "type": item.get("type", "hard_macro"),
            "macro_name": item.get("macro_name"),
            "width_um": width,
            "height_um": height,
        }
        target = placed_components.get(name)
        if target and "x_um" in target and "y_um" in target:
            converted["target_placement"] = {
                "x_um": target["x_um"],
                "y_um": target["y_um"],
                "orientation": target.get("orientation", "N"),
                "source": rel(placed_def),
            }
        movable_objects.append(converted)

    design_id = f"tilos-macroplacement-{case_slug}-design-bundle"
    placement_id = f"tilos-macroplacement-{case_slug}-placement-case"
    flow_id = f"tilos-macroplacement-{case_slug}-flow-run-blocked"
    design_bundle = {
        "schema": "eda.design_bundle.v1",
        "id": design_id,
        "design": {
            "name": design,
            "revision": git_revision(payload),
            "top_module": design,
        },
        "sources": {
            "rtl": [],
            "manifests": [
                source_record(source_def),
                source_record(placed_def),
                *[source_record(path) for path in lef_paths],
            ],
        },
        "constraints": {
            "clocks": [],
            "resets": [],
            "macro_placement_target": rel(placed_def),
        },
        "technology": {
            "node": technology,
            "pdk": f"MacroPlacement/{technology} enablement",
            "flow": "TILOS MacroPlacement OpenROAD-style flow",
        },
        "claim_boundary": CLAIM_BOUNDARY,
    }
    placement_case = {
        "schema": "eda.placement_case.v1",
        "id": placement_id,
        "design_bundle_id": design_id,
        "floorplan": {
            "die_area_um": source_die,
            "core_area_um": source_core,
            "rows": "rows_from_source_def",
            "dbu_per_micron": units,
        },
        "movable_objects": movable_objects,
        "fixed_objects": [],
        "objective": {
            "primary": "match_or_improve_macro_placement_after_deterministic_openroad_replay",
            "secondary": [
                "hpwl_proxy",
                "routing_congestion",
                "timing_wns",
                "drc_clean",
                "power",
            ],
        },
        "replay": {
            "deterministic_command": "replay through MacroPlacement/OpenROAD flow after local tool review",
            "expected_report": rel(report_path),
        },
        "claim_boundary": CLAIM_BOUNDARY,
    }
    target_count = sum(1 for obj in movable_objects if "target_placement" in obj)
    flow_run = {
        "schema": "eda.flow_run.v1",
        "id": flow_id,
        "design_bundle_id": design_id,
        "toolchain": {
            "tools": ["openroad", "macroplacement", "tilos-benchmark-scripts"],
            "version_capture": "external/repos/tilos-macroplacement/manifest.yaml",
        },
        "command": "BLOCKED_REPLAY_NOT_RUN",
        "inputs": {
            "design_bundle": design_id,
            "placement_case": placement_id,
        },
        "outputs": {
            "reports": [],
            "artifacts": [],
        },
        "metrics": {
            "label_status": "converted_target_placement_only_no_local_replay",
            "macro_count": len(movable_objects),
            "target_placement_count": target_count,
            "missing_macro_size_count": missing_size_count,
            "component_source": component_source,
        },
        "status": {
            "result": "BLOCKED_REPLAY_NOT_RUN",
            "blockers": [
                "deterministic OpenROAD/MacroPlacement replay not run locally",
                "train/test split and non-overlap review needed before training use",
            ],
        },
        "claim_boundary": CLAIM_BOUNDARY,
    }
    records = []
    for filename, record in (
        (f"{design_id}.json", design_bundle),
        (f"{placement_id}.json", placement_case),
        (f"{flow_id}.json", flow_run),
    ):
        path = write_json(out_dir, filename, record)
        records.append({"schema": record["schema"], "path": rel(path), "id": record["id"]})
    summary = {
        "case": case,
        "status": "converted",
        "record_count": len(records),
        "macro_count": len(movable_objects),
        "target_placement_count": target_count,
        "missing_macro_size_count": missing_size_count,
        "component_source": component_source,
        "lef_file_count": len(lef_paths),
    }
    return records, [], summary


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--payload", type=Path, default=PAYLOAD)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument(
        "--case",
        action="append",
        default=[],
        help="TILOS case key like NanGate45/ariane133. Defaults to reviewed public cases.",
    )
    parser.add_argument(
        "--all", action="store_true", help="Convert every discovered direct DEF case."
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    errors: list[str] = []
    blockers: list[str] = []
    payload = args.payload

    out_dir = args.out_root / args.run_id / "records"
    out_dir.mkdir(parents=True, exist_ok=True)
    report_path = args.out_root / args.run_id / "conversion_report.json"
    for stale_record in out_dir.glob("*.json"):
        stale_record.unlink(missing_ok=True)

    records: list[dict[str, Any]] = []
    case_summaries: list[dict[str, Any]] = []
    discovered = discover_cases(payload) if payload.exists() else []
    if not discovered:
        errors.append(f"no TILOS cases discovered under {payload}")
    selected_cases, selection_errors = select_cases(discovered, args.case, include_all=args.all)
    errors.extend(selection_errors)
    for case in selected_cases:
        case_records, case_errors, summary = convert_case(payload, case, out_dir, report_path)
        records.extend(case_records)
        blockers.extend(case_errors)
        case_summaries.append(summary)
    if selected_cases and not records:
        errors.append("no selected TILOS cases converted into records")

    report = {
        "schema": "eliza.ai_eda.tilos_macroplacement_conversion_report.v1",
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "asset_id": "tilos-macroplacement",
        "source_revision": git_revision(payload) if payload.exists() else None,
        "claim_boundary": CLAIM_BOUNDARY,
        "discovered_case_count": len(discovered),
        "selected_case_count": len(selected_cases),
        "converted_case_count": sum(
            1 for summary in case_summaries if summary.get("status") == "converted"
        ),
        "blocked_case_count": sum(
            1 for summary in case_summaries if summary.get("status") != "converted"
        ),
        "cases": case_summaries,
        "records": records,
        "blockers": blockers,
        "errors": errors,
        "release_use_allowed": False,
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.tilos_macroplacement {error}")
        return 1
    status = "PASS_WITH_BLOCKED_CASES" if blockers else "PASS"
    print(
        f"STATUS: {status} ai_eda.tilos_macroplacement "
        f"cases={len(selected_cases)} converted={report['converted_case_count']} "
        f"blocked={report['blocked_case_count']} records={len(records)} {rel(report_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
