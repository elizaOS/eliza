"""Generated parametric STEP proof for ASIMOV fembot links."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.cad import sha256_file
from eliza_robot.asimov_1.constants import ASIMOV1_GENERATED_MJCF, ASIMOV1_SOURCE_MESH_DIR
from eliza_robot.asimov_1.fembot_cad_toolchain import FEMBOT_CAD_ENV_VENV
from eliza_robot.asimov_1.fembot_clearance_projection import build_fembot_clearance_projection_proof
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_FEMININE_CAD_ROOT, ASIMOV_PARAM_PROOFS

GENERATED_CAD_SCHEMA = "asimov-fembot-generated-cad-parametric-v1"
DEFAULT_STEP_OUTPUT_ROOT = ASIMOV_FEMININE_CAD_ROOT / "output" / "generated-cad" / "adjusted-envelope-step"
DEFAULT_POCKET_OUTPUT_ROOT = ASIMOV_FEMININE_CAD_ROOT / "output" / "generated-cad" / "remediation-pocket-step"
DEFAULT_LINK_POCKET_SET_OUTPUT_ROOT = (
    ASIMOV_FEMININE_CAD_ROOT / "output" / "generated-cad" / "remediation-link-pocket-set-step"
)
DEFAULT_POCKETED_PREVIEW_OUTPUT_ROOT = (
    ASIMOV_FEMININE_CAD_ROOT / "output" / "generated-cad" / "pocketed-preview-step"
)
DEFAULT_BULGED_PREVIEW_OUTPUT_ROOT = (
    ASIMOV_FEMININE_CAD_ROOT / "output" / "generated-cad" / "bulged-pocket-preview-step"
)
DEFAULT_RIBBED_BULGED_PREVIEW_OUTPUT_ROOT = (
    ASIMOV_FEMININE_CAD_ROOT
    / "output"
    / "generated-cad"
    / "ribbed-bulged-pocket-preview-step"
)
DEFAULT_SUPPLIER_VENDOR_ADJUSTED_OUTPUT_ROOT = (
    ASIMOV_FEMININE_CAD_ROOT
    / "output"
    / "generated-cad"
    / "supplier-vendor-adjusted-step"
)
DEFAULT_MANUFACTURING_ADJUSTED_PLATE_OUTPUT_ROOT = (
    ASIMOV_FEMININE_CAD_ROOT
    / "output"
    / "generated-cad"
    / "manufacturing-adjusted-plate-step"
)
DEFAULT_EXTENT_TOLERANCE_M = 1e-6
DEFAULT_SMOOTH_SHELL_WALL_THICKNESS_M = 0.0012
DEFAULT_FLAT_PLATE_MIN_THICKNESS_M = 0.0008
DEFAULT_ALU_PLATE_PROCESS_MIN_THICKNESS_M = 0.0015
DEFAULT_INTERNAL_KEEPOUT_MARGIN_M = 0.002
DEFAULT_SUPPLIER_VENDOR_FIT_MARGIN_M = 0.002
DEFAULT_BULGE_EXTRA_WALL_M = 0.003
DEFAULT_RIB_THICKNESS_M = 0.003


def _cad_python(venv: Path = FEMBOT_CAD_ENV_VENV) -> Path:
    return venv / "bin" / "python"


def _bbox_center(minimum: list[float], maximum: list[float]) -> list[float]:
    return [(float(a) + float(b)) * 0.5 for a, b in zip(minimum, maximum, strict=True)]


def _shape_spec(group: str, link: str) -> dict[str, Any]:
    if group == "foot":
        return {
            "shape_family": "flat_plate_envelope",
            "surface_intent": "flat",
            "wall_thickness_m": None,
            "minimum_plate_thickness_m": DEFAULT_FLAT_PLATE_MIN_THICKNESS_M,
            "manufacturing_intent": "structural plate envelope; sole/contact and ankle keepouts preserved",
        }
    if group in {"torso", "head"}:
        return {
            "shape_family": "hollow_lofted_elliptic_shell_reference",
            "surface_intent": "smooth",
            "wall_thickness_m": DEFAULT_SMOOTH_SHELL_WALL_THICKNESS_M,
            "minimum_plate_thickness_m": None,
            "manufacturing_intent": "moldable smooth loft reference for future injection/vacuform shell work",
        }
    if group in {"arm", "leg"}:
        return {
            "shape_family": "hollow_lofted_elliptic_limb_reference",
            "surface_intent": "smooth",
            "wall_thickness_m": DEFAULT_SMOOTH_SHELL_WALL_THICKNESS_M,
            "minimum_plate_thickness_m": None,
            "manufacturing_intent": (
                "slender limb loft reference; replace with split structural plates, "
                "bearing seats, and actuator keepouts before production"
            ),
        }
    return {
        "shape_family": "hollow_lofted_elliptic_reference",
        "surface_intent": "smooth",
        "wall_thickness_m": DEFAULT_SMOOTH_SHELL_WALL_THICKNESS_M,
        "minimum_plate_thickness_m": None,
        "manufacturing_intent": f"unclassified smooth loft reference for {link}",
    }


def _bbox_from_center_extents(center: list[float], extents: list[float]) -> tuple[list[float], list[float]]:
    half = [extent * 0.5 for extent in extents]
    return (
        [center[index] - half[index] for index in range(3)],
        [center[index] + half[index] for index in range(3)],
    )


def _outside_distance(point: list[float], minimum: list[float], maximum: list[float]) -> float:
    outside = [
        max(minimum[index] - point[index], 0.0, point[index] - maximum[index])
        for index in range(3)
    ]
    return sum(value * value for value in outside) ** 0.5


def _sphere_bbox_clearance(
    point: list[float],
    minimum: list[float],
    maximum: list[float],
    *,
    radius_m: float,
    margin_m: float,
) -> float:
    if any(point[index] < minimum[index] or point[index] > maximum[index] for index in range(3)):
        return -(_outside_distance(point, minimum, maximum) + radius_m + margin_m)
    boundary_clearance = min(
        min(point[index] - minimum[index], maximum[index] - point[index])
        for index in range(3)
    )
    return boundary_clearance - radius_m - margin_m


def _axis_face_clearances(
    point: list[float],
    minimum: list[float],
    maximum: list[float],
) -> list[float]:
    return [
        min(point[index] - minimum[index], maximum[index] - point[index])
        for index in range(3)
    ]


def _internal_cavity_report(
    *,
    center: list[float],
    extents: list[float],
    wall_thickness_m: float | None,
    keepout_points: list[dict[str, Any]],
    margin_m: float,
) -> dict[str, Any]:
    if wall_thickness_m is None:
        return {
            "required": False,
            "wall_thickness_m": None,
            "bbox_min_m": None,
            "bbox_max_m": None,
            "bbox_extent_m": None,
            "keepout_point_count": len(keepout_points),
            "violation_count": 0,
            "minimum_projected_clearance_m": None,
            "points": [],
        }
    cavity_extents = [max(extent - 2.0 * wall_thickness_m, 0.0) for extent in extents]
    cavity_min, cavity_max = _bbox_from_center_extents(center, cavity_extents)
    point_reports = []
    for point in keepout_points:
        point_m = [float(value) for value in point["point_m"]]
        radius_m = float(point.get("component_radius_m") or 0.0)
        outside = _outside_distance(point_m, cavity_min, cavity_max)
        volume_clearance = _sphere_bbox_clearance(
            point_m,
            cavity_min,
            cavity_max,
            radius_m=radius_m,
            margin_m=margin_m,
        )
        face_clearances = _axis_face_clearances(point_m, cavity_min, cavity_max)
        required_clearance = radius_m + margin_m
        axis_deficits = [required_clearance - clearance for clearance in face_clearances]
        limiting_axis_index = max(range(3), key=lambda index: axis_deficits[index])
        point_reports.append(
            {
                "component_type": point.get("component_type"),
                "name": point.get("name"),
                "point_m": point_m,
                "component_radius_m": radius_m,
                "required_clearance_m": required_clearance,
                "axis_face_clearance_m": face_clearances,
                "axis_deficit_m": axis_deficits,
                "limiting_axis": ("x", "y", "z")[limiting_axis_index],
                "limiting_axis_deficit_m": axis_deficits[limiting_axis_index],
                "outside_distance_m": outside,
                "minimum_margin_m": margin_m,
                "point_projected_clearance_m": margin_m - outside,
                "volume_projected_clearance_m": volume_clearance,
                "violates_internal_cavity": volume_clearance < 0.0,
            }
        )
    return {
        "required": True,
        "wall_thickness_m": wall_thickness_m,
        "bbox_min_m": cavity_min,
        "bbox_max_m": cavity_max,
        "bbox_extent_m": cavity_extents,
        "keepout_point_count": len(point_reports),
        "violation_count": sum(1 for point in point_reports if point["violates_internal_cavity"]),
        "minimum_projected_clearance_m": min(
            (float(point["volume_projected_clearance_m"]) for point in point_reports),
            default=None,
        ),
        "points": point_reports,
    }


def _count_by_key(records: list[dict[str, Any]], key: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for record in records:
        value = str(record.get(key))
        counts[value] = counts.get(value, 0) + 1
    return dict(sorted(counts.items()))


def _safe_filename(value: str) -> str:
    return "".join(char.lower() if char.isalnum() else "_" for char in value).strip("_")


def _load_component_constraints_report() -> dict[str, Any] | None:
    path = ASIMOV_PARAM_PROOFS / "fembot-component-constraints.json"
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _supplier_growth_by_link(report: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    if not report:
        return {}
    summary = report.get("vendor_envelope_summary", {})
    fit_reports_by_link: dict[str, list[dict[str, Any]]] = {}
    supplier_targets = (
        summary.get("supplier_code_targets")
        or summary.get("supplier_code_classification_targets")
        or []
    )
    for target in supplier_targets:
        supplier_code = target.get("supplier_code")
        for fit_report in target.get("generated_link_fit_reports", []):
            if not isinstance(fit_report, dict):
                continue
            if fit_report.get("orientation_agnostic_bbox_fit"):
                continue
            link = str(fit_report.get("link") or "").upper()
            if not link:
                continue
            fit_reports_by_link.setdefault(link, []).append(
                {
                    **fit_report,
                    "supplier_code": supplier_code,
                }
            )
    records = {}
    for record in summary.get("supplier_code_link_growth_summary", []):
        if not record.get("requires_growth"):
            continue
        link = str(record.get("link")).upper()
        records[link] = {
            **record,
            "fit_reports": fit_reports_by_link.get(link, []),
        }
    return records


def _apply_sorted_extent_growth(
    extents: list[float],
    sorted_growth: list[float],
) -> tuple[list[float], list[int]]:
    if len(sorted_growth) != 3:
        return list(extents), []
    sorted_axis_indices = sorted(range(3), key=lambda index: (extents[index], index))
    adjusted = list(extents)
    for sorted_index, axis_index in enumerate(sorted_axis_indices):
        adjusted[axis_index] += float(sorted_growth[sorted_index])
    return adjusted, sorted_axis_indices


def _supplier_vendor_fit_after_adjustment(
    *,
    supplier_growth: dict[str, Any],
    adjusted_extent_m: list[float] | None,
    margin_m: float,
) -> dict[str, Any]:
    fit_reports = [
        report
        for report in supplier_growth.get("fit_reports", [])
        if isinstance(report, dict)
    ]
    if adjusted_extent_m is None:
        return {
            "checked_supplier_codes": supplier_growth.get("checked_supplier_codes", []),
            "fit_margin_m": margin_m,
            "fit_check_count": len(fit_reports),
            "fit_pass_count": 0,
            "fit_fail_count": len(fit_reports),
            "all_fit": False,
            "blocking_reason": "supplier-adjusted generated CAD preview did not reload",
            "reports": [],
        }
    sorted_container = sorted(float(value) for value in adjusted_extent_m)
    reports = []
    for report in fit_reports:
        required = [
            float(value)
            for value in report.get("required_sorted_extent_m", [])
            if value is not None
        ]
        supplier_code = report.get("supplier_code")
        if len(required) != 3:
            reports.append(
                {
                    "supplier_code": supplier_code,
                    "passes_after_adjustment": False,
                    "blocking_reason": "missing required sorted supplier extent",
                }
            )
            continue
        residual = [
            max(required[index] - sorted_container[index], 0.0)
            for index in range(3)
        ]
        passes = max(residual, default=0.0) <= 1e-9
        reports.append(
            {
                "supplier_code": supplier_code,
                "required_sorted_extent_m": required,
                "available_sorted_extent_after_margin_m": sorted_container,
                "residual_sorted_extent_growth_m": residual,
                "max_residual_extent_growth_m": max(residual, default=0.0),
                "passes_after_adjustment": passes,
                "blocking_reason": None
                if passes
                else "supplier-adjusted preview still does not fit this supplier-code bbox with margin",
            }
        )
    fit_pass_count = sum(1 for report in reports if report["passes_after_adjustment"])
    fit_fail_count = len(reports) - fit_pass_count
    return {
        "checked_supplier_codes": supplier_growth.get("checked_supplier_codes", []),
        "failed_supplier_codes_before_adjustment": supplier_growth.get(
            "failed_supplier_codes",
            [],
        ),
        "fit_margin_m": margin_m,
        "fit_check_count": len(reports),
        "fit_pass_count": fit_pass_count,
        "fit_fail_count": fit_fail_count,
        "all_fit": bool(reports) and fit_fail_count == 0,
        "max_residual_extent_growth_m": max(
            (float(report.get("max_residual_extent_growth_m") or 0.0) for report in reports),
            default=0.0,
        ),
        "blocking_reason": None
        if reports and fit_fail_count == 0
        else "one or more supplier-code bboxes still fail after supplier-adjusted preview",
        "reports": reports,
    }


def _link_specs_from_clearance(clearance: dict[str, Any], step_root: Path) -> list[dict[str, Any]]:
    specs: list[dict[str, Any]] = []
    for record in clearance.get("link_clearance", []):
        link = str(record["link"]).upper()
        group = str(record["group"])
        minimum = [float(value) for value in record["adjusted_bbox_min_m"]]
        maximum = [float(value) for value in record["adjusted_bbox_max_m"]]
        extents = [float(value) for value in record["adjusted_bbox_extent_m"]]
        center = _bbox_center(minimum, maximum)
        shape = _shape_spec(group, link)
        keepout_points = [
            {
                "component_type": point.get("component_type"),
                "name": point.get("name"),
                "point_m": [float(value) for value in point["point_m"]],
                "component_radius_m": float(point.get("component_radius_m") or 0.0),
            }
            for point in record.get("adjusted_projected_points", [])
        ]
        cavity = _internal_cavity_report(
            center=center,
            extents=extents,
            wall_thickness_m=shape["wall_thickness_m"],
            keepout_points=keepout_points,
            margin_m=DEFAULT_INTERNAL_KEEPOUT_MARGIN_M,
        )
        specs.append(
            {
                "group": group,
                "link": link,
                "bbox_min_m": minimum,
                "bbox_max_m": maximum,
                "center_m": center,
                "extent_m": extents,
                **shape,
                "internal_cavity": cavity,
                "step_path": str(step_root / f"{link.lower()}.step"),
                "keepout_point_count": int(record["keepout_point_count"]),
                "adjusted_minimum_projected_clearance_m": record[
                    "adjusted_minimum_projected_clearance_m"
                ],
            }
        )
    return specs


def _supplier_vendor_adjusted_specs(
    records: list[dict[str, Any]],
    *,
    supplier_growth_by_link: dict[str, dict[str, Any]],
    step_root: Path,
) -> list[dict[str, Any]]:
    specs = []
    for record in records:
        link = str(record["link"]).upper()
        supplier_growth = supplier_growth_by_link.get(link)
        if not supplier_growth:
            continue
        baseline_extents = [
            float(value)
            for value in record.get("reloaded_bbox_extent_m", record["requested_extent_m"])
        ]
        adjusted_extents, sorted_axis_indices = _apply_sorted_extent_growth(
            baseline_extents,
            [
                float(value)
                for value in supplier_growth.get("max_required_sorted_extent_growth_m", [])
            ],
        )
        specs.append(
            {
                "group": record["group"],
                "link": link,
                "bbox_min_m": None,
                "bbox_max_m": None,
                "center_m": [float(value) for value in record["requested_center_m"]],
                "extent_m": adjusted_extents,
                "shape_family": record["shape_family"],
                "surface_intent": record["surface_intent"],
                "wall_thickness_m": record["wall_thickness_m"],
                "minimum_plate_thickness_m": record["minimum_plate_thickness_m"],
                "manufacturing_intent": (
                    "supplier-code keepout adjusted preview; converts measured "
                    "orientation-agnostic vendor component growth into a generated "
                    "parametric envelope candidate"
                ),
                "internal_cavity": _internal_cavity_report(
                    center=[float(value) for value in record["requested_center_m"]],
                    extents=adjusted_extents,
                    wall_thickness_m=record["wall_thickness_m"],
                    keepout_points=record.get("internal_cavity", {}).get("points", []),
                    margin_m=DEFAULT_INTERNAL_KEEPOUT_MARGIN_M,
                )
                if record.get("internal_cavity", {}).get("required")
                else record.get("internal_cavity"),
                "step_path": str(step_root / f"{link.lower()}.step"),
                "keepout_point_count": record.get("keepout_point_count"),
                "adjusted_minimum_projected_clearance_m": record.get(
                    "adjusted_minimum_projected_clearance_m"
                ),
                "supplier_vendor_growth": supplier_growth,
                "supplier_vendor_sorted_axis_indices": sorted_axis_indices,
                "supplier_vendor_axis_growth_m": [
                    adjusted_extents[index] - baseline_extents[index]
                    for index in range(3)
                ],
            }
        )
    return specs


def _cadquery_generate_and_reload(
    *,
    specs: list[dict[str, Any]],
    cad_python: Path,
    timeout_s: int = 120,
) -> dict[str, Any]:
    if not cad_python.is_file():
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "records": [],
            "failures": [{"error": "isolated CAD python executable not found"}],
        }
    code = r'''
from __future__ import annotations

import json
from pathlib import Path
import sys

import cadquery as cq


def make_parametric_solid(spec):
    extents = [float(value) for value in spec["extent_m"]]
    shape_family = spec["shape_family"]
    if shape_family == "flat_plate_envelope":
        return cq.Workplane("XY").box(extents[0], extents[1], extents[2], centered=True)
    outer = (
        cq.Workplane("XY")
        .workplane(offset=-extents[2] * 0.5)
        .ellipse(extents[0] * 0.5, extents[1] * 0.5)
        .workplane(offset=extents[2] * 0.5)
        .ellipse(extents[0] * 0.44, extents[1] * 0.44)
        .workplane(offset=extents[2] * 0.5)
        .ellipse(extents[0] * 0.5, extents[1] * 0.5)
        .loft(combine=True)
    )
    wall = float(spec["wall_thickness_m"])
    inner_extents = [max(value - 2.0 * wall, 0.0005) for value in extents]
    inner = (
        cq.Workplane("XY")
        .workplane(offset=-inner_extents[2] * 0.5)
        .ellipse(inner_extents[0] * 0.5, inner_extents[1] * 0.5)
        .workplane(offset=inner_extents[2] * 0.5)
        .ellipse(inner_extents[0] * 0.44, inner_extents[1] * 0.44)
        .workplane(offset=inner_extents[2] * 0.5)
        .ellipse(inner_extents[0] * 0.5, inner_extents[1] * 0.5)
        .loft(combine=True)
    )
    return outer.cut(inner)


payload = json.loads(sys.stdin.read())
records = []
failures = []
for spec in payload["specs"]:
    step_path = Path(spec["step_path"])
    try:
        step_path.parent.mkdir(parents=True, exist_ok=True)
        extents = [float(value) for value in spec["extent_m"]]
        center = [float(value) for value in spec["center_m"]]
        solid = make_parametric_solid(spec)
        solid = solid.translate(tuple(center))
        cq.exporters.export(solid, str(step_path))
        imported = cq.importers.importStep(str(step_path))
        bbox = imported.val().BoundingBox()
        records.append(
            {
                "group": spec["group"],
                "link": spec["link"],
                "step_path": str(step_path),
                "shape_family": spec["shape_family"],
                "surface_intent": spec["surface_intent"],
                "manufacturing_intent": spec["manufacturing_intent"],
                "wall_thickness_m": spec["wall_thickness_m"],
                "minimum_plate_thickness_m": spec["minimum_plate_thickness_m"],
                "internal_cavity": spec["internal_cavity"],
                "requested_extent_m": extents,
                "requested_center_m": center,
                "reloaded_bbox_min_m": [bbox.xmin, bbox.ymin, bbox.zmin],
                "reloaded_bbox_max_m": [bbox.xmax, bbox.ymax, bbox.zmax],
                "reloaded_bbox_extent_m": [bbox.xlen, bbox.ylen, bbox.zlen],
                "reloaded_volume_m3": imported.val().Volume(),
                "solid_count": len(imported.solids().vals()),
                "export_ok": step_path.is_file() and step_path.stat().st_size > 0,
                "reload_ok": True,
            }
        )
    except Exception as exc:
        failures.append(
            {
                "group": spec.get("group"),
                "link": spec.get("link"),
                "step_path": str(step_path),
                "error": f"{type(exc).__name__}: {exc}",
            }
        )
print(json.dumps({"records": records, "failures": failures}, sort_keys=True))
'''
    try:
        proc = subprocess.run(
            [str(cad_python), "-c", code],
            input=json.dumps({"specs": specs}),
            text=True,
            capture_output=True,
            check=False,
            timeout=timeout_s,
        )
    except Exception as exc:
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "records": [],
            "failures": [{"error": f"{type(exc).__name__}: {exc}"}],
        }
    if proc.returncode != 0:
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "records": [],
            "failures": [{"error": proc.stderr.strip() or proc.stdout.strip()}],
        }
    try:
        parsed = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "records": [],
            "failures": [{"error": f"JSONDecodeError: {exc}", "stdout": proc.stdout}],
        }
    return {
        "ok": not parsed.get("failures"),
        "backend": "cadquery",
        "python": str(cad_python),
        "records": parsed.get("records", []),
        "failures": parsed.get("failures", []),
    }


def _cadquery_export_pocket_markers(
    *,
    targets: list[dict[str, Any]],
    pocket_root: Path,
    cad_python: Path,
    timeout_s: int = 120,
) -> dict[str, Any]:
    if not cad_python.is_file():
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "records": [],
            "failures": [{"error": "isolated CAD python executable not found"}],
        }
    target_specs = [
        {
            **target,
            "step_path": str(
                pocket_root
                / _safe_filename(str(target["link"]))
                / f"{target['priority_rank']:03d}_{_safe_filename(str(target['target_id']))}.step"
            ),
        }
        for target in targets
    ]
    code = r'''
from __future__ import annotations

import json
from pathlib import Path
import sys

import cadquery as cq

payload = json.loads(sys.stdin.read())
records = []
failures = []
for target in payload["targets"]:
    step_path = Path(target["step_path"])
    try:
        step_path.parent.mkdir(parents=True, exist_ok=True)
        radius = float(target["required_local_pocket_radius_m"])
        center = [float(value) for value in target["point_m"]]
        solid = cq.Workplane("XY").sphere(radius).translate(tuple(center))
        cq.exporters.export(solid, str(step_path))
        imported = cq.importers.importStep(str(step_path))
        bbox = imported.val().BoundingBox()
        records.append(
            {
                "target_id": target["target_id"],
                "link": target["link"],
                "group": target["group"],
                "component_type": target["component_type"],
                "name": target["name"],
                "step_path": str(step_path),
                "requested_center_m": center,
                "requested_radius_m": radius,
                "reloaded_bbox_extent_m": [bbox.xlen, bbox.ylen, bbox.zlen],
                "reloaded_volume_m3": imported.val().Volume(),
                "solid_count": len(imported.solids().vals()),
                "export_ok": step_path.is_file() and step_path.stat().st_size > 0,
                "reload_ok": True,
            }
        )
    except Exception as exc:
        failures.append(
            {
                "target_id": target.get("target_id"),
                "step_path": str(step_path),
                "error": f"{type(exc).__name__}: {exc}",
            }
        )
print(json.dumps({"records": records, "failures": failures}, sort_keys=True))
'''
    try:
        proc = subprocess.run(
            [str(cad_python), "-c", code],
            input=json.dumps({"targets": target_specs}),
            text=True,
            capture_output=True,
            check=False,
            timeout=timeout_s,
        )
    except Exception as exc:
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "records": [],
            "failures": [{"error": f"{type(exc).__name__}: {exc}"}],
        }
    if proc.returncode != 0:
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "records": [],
            "failures": [{"error": proc.stderr.strip() or proc.stdout.strip()}],
        }
    try:
        parsed = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "records": [],
            "failures": [{"error": f"JSONDecodeError: {exc}", "stdout": proc.stdout}],
        }
    records = []
    for record in parsed.get("records", []):
        step_path = Path(record["step_path"])
        records.append(
            {
                **record,
                "step_sha256": sha256_file(step_path) if step_path.is_file() else None,
                "step_size_bytes": step_path.stat().st_size if step_path.is_file() else 0,
            }
        )
    return {
        "ok": not parsed.get("failures"),
        "backend": "cadquery",
        "python": str(cad_python),
        "pocket_root": str(pocket_root),
        "records": records,
        "failures": parsed.get("failures", []),
    }


def _targets_by_link(targets: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for target in targets:
        grouped.setdefault(str(target["link"]), []).append(target)
    return dict(sorted(grouped.items()))


def _cadquery_export_link_pocket_sets(
    *,
    targets: list[dict[str, Any]],
    link_pocket_root: Path,
    cad_python: Path,
    timeout_s: int = 120,
) -> dict[str, Any]:
    if not cad_python.is_file():
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "records": [],
            "failures": [{"error": "isolated CAD python executable not found"}],
        }
    link_specs = []
    for link, link_targets in _targets_by_link(targets).items():
        link_specs.append(
            {
                "link": link,
                "group": link_targets[0]["group"],
                "target_count": len(link_targets),
                "targets": link_targets,
                "step_path": str(link_pocket_root / f"{_safe_filename(link)}.step"),
            }
        )
    code = r'''
from __future__ import annotations

import json
from pathlib import Path
import sys

import cadquery as cq

payload = json.loads(sys.stdin.read())
records = []
failures = []
for spec in payload["links"]:
    step_path = Path(spec["step_path"])
    try:
        step_path.parent.mkdir(parents=True, exist_ok=True)
        combined = None
        for target in spec["targets"]:
            radius = float(target["required_local_pocket_radius_m"])
            center = [float(value) for value in target["point_m"]]
            sphere = cq.Workplane("XY").sphere(radius).translate(tuple(center))
            combined = sphere if combined is None else combined.union(sphere)
        if combined is None:
            raise ValueError("link pocket set has no targets")
        cq.exporters.export(combined, str(step_path))
        imported = cq.importers.importStep(str(step_path))
        bbox = imported.val().BoundingBox()
        records.append(
            {
                "link": spec["link"],
                "group": spec["group"],
                "target_count": spec["target_count"],
                "step_path": str(step_path),
                "reloaded_bbox_extent_m": [bbox.xlen, bbox.ylen, bbox.zlen],
                "reloaded_volume_m3": imported.val().Volume(),
                "solid_count": len(imported.solids().vals()),
                "export_ok": step_path.is_file() and step_path.stat().st_size > 0,
                "reload_ok": True,
            }
        )
    except Exception as exc:
        failures.append(
            {
                "link": spec.get("link"),
                "step_path": str(step_path),
                "error": f"{type(exc).__name__}: {exc}",
            }
        )
print(json.dumps({"records": records, "failures": failures}, sort_keys=True))
'''
    try:
        proc = subprocess.run(
            [str(cad_python), "-c", code],
            input=json.dumps({"links": link_specs}),
            text=True,
            capture_output=True,
            check=False,
            timeout=timeout_s,
        )
    except Exception as exc:
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "records": [],
            "failures": [{"error": f"{type(exc).__name__}: {exc}"}],
        }
    if proc.returncode != 0:
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "records": [],
            "failures": [{"error": proc.stderr.strip() or proc.stdout.strip()}],
        }
    try:
        parsed = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "records": [],
            "failures": [{"error": f"JSONDecodeError: {exc}", "stdout": proc.stdout}],
        }
    records = []
    for record in parsed.get("records", []):
        step_path = Path(record["step_path"])
        records.append(
            {
                **record,
                "step_sha256": sha256_file(step_path) if step_path.is_file() else None,
                "step_size_bytes": step_path.stat().st_size if step_path.is_file() else 0,
            }
        )
    return {
        "ok": not parsed.get("failures"),
        "backend": "cadquery",
        "python": str(cad_python),
        "link_pocket_root": str(link_pocket_root),
        "records": records,
        "failures": parsed.get("failures", []),
    }


def _cadquery_export_pocketed_previews(
    *,
    records: list[dict[str, Any]],
    preview_root: Path,
    cad_python: Path,
    bulge_extra_wall_m: float = 0.0,
    timeout_s: int = 180,
) -> dict[str, Any]:
    if not cad_python.is_file():
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "records": [],
            "failures": [{"error": "isolated CAD python executable not found"}],
        }
    preview_specs = [
        {
            "group": record["group"],
            "link": record["link"],
            "shape_family": record["shape_family"],
            "wall_thickness_m": record["wall_thickness_m"],
            "extent_m": record["requested_extent_m"],
            "center_m": record["requested_center_m"],
            "source_volume_m3": record["reloaded_volume_m3"],
            "targets": record.get("remediation_targets", []),
            "step_path": str(preview_root / f"{_safe_filename(str(record['link']))}.step"),
            "bulge_extra_wall_m": bulge_extra_wall_m,
        }
        for record in records
        if record.get("remediation_targets")
    ]
    code = r'''
from __future__ import annotations

import json
from pathlib import Path
import sys

import cadquery as cq


def make_parametric_solid(spec):
    extents = [float(value) for value in spec["extent_m"]]
    shape_family = spec["shape_family"]
    if shape_family == "flat_plate_envelope":
        return cq.Workplane("XY").box(extents[0], extents[1], extents[2], centered=True)
    outer = (
        cq.Workplane("XY")
        .workplane(offset=-extents[2] * 0.5)
        .ellipse(extents[0] * 0.5, extents[1] * 0.5)
        .workplane(offset=extents[2] * 0.5)
        .ellipse(extents[0] * 0.44, extents[1] * 0.44)
        .workplane(offset=extents[2] * 0.5)
        .ellipse(extents[0] * 0.5, extents[1] * 0.5)
        .loft(combine=True)
    )
    wall = float(spec["wall_thickness_m"])
    inner_extents = [max(value - 2.0 * wall, 0.0005) for value in extents]
    inner = (
        cq.Workplane("XY")
        .workplane(offset=-inner_extents[2] * 0.5)
        .ellipse(inner_extents[0] * 0.5, inner_extents[1] * 0.5)
        .workplane(offset=inner_extents[2] * 0.5)
        .ellipse(inner_extents[0] * 0.44, inner_extents[1] * 0.44)
        .workplane(offset=inner_extents[2] * 0.5)
        .ellipse(inner_extents[0] * 0.5, inner_extents[1] * 0.5)
        .loft(combine=True)
    )
    return outer.cut(inner)


payload = json.loads(sys.stdin.read())
records = []
failures = []
for spec in payload["previews"]:
    step_path = Path(spec["step_path"])
    try:
        step_path.parent.mkdir(parents=True, exist_ok=True)
        center = [float(value) for value in spec["center_m"]]
        solid = make_parametric_solid(spec).translate(tuple(center))
        pockets = None
        bulges = None
        bulge_extra_wall_m = float(spec.get("bulge_extra_wall_m") or 0.0)
        for target in spec["targets"]:
            radius = float(target["required_local_pocket_radius_m"])
            pocket_center = [float(value) for value in target["point_m"]]
            sphere = cq.Workplane("XY").sphere(radius).translate(tuple(pocket_center))
            pockets = sphere if pockets is None else pockets.union(sphere)
            if bulge_extra_wall_m > 0.0:
                bulge = cq.Workplane("XY").sphere(radius + bulge_extra_wall_m).translate(tuple(pocket_center))
                bulges = bulge if bulges is None else bulges.union(bulge)
        if pockets is None:
            raise ValueError("pocketed preview has no targets")
        if bulges is not None:
            solid = solid.union(bulges)
        pocketed = solid.cut(pockets)
        cq.exporters.export(pocketed, str(step_path))
        imported = cq.importers.importStep(str(step_path))
        bbox = imported.val().BoundingBox()
        volume = imported.val().Volume()
        source_volume = float(spec["source_volume_m3"])
        records.append(
            {
                "link": spec["link"],
                "group": spec["group"],
                "step_path": str(step_path),
                "target_count": len(spec["targets"]),
                "bulge_extra_wall_m": bulge_extra_wall_m,
                "source_volume_m3": source_volume,
                "reloaded_volume_m3": volume,
                "volume_removed_m3": source_volume - volume,
                "volume_removed_fraction": (source_volume - volume) / source_volume if source_volume > 0 else None,
                "reloaded_bbox_extent_m": [bbox.xlen, bbox.ylen, bbox.zlen],
                "solid_count": len(imported.solids().vals()),
                "export_ok": step_path.is_file() and step_path.stat().st_size > 0,
                "reload_ok": True,
            }
        )
    except Exception as exc:
        failures.append(
            {
                "link": spec.get("link"),
                "step_path": str(step_path),
                "error": f"{type(exc).__name__}: {exc}",
            }
        )
print(json.dumps({"records": records, "failures": failures}, sort_keys=True))
'''
    try:
        proc = subprocess.run(
            [str(cad_python), "-c", code],
            input=json.dumps({"previews": preview_specs}),
            text=True,
            capture_output=True,
            check=False,
            timeout=timeout_s,
        )
    except Exception as exc:
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "records": [],
            "failures": [{"error": f"{type(exc).__name__}: {exc}"}],
        }
    if proc.returncode != 0:
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "records": [],
            "failures": [{"error": proc.stderr.strip() or proc.stdout.strip()}],
        }
    try:
        parsed = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "records": [],
            "failures": [{"error": f"JSONDecodeError: {exc}", "stdout": proc.stdout}],
        }
    records_out = []
    for record in parsed.get("records", []):
        step_path = Path(record["step_path"])
        records_out.append(
            {
                **record,
                "step_sha256": sha256_file(step_path) if step_path.is_file() else None,
                "step_size_bytes": step_path.stat().st_size if step_path.is_file() else 0,
            }
        )
    return {
        "ok": not parsed.get("failures"),
        "backend": "cadquery",
        "python": str(cad_python),
        "preview_root": str(preview_root),
        "bulge_extra_wall_m": bulge_extra_wall_m,
        "records": records_out,
        "failures": parsed.get("failures", []),
    }


def _cadquery_export_ribbed_bulged_previews(
    *,
    records: list[dict[str, Any]],
    preview_root: Path,
    cad_python: Path,
    candidate_links: list[str],
    bulge_extra_wall_m: float = DEFAULT_BULGE_EXTRA_WALL_M,
    rib_thickness_m: float = DEFAULT_RIB_THICKNESS_M,
    timeout_s: int = 180,
) -> dict[str, Any]:
    if not cad_python.is_file():
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "records": [],
            "failures": [{"error": "isolated CAD python executable not found"}],
        }
    candidate_link_set = {link.upper() for link in candidate_links}
    preview_specs = [
        {
            "group": record["group"],
            "link": record["link"],
            "shape_family": record["shape_family"],
            "wall_thickness_m": record["wall_thickness_m"],
            "extent_m": record["requested_extent_m"],
            "center_m": record["requested_center_m"],
            "source_volume_m3": record["reloaded_volume_m3"],
            "targets": record.get("remediation_targets", []),
            "step_path": str(preview_root / f"{_safe_filename(str(record['link']))}.step"),
            "bulge_extra_wall_m": bulge_extra_wall_m,
            "rib_thickness_m": rib_thickness_m,
        }
        for record in records
        if record.get("remediation_targets") and str(record["link"]).upper() in candidate_link_set
    ]
    code = r'''
from __future__ import annotations

import json
from pathlib import Path
import sys

import cadquery as cq


def make_parametric_solid(spec):
    extents = [float(value) for value in spec["extent_m"]]
    shape_family = spec["shape_family"]
    if shape_family == "flat_plate_envelope":
        return cq.Workplane("XY").box(extents[0], extents[1], extents[2], centered=True)
    outer = (
        cq.Workplane("XY")
        .workplane(offset=-extents[2] * 0.5)
        .ellipse(extents[0] * 0.5, extents[1] * 0.5)
        .workplane(offset=extents[2] * 0.5)
        .ellipse(extents[0] * 0.44, extents[1] * 0.44)
        .workplane(offset=extents[2] * 0.5)
        .ellipse(extents[0] * 0.5, extents[1] * 0.5)
        .loft(combine=True)
    )
    wall = float(spec["wall_thickness_m"])
    inner_extents = [max(value - 2.0 * wall, 0.0005) for value in extents]
    inner = (
        cq.Workplane("XY")
        .workplane(offset=-inner_extents[2] * 0.5)
        .ellipse(inner_extents[0] * 0.5, inner_extents[1] * 0.5)
        .workplane(offset=inner_extents[2] * 0.5)
        .ellipse(inner_extents[0] * 0.44, inner_extents[1] * 0.44)
        .workplane(offset=inner_extents[2] * 0.5)
        .ellipse(inner_extents[0] * 0.5, inner_extents[1] * 0.5)
        .loft(combine=True)
    )
    return outer.cut(inner)


def make_bridge_ribs(spec):
    extents = [float(value) for value in spec["extent_m"]]
    center = [float(value) for value in spec["center_m"]]
    rib = max(float(spec["rib_thickness_m"]), min(extents) * 0.12)
    rib = min(rib, 0.012)
    ribs = []
    spans = [
        (extents[0], rib, rib),
        (rib, extents[1], rib),
        (rib, rib, extents[2]),
    ]
    offsets = [
        (0.0, 0.0, 0.0),
        (extents[0] * 0.18, 0.0, 0.0),
        (-extents[0] * 0.18, 0.0, 0.0),
        (0.0, extents[1] * 0.18, 0.0),
        (0.0, -extents[1] * 0.18, 0.0),
    ]
    for span in spans:
        for offset in offsets:
            ribs.append(
                cq.Workplane("XY")
                .box(span[0], span[1], span[2], centered=True)
                .translate(
                    (
                        center[0] + offset[0],
                        center[1] + offset[1],
                        center[2] + offset[2],
                    )
                )
            )
    side_plates = [
        ((extents[0], rib, extents[2]), (0.0, extents[1] * 0.42, 0.0)),
        ((extents[0], rib, extents[2]), (0.0, -extents[1] * 0.42, 0.0)),
        ((rib, extents[1], extents[2]), (extents[0] * 0.42, 0.0, 0.0)),
        ((rib, extents[1], extents[2]), (-extents[0] * 0.42, 0.0, 0.0)),
        ((extents[0], extents[1], rib), (0.0, 0.0, extents[2] * 0.42)),
        ((extents[0], extents[1], rib), (0.0, 0.0, -extents[2] * 0.42)),
    ]
    for span, offset in side_plates:
        ribs.append(
            cq.Workplane("XY")
            .box(span[0], span[1], span[2], centered=True)
            .translate(
                (
                    center[0] + offset[0],
                    center[1] + offset[1],
                    center[2] + offset[2],
                )
            )
        )
    combined = ribs[0]
    for rib_solid in ribs[1:]:
        combined = combined.union(rib_solid)
    return combined, rib, len(ribs)


payload = json.loads(sys.stdin.read())
records = []
failures = []
for spec in payload["previews"]:
    step_path = Path(spec["step_path"])
    try:
        step_path.parent.mkdir(parents=True, exist_ok=True)
        center = [float(value) for value in spec["center_m"]]
        solid = make_parametric_solid(spec).translate(tuple(center))
        ribs, rib_thickness, rib_count = make_bridge_ribs(spec)
        solid = solid.union(ribs)
        pockets = None
        bulges = None
        bulge_extra_wall_m = float(spec.get("bulge_extra_wall_m") or 0.0)
        for target in spec["targets"]:
            radius = float(target["required_local_pocket_radius_m"])
            pocket_center = [float(value) for value in target["point_m"]]
            sphere = cq.Workplane("XY").sphere(radius).translate(tuple(pocket_center))
            pockets = sphere if pockets is None else pockets.union(sphere)
            if bulge_extra_wall_m > 0.0:
                bulge = cq.Workplane("XY").sphere(radius + bulge_extra_wall_m).translate(tuple(pocket_center))
                bulges = bulge if bulges is None else bulges.union(bulge)
        if pockets is None:
            raise ValueError("ribbed preview has no targets")
        if bulges is not None:
            solid = solid.union(bulges)
        pocketed = solid.cut(pockets)
        cq.exporters.export(pocketed, str(step_path))
        imported = cq.importers.importStep(str(step_path))
        bbox = imported.val().BoundingBox()
        volume = imported.val().Volume()
        source_volume = float(spec["source_volume_m3"])
        records.append(
            {
                "link": spec["link"],
                "group": spec["group"],
                "step_path": str(step_path),
                "target_count": len(spec["targets"]),
                "bulge_extra_wall_m": bulge_extra_wall_m,
                "rib_thickness_m": rib_thickness,
                "rib_count": rib_count,
                "source_volume_m3": source_volume,
                "reloaded_volume_m3": volume,
                "volume_removed_m3": source_volume - volume,
                "volume_removed_fraction": (source_volume - volume) / source_volume if source_volume > 0 else None,
                "reloaded_bbox_extent_m": [bbox.xlen, bbox.ylen, bbox.zlen],
                "solid_count": len(imported.solids().vals()),
                "export_ok": step_path.is_file() and step_path.stat().st_size > 0,
                "reload_ok": True,
            }
        )
    except Exception as exc:
        failures.append(
            {
                "link": spec.get("link"),
                "step_path": str(step_path),
                "error": f"{type(exc).__name__}: {exc}",
            }
        )
print(json.dumps({"records": records, "failures": failures}, sort_keys=True))
'''
    try:
        proc = subprocess.run(
            [str(cad_python), "-c", code],
            input=json.dumps({"previews": preview_specs}),
            text=True,
            capture_output=True,
            check=False,
            timeout=timeout_s,
        )
    except Exception as exc:
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "records": [],
            "failures": [{"error": f"{type(exc).__name__}: {exc}"}],
        }
    if proc.returncode != 0:
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "records": [],
            "failures": [{"error": proc.stderr.strip() or proc.stdout.strip()}],
        }
    try:
        parsed = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "records": [],
            "failures": [{"error": f"JSONDecodeError: {exc}", "stdout": proc.stdout}],
        }
    records_out = []
    for record in parsed.get("records", []):
        step_path = Path(record["step_path"])
        records_out.append(
            {
                **record,
                "step_sha256": sha256_file(step_path) if step_path.is_file() else None,
                "step_size_bytes": step_path.stat().st_size if step_path.is_file() else 0,
            }
        )
    return {
        "ok": not parsed.get("failures"),
        "backend": "cadquery",
        "python": str(cad_python),
        "preview_root": str(preview_root),
        "candidate_links": sorted(candidate_link_set),
        "bulge_extra_wall_m": bulge_extra_wall_m,
        "rib_thickness_m": rib_thickness_m,
        "records": records_out,
        "failures": parsed.get("failures", []),
    }


def _cadquery_export_manufacturing_adjusted_flat_plates(
    *,
    records: list[dict[str, Any]],
    output_root: Path,
    cad_python: Path,
    minimum_plate_thickness_m: float = DEFAULT_ALU_PLATE_PROCESS_MIN_THICKNESS_M,
    timeout_s: int = 120,
) -> dict[str, Any]:
    if not cad_python.is_file():
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "records": [],
            "failures": [{"error": "isolated CAD python executable not found"}],
        }
    plate_specs = []
    for record in records:
        if record.get("shape_family") != "flat_plate_envelope":
            continue
        requested_extent = [float(value) for value in record["requested_extent_m"]]
        requested_design_thickness = float(
            record.get("minimum_plate_thickness_m") or requested_extent[2]
        )
        adjusted_extent = list(requested_extent)
        adjusted_extent[2] = max(adjusted_extent[2], minimum_plate_thickness_m)
        adjusted_design_thickness = max(requested_design_thickness, minimum_plate_thickness_m)
        plate_specs.append(
            {
                "group": record["group"],
                "link": record["link"],
                "requested_extent_m": requested_extent,
                "adjusted_extent_m": adjusted_extent,
                "requested_center_m": record["requested_center_m"],
                "requested_design_thickness_m": requested_design_thickness,
                "adjusted_design_thickness_m": adjusted_design_thickness,
                "minimum_process_plate_thickness_m": minimum_plate_thickness_m,
                "thickness_increase_m": adjusted_design_thickness - requested_design_thickness,
                "height_delta_m": adjusted_extent[2] - requested_extent[2],
                "step_path": str(output_root / f"{_safe_filename(str(record['link']))}.step"),
            }
        )
    code = r'''
from __future__ import annotations

import json
from pathlib import Path
import sys

import cadquery as cq

payload = json.loads(sys.stdin.read())
records = []
failures = []
for spec in payload["plates"]:
    step_path = Path(spec["step_path"])
    try:
        step_path.parent.mkdir(parents=True, exist_ok=True)
        extents = [float(value) for value in spec["adjusted_extent_m"]]
        center = [float(value) for value in spec["requested_center_m"]]
        solid = cq.Workplane("XY").box(extents[0], extents[1], extents[2], centered=True)
        solid = solid.translate(tuple(center))
        cq.exporters.export(solid, str(step_path))
        imported = cq.importers.importStep(str(step_path))
        bbox = imported.val().BoundingBox()
        records.append(
            {
                "group": spec["group"],
                "link": spec["link"],
                "step_path": str(step_path),
                "requested_extent_m": spec["requested_extent_m"],
                "adjusted_extent_m": extents,
                "requested_center_m": center,
                "requested_design_thickness_m": spec["requested_design_thickness_m"],
                "adjusted_design_thickness_m": spec["adjusted_design_thickness_m"],
                "minimum_process_plate_thickness_m": spec["minimum_process_plate_thickness_m"],
                "thickness_increase_m": spec["thickness_increase_m"],
                "height_delta_m": spec["height_delta_m"],
                "reloaded_bbox_extent_m": [bbox.xlen, bbox.ylen, bbox.zlen],
                "reloaded_volume_m3": imported.val().Volume(),
                "solid_count": len(imported.solids().vals()),
                "export_ok": step_path.is_file() and step_path.stat().st_size > 0,
                "reload_ok": True,
            }
        )
    except Exception as exc:
        failures.append(
            {
                "link": spec.get("link"),
                "step_path": str(step_path),
                "error": f"{type(exc).__name__}: {exc}",
            }
        )
print(json.dumps({"records": records, "failures": failures}, sort_keys=True))
'''
    try:
        proc = subprocess.run(
            [str(cad_python), "-c", code],
            input=json.dumps({"plates": plate_specs}),
            text=True,
            capture_output=True,
            check=False,
            timeout=timeout_s,
        )
    except Exception as exc:
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "records": [],
            "failures": [{"error": f"{type(exc).__name__}: {exc}"}],
        }
    if proc.returncode != 0:
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "records": [],
            "failures": [{"error": proc.stderr.strip() or proc.stdout.strip()}],
        }
    try:
        parsed = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "records": [],
            "failures": [{"error": f"JSONDecodeError: {exc}", "stdout": proc.stdout}],
        }
    records_out = []
    for record in parsed.get("records", []):
        step_path = Path(record["step_path"])
        records_out.append(
            {
                **record,
                "step_sha256": sha256_file(step_path) if step_path.is_file() else None,
                "step_size_bytes": step_path.stat().st_size if step_path.is_file() else 0,
                "process_floor_satisfied": (
                    float(record["adjusted_design_thickness_m"])
                    >= float(record["minimum_process_plate_thickness_m"])
                ),
            }
        )
    return {
        "ok": not parsed.get("failures"),
        "backend": "cadquery",
        "python": str(cad_python),
        "output_root": str(output_root),
        "minimum_plate_thickness_m": minimum_plate_thickness_m,
        "records": records_out,
        "failures": parsed.get("failures", []),
    }


def _record_with_validation(record: dict[str, Any], tolerance_m: float) -> dict[str, Any]:
    requested = [float(value) for value in record["requested_extent_m"]]
    reloaded = [float(value) for value in record["reloaded_bbox_extent_m"]]
    extent_error = [abs(a - b) for a, b in zip(requested, reloaded, strict=True)]
    step_path = Path(record["step_path"])
    return {
        **record,
        "extent_abs_error_m": extent_error,
        "extent_max_abs_error_m": max(extent_error),
        "extent_within_tolerance": max(extent_error) <= tolerance_m,
        "step_sha256": sha256_file(step_path) if step_path.is_file() else None,
        "step_size_bytes": step_path.stat().st_size if step_path.is_file() else 0,
        "generated_geometry_role": "clearance_adjusted_parametric_reference",
        "accepted": False,
        "blocking_reason": (
            "generated STEP is a first wall-aware parametric reference solid, "
            "not the final manufacturing part with exact mate features, fasteners, "
            "material properties, structural proof, and volume clearance"
        ),
    }


def _volume_adjusted_record(record: dict[str, Any]) -> dict[str, Any]:
    cavity = record.get("internal_cavity", {})
    if not cavity.get("required"):
        return {
            "required": False,
            "height_preserved": True,
            "bbox_extent_m": record["requested_extent_m"],
            "xy_area_increase_fraction": 0.0,
            "z_expansion_required_m": 0.0,
            "internal_cavity": cavity,
        }

    center = [float(value) for value in record["requested_center_m"]]
    current_extents = [float(value) for value in record["requested_extent_m"]]
    wall = float(record["wall_thickness_m"])
    adjusted_extents = list(current_extents)
    required_full_extents = list(current_extents)
    for point in cavity.get("points", []):
        point_m = [float(value) for value in point["point_m"]]
        radius = float(point.get("component_radius_m") or 0.0)
        for axis in range(3):
            required = 2.0 * (
                abs(point_m[axis] - center[axis])
                + radius
                + DEFAULT_INTERNAL_KEEPOUT_MARGIN_M
                + wall
            )
            required_full_extents[axis] = max(required_full_extents[axis], required)
            if axis < 2:
                adjusted_extents[axis] = max(adjusted_extents[axis], required)

    adjusted_cavity = _internal_cavity_report(
        center=center,
        extents=adjusted_extents,
        wall_thickness_m=wall,
        keepout_points=cavity.get("points", []),
        margin_m=DEFAULT_INTERNAL_KEEPOUT_MARGIN_M,
    )
    current_area = current_extents[0] * current_extents[1]
    adjusted_area = adjusted_extents[0] * adjusted_extents[1]
    z_expansion_required = max(0.0, required_full_extents[2] - current_extents[2])
    return {
        "required": True,
        "height_preserved": True,
        "bbox_extent_m": adjusted_extents,
        "full_clearance_bbox_extent_m": required_full_extents,
        "xy_area_increase_fraction": (
            adjusted_area / current_area - 1.0 if current_area > 0.0 else None
        ),
        "z_expansion_required_m": z_expansion_required,
        "z_expansion_required": z_expansion_required > 0.0,
        "internal_cavity": adjusted_cavity,
    }


def _remediation_targets(record: dict[str, Any]) -> list[dict[str, Any]]:
    adjusted_points = {
        (point.get("component_type"), point.get("name")): point
        for point in record.get("volume_adjusted_candidate", {})
        .get("internal_cavity", {})
        .get("points", [])
    }
    targets = []
    for index, point in enumerate(record.get("internal_cavity", {}).get("points", [])):
        if not point.get("violates_internal_cavity"):
            continue
        key = (point.get("component_type"), point.get("name"))
        adjusted = adjusted_points.get(key)
        radius = float(point.get("component_radius_m") or 0.0)
        wall = float(record.get("wall_thickness_m") or 0.0)
        adjusted_clearance = (
            float(adjusted["volume_projected_clearance_m"])
            if adjusted and adjusted.get("volume_projected_clearance_m") is not None
            else None
        )
        targets.append(
            {
                "target_id": f"{record['link']}:{index}:{point.get('component_type')}:{point.get('name')}",
                "group": record["group"],
                "link": record["link"],
                "component_type": point.get("component_type"),
                "name": point.get("name"),
                "point_m": point.get("point_m"),
                "component_radius_m": radius,
                "minimum_margin_m": DEFAULT_INTERNAL_KEEPOUT_MARGIN_M,
                "wall_thickness_m": wall,
                "required_local_pocket_radius_m": radius + DEFAULT_INTERNAL_KEEPOUT_MARGIN_M + wall,
                "current_volume_clearance_m": point.get("volume_projected_clearance_m"),
                "current_limiting_axis": point.get("limiting_axis"),
                "current_limiting_axis_deficit_m": point.get("limiting_axis_deficit_m"),
                "height_preserving_xy_adjusted_clearance_m": adjusted_clearance,
                "still_violates_after_xy_adjustment": (
                    adjusted_clearance is not None and adjusted_clearance < 0.0
                ),
                "z_pocket_or_component_refinement_required": (
                    adjusted_clearance is not None
                    and adjusted_clearance < 0.0
                    and adjusted.get("limiting_axis") == "z"
                )
                if adjusted
                else False,
                "recommended_next_action": (
                    "add local pocket or split-plate relief, then replace conservative default with exact component envelope"
                ),
            }
        )
    return targets


def _link_remediation_plan(record: dict[str, Any]) -> dict[str, Any] | None:
    targets = record.get("remediation_targets", [])
    if not targets:
        return None
    worst_target = min(targets, key=lambda target: float(target["current_volume_clearance_m"]))
    still_blocked = [
        target for target in targets if target["still_violates_after_xy_adjustment"]
    ]
    z_targets = [
        target for target in targets if target["z_pocket_or_component_refinement_required"]
    ]
    xy_targets = [
        target for target in targets if target["current_limiting_axis"] in {"x", "y"}
    ]
    z_expansion = float(
        record.get("volume_adjusted_candidate", {}).get("z_expansion_required_m") or 0.0
    )
    xy_area_increase = record.get("volume_adjusted_candidate", {}).get(
        "xy_area_increase_fraction"
    )
    return {
        "group": record["group"],
        "link": record["link"],
        "target_count": len(targets),
        "still_blocked_after_xy_count": len(still_blocked),
        "z_pocket_or_refinement_count": len(z_targets),
        "xy_bulge_target_count": len(xy_targets),
        "worst_current_clearance_m": worst_target["current_volume_clearance_m"],
        "worst_component_type": worst_target["component_type"],
        "worst_component_name": worst_target["name"],
        "worst_required_local_pocket_radius_m": worst_target["required_local_pocket_radius_m"],
        "height_preserving_xy_area_increase_fraction": xy_area_increase,
        "z_expansion_required_m": z_expansion,
        "primary_strategy": (
            "z_pocket_or_component_refinement"
            if z_targets
            else "xy_local_bulge_or_split_plate"
            if still_blocked or xy_targets
            else "verify_after_xy_envelope_update"
        ),
        "target_component_type_counts": _count_by_key(targets, "component_type"),
        "limiting_axis_counts": _count_by_key(targets, "current_limiting_axis"),
    }


def _plan_priority(plan: dict[str, Any]) -> tuple[float, int, int, float]:
    return (
        float(plan["worst_current_clearance_m"]),
        -int(plan["z_pocket_or_refinement_count"]),
        -int(plan["still_blocked_after_xy_count"]),
        -float(plan.get("z_expansion_required_m") or 0.0),
    )


def _pocketed_preview_risk_plan(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    plans = []
    for record in records:
        removed = float(record.get("volume_removed_fraction") or 0.0)
        solid_count = int(record.get("solid_count") or 0)
        fragmented = solid_count > 1
        high_loss = removed >= 0.5
        if not fragmented and not high_loss:
            continue
        if fragmented and high_loss:
            risk = "critical_fragmented_high_volume_loss"
            action = "replace simple pocket cuts with split structural plates and local external bulges"
        elif high_loss:
            risk = "critical_high_volume_loss"
            action = "replace subtractive pocket with external bulge or exact smaller component envelope"
        else:
            risk = "fragmented_shell"
            action = "bridge shell fragments with ribs, split plates, or local shell thickening"
        plans.append(
            {
                "group": record["group"],
                "link": record["link"],
                "risk": risk,
                "target_count": record["target_count"],
                "solid_count": solid_count,
                "volume_removed_fraction": removed,
                "volume_removed_m3": record["volume_removed_m3"],
                "step_path": record["step_path"],
                "recommended_next_action": action,
            }
        )
    return sorted(
        plans,
        key=lambda plan: (
            0 if str(plan["risk"]).startswith("critical") else 1,
            -float(plan["volume_removed_fraction"]),
            str(plan["link"]),
        ),
    )


def build_fembot_generated_cad_envelope_proof(
    body_groups: list[dict[str, Any]],
    *,
    mesh_dir: Path = ASIMOV1_SOURCE_MESH_DIR,
    mjcf_path: Path = ASIMOV1_GENERATED_MJCF,
    step_root: Path = DEFAULT_STEP_OUTPUT_ROOT,
    pocket_root: Path = DEFAULT_POCKET_OUTPUT_ROOT,
    link_pocket_root: Path = DEFAULT_LINK_POCKET_SET_OUTPUT_ROOT,
    pocketed_preview_root: Path = DEFAULT_POCKETED_PREVIEW_OUTPUT_ROOT,
    bulged_preview_root: Path = DEFAULT_BULGED_PREVIEW_OUTPUT_ROOT,
    ribbed_bulged_preview_root: Path = DEFAULT_RIBBED_BULGED_PREVIEW_OUTPUT_ROOT,
    supplier_vendor_adjusted_root: Path = DEFAULT_SUPPLIER_VENDOR_ADJUSTED_OUTPUT_ROOT,
    manufacturing_adjusted_plate_root: Path = DEFAULT_MANUFACTURING_ADJUSTED_PLATE_OUTPUT_ROOT,
    cad_python: Path | None = None,
    extent_tolerance_m: float = DEFAULT_EXTENT_TOLERANCE_M,
    clearance_report: dict[str, Any] | None = None,
    component_constraint_report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    clearance = clearance_report or build_fembot_clearance_projection_proof(
        body_groups,
        mesh_dir=mesh_dir,
        mjcf_path=mjcf_path,
    )
    specs = _link_specs_from_clearance(clearance, step_root)
    cad_result = _cadquery_generate_and_reload(
        specs=specs,
        cad_python=cad_python or _cad_python(),
    )
    records = [
        _record_with_validation(record, extent_tolerance_m)
        for record in cad_result.get("records", [])
    ]
    records = [
        {
            **record,
            "volume_adjusted_candidate": _volume_adjusted_record(record),
        }
        for record in records
    ]
    records = [
        {
            **record,
            "remediation_targets": _remediation_targets(record),
        }
        for record in records
    ]
    missing_links = sorted(
        {spec["link"] for spec in specs} - {record["link"] for record in records}
    )
    tolerance_failures = [record for record in records if not record["extent_within_tolerance"]]
    cavity_violation_links = [
        record
        for record in records
        if int(record.get("internal_cavity", {}).get("violation_count") or 0) > 0
    ]
    volume_adjusted_violation_links = [
        record
        for record in records
        if int(
            record.get("volume_adjusted_candidate", {})
            .get("internal_cavity", {})
            .get("violation_count")
            or 0
        )
        > 0
    ]
    volume_adjusted_z_blocked_links = [
        record
        for record in records
        if record.get("volume_adjusted_candidate", {}).get("z_expansion_required")
    ]
    remediation_targets = [
        target for record in records for target in record.get("remediation_targets", [])
    ]
    prioritized_targets = sorted(
        remediation_targets,
        key=lambda target: (
            float(target["current_volume_clearance_m"]),
            0 if target["z_pocket_or_component_refinement_required"] else 1,
            str(target["link"]),
        ),
    )
    for rank, target in enumerate(prioritized_targets, start=1):
        target["priority_rank"] = rank
    still_blocked_targets = [
        target for target in remediation_targets if target["still_violates_after_xy_adjustment"]
    ]
    z_pocket_targets = [
        target for target in remediation_targets if target["z_pocket_or_component_refinement_required"]
    ]
    remediation_plans = [
        plan for record in records if (plan := _link_remediation_plan(record)) is not None
    ]
    prioritized_remediation_plans = sorted(remediation_plans, key=_plan_priority)
    pocket_result = _cadquery_export_pocket_markers(
        targets=prioritized_targets,
        pocket_root=pocket_root,
        cad_python=cad_python or _cad_python(),
    )
    link_pocket_result = _cadquery_export_link_pocket_sets(
        targets=prioritized_targets,
        link_pocket_root=link_pocket_root,
        cad_python=cad_python or _cad_python(),
    )
    pocket_records_by_target = {
        record["target_id"]: record for record in pocket_result.get("records", [])
    }
    link_pocket_records_by_link = {
        record["link"]: record for record in link_pocket_result.get("records", [])
    }
    for record in records:
        link_pocket = link_pocket_records_by_link.get(record["link"])
        if link_pocket:
            record["link_pocket_set_step_path"] = link_pocket["step_path"]
            record["link_pocket_set_step_sha256"] = link_pocket["step_sha256"]
            record["link_pocket_set_solid_count"] = link_pocket["solid_count"]
        for target in record.get("remediation_targets", []):
            pocket = pocket_records_by_target.get(target["target_id"])
            if pocket:
                target["pocket_step_path"] = pocket["step_path"]
                target["pocket_step_sha256"] = pocket["step_sha256"]
                target["pocket_step_size_bytes"] = pocket["step_size_bytes"]
    pocketed_preview_result = _cadquery_export_pocketed_previews(
        records=records,
        preview_root=pocketed_preview_root,
        cad_python=cad_python or _cad_python(),
    )
    bulged_preview_result = _cadquery_export_pocketed_previews(
        records=records,
        preview_root=bulged_preview_root,
        cad_python=cad_python or _cad_python(),
        bulge_extra_wall_m=DEFAULT_BULGE_EXTRA_WALL_M,
    )
    pocketed_preview_records_by_link = {
        record["link"]: record for record in pocketed_preview_result.get("records", [])
    }
    for record in records:
        preview = pocketed_preview_records_by_link.get(record["link"])
        if preview:
            record["pocketed_preview_step_path"] = preview["step_path"]
            record["pocketed_preview_step_sha256"] = preview["step_sha256"]
            record["pocketed_preview_solid_count"] = preview["solid_count"]
            record["pocketed_preview_volume_removed_fraction"] = preview[
                "volume_removed_fraction"
            ]
    pocketed_preview_risk_plan = _pocketed_preview_risk_plan(
        pocketed_preview_result.get("records", [])
    )
    bulged_preview_residual_risk_plan = _pocketed_preview_risk_plan(
        bulged_preview_result.get("records", [])
    )
    ribbed_bulged_preview_result = _cadquery_export_ribbed_bulged_previews(
        records=records,
        preview_root=ribbed_bulged_preview_root,
        cad_python=cad_python or _cad_python(),
        candidate_links=[plan["link"] for plan in bulged_preview_residual_risk_plan],
    )
    ribbed_bulged_preview_risk_plan = _pocketed_preview_risk_plan(
        ribbed_bulged_preview_result.get("records", [])
    )
    manufacturing_adjusted_plate_result = _cadquery_export_manufacturing_adjusted_flat_plates(
        records=records,
        output_root=manufacturing_adjusted_plate_root,
        cad_python=cad_python or _cad_python(),
    )
    manufacturing_adjusted_plates_by_link = {
        record["link"]: record
        for record in manufacturing_adjusted_plate_result.get("records", [])
    }
    for record in records:
        adjusted_plate = manufacturing_adjusted_plates_by_link.get(record["link"])
        if adjusted_plate:
            record["manufacturing_adjusted_plate"] = adjusted_plate
    supplier_growth_links = _supplier_growth_by_link(
        component_constraint_report or _load_component_constraints_report()
    )
    supplier_vendor_specs = _supplier_vendor_adjusted_specs(
        records,
        supplier_growth_by_link=supplier_growth_links,
        step_root=supplier_vendor_adjusted_root,
    )
    supplier_vendor_result = _cadquery_generate_and_reload(
        specs=supplier_vendor_specs,
        cad_python=cad_python or _cad_python(),
    )
    supplier_vendor_records = [
        {
            **_record_with_validation(record, extent_tolerance_m),
            "generated_geometry_role": "supplier_vendor_adjusted_parametric_reference",
        }
        for record in supplier_vendor_result.get("records", [])
    ]
    supplier_vendor_records_by_link = {
        record["link"]: record for record in supplier_vendor_records
    }
    supplier_vendor_specs_by_link = {
        spec["link"]: spec for spec in supplier_vendor_specs
    }
    for record in records:
        supplier_growth = supplier_growth_links.get(record["link"])
        if not supplier_growth:
            record["supplier_vendor_adjusted_candidate"] = {
                "required": False,
                "requires_growth": False,
            }
            continue
        supplier_spec = supplier_vendor_specs_by_link[record["link"]]
        supplier_preview = supplier_vendor_records_by_link.get(record["link"])
        original_volume = float(record.get("reloaded_volume_m3") or 0.0)
        preview_volume = (
            float(supplier_preview.get("reloaded_volume_m3") or 0.0)
            if supplier_preview
            else None
        )
        fit_validation = _supplier_vendor_fit_after_adjustment(
            supplier_growth=supplier_growth,
            adjusted_extent_m=(
                [float(value) for value in supplier_preview["reloaded_bbox_extent_m"]]
                if supplier_preview and supplier_preview.get("reloaded_bbox_extent_m")
                else None
            ),
            margin_m=DEFAULT_SUPPLIER_VENDOR_FIT_MARGIN_M,
        )
        record["supplier_vendor_adjusted_candidate"] = {
            "required": True,
            "requires_growth": True,
            "generated_geometry_role": "supplier_vendor_adjusted_parametric_reference",
            "growth_source": supplier_growth,
            "sorted_axis_indices": supplier_spec["supplier_vendor_sorted_axis_indices"],
            "axis_growth_m": supplier_spec["supplier_vendor_axis_growth_m"],
            "requested_extent_m": supplier_spec["extent_m"],
            "step_path": supplier_preview.get("step_path") if supplier_preview else supplier_spec["step_path"],
            "step_sha256": supplier_preview.get("step_sha256") if supplier_preview else None,
            "step_size_bytes": supplier_preview.get("step_size_bytes") if supplier_preview else 0,
            "reload_ok": bool(supplier_preview and supplier_preview.get("reload_ok")),
            "solid_count": supplier_preview.get("solid_count") if supplier_preview else None,
            "extent_within_tolerance": (
                bool(supplier_preview.get("extent_within_tolerance"))
                if supplier_preview
                else False
            ),
            "reloaded_bbox_extent_m": (
                supplier_preview.get("reloaded_bbox_extent_m") if supplier_preview else None
            ),
            "reloaded_volume_m3": preview_volume,
            "volume_increase_fraction": (
                preview_volume / original_volume - 1.0
                if preview_volume is not None and original_volume > 0.0
                else None
            ),
            "internal_cavity_violation_count": int(
                (supplier_spec.get("internal_cavity") or {}).get("violation_count") or 0
            ),
            "fit_validation": fit_validation,
            "accepted": False,
            "blocking_reason": (
                "supplier vendor keepout preview grows the parametric envelope, "
                "but production acceptance still needs exact component pockets, "
                "mate features, structural proof, and final collision/MuJoCo validation"
            ),
        }
    ok = bool(
        clearance.get("ok")
        and cad_result.get("ok")
        and len(specs) == 28
        and len(records) == 28
        and not missing_links
        and not tolerance_failures
    )
    total_bbox_volume = sum(
        float(record["requested_extent_m"][0])
        * float(record["requested_extent_m"][1])
        * float(record["requested_extent_m"][2])
        for record in records
    )
    shape_family_counts: dict[str, int] = {}
    surface_intent_counts: dict[str, int] = {}
    for record in records:
        shape_family = str(record["shape_family"])
        surface_intent = str(record["surface_intent"])
        shape_family_counts[shape_family] = shape_family_counts.get(shape_family, 0) + 1
        surface_intent_counts[surface_intent] = surface_intent_counts.get(surface_intent, 0) + 1
    supplier_vendor_fit_validations = [
        candidate.get("fit_validation", {})
        for record in records
        if (candidate := record.get("supplier_vendor_adjusted_candidate", {})).get("required")
    ]
    return {
        "schema": GENERATED_CAD_SCHEMA,
        "ok": ok,
        "accepted": False,
        "source": {
            "mesh_dir": str(mesh_dir),
            "mjcf": str(mjcf_path),
            "clearance_projection_schema": clearance.get("schema"),
            "step_root": str(step_root),
            "pocket_root": str(pocket_root),
            "link_pocket_root": str(link_pocket_root),
            "pocketed_preview_root": str(pocketed_preview_root),
            "bulged_preview_root": str(bulged_preview_root),
            "ribbed_bulged_preview_root": str(ribbed_bulged_preview_root),
            "supplier_vendor_adjusted_root": str(supplier_vendor_adjusted_root),
            "manufacturing_adjusted_plate_root": str(manufacturing_adjusted_plate_root),
            "cad_backend": cad_result.get("backend"),
            "cad_python": cad_result.get("python"),
            "extent_tolerance_m": extent_tolerance_m,
        },
        "summary": {
            "links": len(records),
            "requested_links": len(specs),
            "missing_links": missing_links,
            "step_exports": sum(1 for record in records if record["export_ok"]),
            "step_reloads": sum(1 for record in records if record["reload_ok"]),
            "single_solid_links": sum(1 for record in records if record["solid_count"] == 1),
            "extent_tolerance_failures": len(tolerance_failures),
            "shape_family_counts": dict(sorted(shape_family_counts.items())),
            "surface_intent_counts": dict(sorted(surface_intent_counts.items())),
            "hollow_shell_links": sum(
                1 for record in records if record.get("internal_cavity", {}).get("required")
            ),
            "flat_plate_links": sum(1 for record in records if record["surface_intent"] == "flat"),
            "wall_thickness_m": DEFAULT_SMOOTH_SHELL_WALL_THICKNESS_M,
            "internal_keepout_margin_m": DEFAULT_INTERNAL_KEEPOUT_MARGIN_M,
            "internal_cavity_violation_links": len(cavity_violation_links),
            "internal_cavity_violations": sum(
                int(record.get("internal_cavity", {}).get("violation_count") or 0)
                for record in records
            ),
            "internal_cavity_minimum_projected_clearance_m": min(
                (
                    float(record["internal_cavity"]["minimum_projected_clearance_m"])
                    for record in records
                    if record.get("internal_cavity", {}).get("minimum_projected_clearance_m")
                    is not None
                ),
                default=None,
            ),
            "volume_adjusted_xy_violation_links": len(volume_adjusted_violation_links),
            "volume_adjusted_xy_violations": sum(
                int(
                    record.get("volume_adjusted_candidate", {})
                    .get("internal_cavity", {})
                    .get("violation_count")
                    or 0
                )
                for record in records
            ),
            "volume_adjusted_xy_minimum_projected_clearance_m": min(
                (
                    float(
                        record["volume_adjusted_candidate"]["internal_cavity"][
                            "minimum_projected_clearance_m"
                        ]
                    )
                    for record in records
                    if record.get("volume_adjusted_candidate", {})
                    .get("internal_cavity", {})
                    .get("minimum_projected_clearance_m")
                    is not None
                ),
                default=None,
            ),
            "volume_adjusted_z_blocked_links": len(volume_adjusted_z_blocked_links),
            "volume_adjusted_max_z_expansion_required_m": max(
                (
                    float(
                        record.get("volume_adjusted_candidate", {}).get(
                            "z_expansion_required_m"
                        )
                        or 0.0
                    )
                    for record in records
                ),
                default=0.0,
            ),
            "volume_adjusted_max_xy_area_increase_fraction": max(
                (
                    float(
                        record.get("volume_adjusted_candidate", {}).get(
                            "xy_area_increase_fraction"
                        )
                        or 0.0
                    )
                    for record in records
                ),
                default=0.0,
            ),
            "remediation_target_count": len(remediation_targets),
            "remediation_still_blocked_after_xy_count": len(still_blocked_targets),
            "remediation_z_pocket_or_refinement_count": len(z_pocket_targets),
            "remediation_component_type_counts": _count_by_key(
                remediation_targets,
                "component_type",
            ),
            "remediation_limiting_axis_counts": _count_by_key(
                remediation_targets,
                "current_limiting_axis",
            ),
            "remediation_plan_links": len(remediation_plans),
            "remediation_top_priority_links": [
                plan["link"] for plan in prioritized_remediation_plans[:8]
            ],
            "remediation_pocket_step_exports": sum(
                1 for record in pocket_result.get("records", []) if record["export_ok"]
            ),
            "remediation_pocket_step_reloads": sum(
                1 for record in pocket_result.get("records", []) if record["reload_ok"]
            ),
            "remediation_pocket_step_failures": len(pocket_result.get("failures", [])),
            "remediation_pocket_step_root": str(pocket_root),
            "remediation_link_pocket_set_exports": sum(
                1 for record in link_pocket_result.get("records", []) if record["export_ok"]
            ),
            "remediation_link_pocket_set_reloads": sum(
                1 for record in link_pocket_result.get("records", []) if record["reload_ok"]
            ),
            "remediation_link_pocket_set_failures": len(
                link_pocket_result.get("failures", [])
            ),
            "remediation_link_pocket_set_root": str(link_pocket_root),
            "remediation_link_pocket_set_total_solids": sum(
                int(record["solid_count"]) for record in link_pocket_result.get("records", [])
            ),
            "pocketed_preview_exports": sum(
                1 for record in pocketed_preview_result.get("records", []) if record["export_ok"]
            ),
            "pocketed_preview_reloads": sum(
                1 for record in pocketed_preview_result.get("records", []) if record["reload_ok"]
            ),
            "pocketed_preview_failures": len(pocketed_preview_result.get("failures", [])),
            "pocketed_preview_root": str(pocketed_preview_root),
            "pocketed_preview_fragmented_links": sum(
                1 for record in pocketed_preview_result.get("records", []) if record["solid_count"] > 1
            ),
            "pocketed_preview_high_volume_loss_links": sum(
                1
                for record in pocketed_preview_result.get("records", [])
                if float(record.get("volume_removed_fraction") or 0.0) >= 0.5
            ),
            "pocketed_preview_structural_risk_links": len(pocketed_preview_risk_plan),
            "pocketed_preview_top_structural_risk_links": [
                plan["link"] for plan in pocketed_preview_risk_plan[:8]
            ],
            "pocketed_preview_max_volume_removed_fraction": max(
                (
                    float(record.get("volume_removed_fraction") or 0.0)
                    for record in pocketed_preview_result.get("records", [])
                ),
                default=0.0,
            ),
            "bulged_preview_exports": sum(
                1 for record in bulged_preview_result.get("records", []) if record["export_ok"]
            ),
            "bulged_preview_reloads": sum(
                1 for record in bulged_preview_result.get("records", []) if record["reload_ok"]
            ),
            "bulged_preview_failures": len(bulged_preview_result.get("failures", [])),
            "bulged_preview_fragmented_links": sum(
                1 for record in bulged_preview_result.get("records", []) if record["solid_count"] > 1
            ),
            "bulged_preview_high_volume_loss_links": sum(
                1
                for record in bulged_preview_result.get("records", [])
                if float(record.get("volume_removed_fraction") or 0.0) >= 0.5
            ),
            "bulged_preview_max_volume_removed_fraction": max(
                (
                    float(record.get("volume_removed_fraction") or 0.0)
                    for record in bulged_preview_result.get("records", [])
                ),
                default=0.0,
            ),
            "bulged_preview_residual_structural_risk_links": len(
                bulged_preview_residual_risk_plan
            ),
            "bulged_preview_top_residual_risk_links": [
                plan["link"] for plan in bulged_preview_residual_risk_plan[:8]
            ],
            "bulge_extra_wall_m": DEFAULT_BULGE_EXTRA_WALL_M,
            "ribbed_bulged_preview_candidates": len(
                ribbed_bulged_preview_result.get("records", [])
            ),
            "ribbed_bulged_preview_exports": sum(
                1
                for record in ribbed_bulged_preview_result.get("records", [])
                if record["export_ok"]
            ),
            "ribbed_bulged_preview_reloads": sum(
                1
                for record in ribbed_bulged_preview_result.get("records", [])
                if record["reload_ok"]
            ),
            "ribbed_bulged_preview_failures": len(
                ribbed_bulged_preview_result.get("failures", [])
            ),
            "ribbed_bulged_preview_fragmented_links": sum(
                1
                for record in ribbed_bulged_preview_result.get("records", [])
                if record["solid_count"] > 1
            ),
            "ribbed_bulged_preview_high_volume_loss_links": sum(
                1
                for record in ribbed_bulged_preview_result.get("records", [])
                if float(record.get("volume_removed_fraction") or 0.0) >= 0.5
            ),
            "ribbed_bulged_preview_residual_structural_risk_links": len(
                ribbed_bulged_preview_risk_plan
            ),
            "ribbed_bulged_preview_top_residual_risk_links": [
                plan["link"] for plan in ribbed_bulged_preview_risk_plan[:8]
            ],
            "ribbed_bulged_preview_root": str(ribbed_bulged_preview_root),
            "ribbed_bulged_preview_rib_thickness_m": DEFAULT_RIB_THICKNESS_M,
            "ribbed_bulged_preview_total_ribs": sum(
                int(record.get("rib_count") or 0)
                for record in ribbed_bulged_preview_result.get("records", [])
            ),
            "supplier_vendor_adjusted_candidates": len(supplier_vendor_specs),
            "supplier_vendor_adjusted_exports": sum(
                1 for record in supplier_vendor_records if record["export_ok"]
            ),
            "supplier_vendor_adjusted_reloads": sum(
                1 for record in supplier_vendor_records if record["reload_ok"]
            ),
            "supplier_vendor_adjusted_failures": len(
                supplier_vendor_result.get("failures", [])
            ),
            "supplier_vendor_adjusted_extent_tolerance_failures": sum(
                1 for record in supplier_vendor_records if not record["extent_within_tolerance"]
            ),
            "supplier_vendor_adjusted_single_solid_links": sum(
                1 for record in supplier_vendor_records if int(record["solid_count"]) == 1
            ),
            "supplier_vendor_adjusted_links": [
                record["link"] for record in sorted(supplier_vendor_records, key=lambda item: item["link"])
            ],
            "supplier_vendor_adjusted_max_axis_growth_m": max(
                (
                    max(float(value) for value in spec["supplier_vendor_axis_growth_m"])
                    for spec in supplier_vendor_specs
                ),
                default=0.0,
            ),
            "supplier_vendor_adjusted_max_volume_increase_fraction": max(
                (
                    float(
                        (
                            {record["link"]: record for record in records}[supplier_record["link"]]
                            .get("supplier_vendor_adjusted_candidate", {})
                            .get("volume_increase_fraction")
                        )
                        or 0.0
                    )
                    for supplier_record in supplier_vendor_records
                ),
                default=0.0,
            ),
            "supplier_vendor_adjusted_fit_checked": sum(
                int(validation.get("fit_check_count") or 0)
                for validation in supplier_vendor_fit_validations
            ),
            "supplier_vendor_adjusted_fit_pass": sum(
                int(validation.get("fit_pass_count") or 0)
                for validation in supplier_vendor_fit_validations
            ),
            "supplier_vendor_adjusted_fit_fail": sum(
                int(validation.get("fit_fail_count") or 0)
                for validation in supplier_vendor_fit_validations
            ),
            "supplier_vendor_adjusted_fit_pass_links": sum(
                1 for validation in supplier_vendor_fit_validations if validation.get("all_fit")
            ),
            "supplier_vendor_adjusted_fit_fail_links": sum(
                1 for validation in supplier_vendor_fit_validations if not validation.get("all_fit")
            ),
            "supplier_vendor_adjusted_max_residual_extent_growth_m": max(
                (
                    float(validation.get("max_residual_extent_growth_m") or 0.0)
                    for validation in supplier_vendor_fit_validations
                ),
                default=0.0,
            ),
            "supplier_vendor_adjusted_fit_margin_m": DEFAULT_SUPPLIER_VENDOR_FIT_MARGIN_M,
            "supplier_vendor_adjusted_root": str(supplier_vendor_adjusted_root),
            "manufacturing_adjusted_plate_exports": sum(
                1
                for record in manufacturing_adjusted_plate_result.get("records", [])
                if record["export_ok"]
            ),
            "manufacturing_adjusted_plate_reloads": sum(
                1
                for record in manufacturing_adjusted_plate_result.get("records", [])
                if record["reload_ok"]
            ),
            "manufacturing_adjusted_plate_failures": len(
                manufacturing_adjusted_plate_result.get("failures", [])
            ),
            "manufacturing_adjusted_plate_process_floor_m": (
                DEFAULT_ALU_PLATE_PROCESS_MIN_THICKNESS_M
            ),
            "manufacturing_adjusted_plate_max_thickness_increase_m": max(
                (
                    float(record.get("thickness_increase_m") or 0.0)
                    for record in manufacturing_adjusted_plate_result.get("records", [])
                ),
                default=0.0,
            ),
            "manufacturing_adjusted_plate_max_height_delta_m": max(
                (
                    float(record.get("height_delta_m") or 0.0)
                    for record in manufacturing_adjusted_plate_result.get("records", [])
                ),
                default=0.0,
            ),
            "manufacturing_adjusted_plate_process_floor_failures": sum(
                1
                for record in manufacturing_adjusted_plate_result.get("records", [])
                if not record["process_floor_satisfied"]
            ),
            "manufacturing_adjusted_plate_root": str(manufacturing_adjusted_plate_root),
            "max_extent_abs_error_m": max(
                (float(record["extent_max_abs_error_m"]) for record in records),
                default=None,
            ),
            "total_adjusted_bbox_volume_m3": total_bbox_volume,
            "total_generated_solid_volume_m3": sum(
                float(record["reloaded_volume_m3"]) for record in records
            ),
            "clearance_adjusted_violation_links": clearance.get("summary", {}).get(
                "adjusted_violation_links"
            ),
            "accepted": False,
            "acceptance_blocker": (
                "generated geometry is currently a clearance-adjusted parametric "
                "reference per link; final fembot parts still need exact mate "
                "features, fastener/bearing seats, material/process checks, "
                "structural simulation, collision sweeps, and MuJoCo validation"
            ),
        },
        "remediation_plan": prioritized_remediation_plans,
        "cad_generation": cad_result,
        "pocket_generation": pocket_result,
        "link_pocket_generation": link_pocket_result,
        "pocketed_preview_generation": pocketed_preview_result,
        "bulged_preview_generation": bulged_preview_result,
        "ribbed_bulged_preview_generation": ribbed_bulged_preview_result,
        "supplier_vendor_adjusted_generation": {
            **supplier_vendor_result,
            "records": supplier_vendor_records,
        },
        "manufacturing_adjusted_plate_generation": manufacturing_adjusted_plate_result,
        "pocketed_preview_structural_risk_plan": pocketed_preview_risk_plan,
        "bulged_preview_residual_structural_risk_plan": bulged_preview_residual_risk_plan,
        "ribbed_bulged_preview_residual_structural_risk_plan": (
            ribbed_bulged_preview_risk_plan
        ),
        "link_steps": records,
    }


def dump_fembot_generated_cad_envelope_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_generated_cad_envelope_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-generated-cad-envelope.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_fembot_generated_cad_envelope_proof_json(report), encoding="utf-8")
    return output
