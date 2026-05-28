"""Supplier-vendor pocket placement planning proof for ASIMOV fembot links."""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.cad import sha256_file
from eliza_robot.asimov_1.fembot_component_constraints import (
    build_fembot_component_constraint_coverage_proof,
)
from eliza_robot.asimov_1.fembot_generated_cad import (
    DEFAULT_EXTENT_TOLERANCE_M,
    _cad_python,
    build_fembot_generated_cad_envelope_proof,
)
from eliza_robot.asimov_1.fembot_parametric_constraints import (
    build_fembot_parametric_constraints_proof,
)
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_FEMININE_CAD_ROOT, ASIMOV_PARAM_PROOFS

FEMBOT_SUPPLIER_POCKET_PLAN_SCHEMA = "asimov-fembot-supplier-pocket-plan-v1"
DEFAULT_PLACEMENT_PROXY_OUTPUT_ROOT = (
    ASIMOV_FEMININE_CAD_ROOT
    / "output"
    / "generated-cad"
    / "supplier-pocket-placement-candidate-step"
)


def _load_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _supplier_targets_by_code(report: dict[str, Any]) -> dict[str, dict[str, Any]]:
    summary = report.get("vendor_envelope_summary", {})
    targets = (
        summary.get("supplier_code_targets")
        or summary.get("supplier_code_classification_targets")
        or []
    )
    return {
        str(target.get("supplier_code")): target
        for target in targets
        if target.get("supplier_code")
    }


def _generated_by_link(report: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        str(record.get("link", "")).upper(): record
        for record in report.get("link_steps", [])
        if record.get("link")
    }


def _parametric_supplier_links(report: dict[str, Any]) -> set[str]:
    links: set[str] = set()
    for record in report.get("links", []):
        if not isinstance(record, dict):
            continue
        link = str(record.get("link", "")).upper()
        if not link:
            continue
        if any(
            isinstance(constraint, dict)
            and constraint.get("name") == "supplier_vendor_keepout_growth"
            for constraint in record.get("constraints", [])
        ):
            links.add(link)
    return links


def _generated_supplier_adjusted_links(report: dict[str, Any]) -> set[str]:
    links: set[str] = set()
    for record in report.get("link_steps", []):
        if not isinstance(record, dict):
            continue
        link = str(record.get("link", "")).upper()
        candidate = record.get("supplier_vendor_adjusted_candidate") or {}
        if link and candidate.get("required") and candidate.get("reload_ok"):
            links.add(link)
    return links


def _supplier_code_body_summary(target: dict[str, Any]) -> dict[str, Any]:
    body_extents = [
        [float(value) for value in extent]
        for geometry in target.get("geometry_records", [])
        for extent in geometry.get("body_bbox_extents_m", [])
        if isinstance(extent, list) and len(extent) == 3
    ]
    unique_paths = sorted(
        {
            str(geometry.get("path"))
            for geometry in target.get("geometry_records", [])
            if geometry.get("path")
        }
    )
    return {
        "source_path_count": len(unique_paths),
        "source_paths": unique_paths,
        "body_count": len(body_extents),
        "max_body_extent_m": max((max(extent) for extent in body_extents), default=None),
        "body_bbox_extents_m": body_extents,
    }


def _fit_reports_by_supplier(candidate: dict[str, Any]) -> dict[str, dict[str, Any]]:
    validation = candidate.get("fit_validation") or {}
    return {
        str(report.get("supplier_code")): report
        for report in validation.get("reports", [])
        if report.get("supplier_code")
    }


def _safe_filename(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-") or "unnamed"


def _placement_proxy_extent_xyz(record: dict[str, Any]) -> list[float] | None:
    transform = record.get("placement_transform_m") or {}
    axis_indices = transform.get("sorted_extent_axis_indices") or []
    required = record.get("required_sorted_extent_m") or []
    if len(axis_indices) != 3 or len(required) != 3:
        return None
    extents = [0.0, 0.0, 0.0]
    for sorted_index, axis_index in enumerate(axis_indices):
        if int(axis_index) not in {0, 1, 2}:
            return None
        extents[int(axis_index)] = float(required[sorted_index])
    if any(value <= 0.0 for value in extents):
        return None
    return extents


def _placement_proxy_specs(
    records: list[dict[str, Any]],
    *,
    placement_proxy_root: Path,
) -> list[dict[str, Any]]:
    specs = []
    for record in records:
        extents = _placement_proxy_extent_xyz(record)
        transform = record.get("placement_transform_m") or {}
        center = transform.get("translation_m") or []
        if extents is None or len(center) != 3:
            continue
        link = str(record["link"]).upper()
        supplier_code = str(record["supplier_code"])
        step_path = (
            placement_proxy_root
            / link.lower()
            / f"{_safe_filename(supplier_code)}-placement-candidate.step"
        )
        specs.append(
            {
                "link": link,
                "supplier_code": supplier_code,
                "step_path": str(step_path),
                "requested_extent_m": extents,
                "requested_center_m": [float(value) for value in center],
            }
        )
    return specs


def _cadquery_export_placement_proxies(
    *,
    specs: list[dict[str, Any]],
    cad_python: Path,
    timeout_s: int = 120,
) -> dict[str, Any]:
    if not specs:
        return {
            "ok": True,
            "backend": "cadquery",
            "python": str(cad_python),
            "records": [],
            "failures": [],
        }
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

payload = json.loads(sys.stdin.read())
records = []
failures = []
for spec in payload["specs"]:
    step_path = Path(spec["step_path"])
    try:
        step_path.parent.mkdir(parents=True, exist_ok=True)
        extents = [float(value) for value in spec["requested_extent_m"]]
        center = [float(value) for value in spec["requested_center_m"]]
        solid = cq.Workplane("XY").box(extents[0], extents[1], extents[2], centered=True)
        solid = solid.translate(tuple(center))
        cq.exporters.export(solid, str(step_path))
        imported = cq.importers.importStep(str(step_path))
        bbox = imported.val().BoundingBox()
        records.append(
            {
                "link": spec["link"],
                "supplier_code": spec["supplier_code"],
                "step_path": str(step_path),
                "requested_extent_m": extents,
                "requested_center_m": center,
                "reloaded_bbox_min_m": [bbox.xmin, bbox.ymin, bbox.zmin],
                "reloaded_bbox_max_m": [bbox.xmax, bbox.ymax, bbox.zmax],
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
                "supplier_code": spec.get("supplier_code"),
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


def _attach_placement_proxy_results(
    records: list[dict[str, Any]],
    *,
    proxy_result: dict[str, Any],
    extent_tolerance_m: float,
) -> None:
    by_key = {
        (str(record.get("link", "")).upper(), str(record.get("supplier_code", ""))): record
        for record in proxy_result.get("records", [])
    }
    for record in records:
        key = (str(record["link"]).upper(), str(record["supplier_code"]))
        proxy = by_key.get(key)
        if proxy is None:
            record.update(
                {
                    "placement_proxy_step_path": None,
                    "placement_proxy_step_sha256": None,
                    "placement_proxy_reload_ok": False,
                    "placement_proxy_extent_within_tolerance": False,
                    "placement_proxy_solid_count": 0,
                    "placement_proxy_verified": False,
                }
            )
            mate = record.get("mate_feature_assignment")
            if isinstance(mate, dict):
                mate["proxy_verified"] = False
            continue
        step_path = Path(str(proxy["step_path"]))
        requested = [float(value) for value in proxy.get("requested_extent_m", [])]
        reloaded = [float(value) for value in proxy.get("reloaded_bbox_extent_m", [])]
        extent_deltas = [
            abs(reloaded[index] - requested[index])
            for index in range(min(len(requested), len(reloaded)))
        ]
        extent_within_tolerance = (
            len(requested) == 3
            and len(reloaded) == 3
            and all(delta <= extent_tolerance_m for delta in extent_deltas)
        )
        record.update(
            {
                "placement_proxy_step_path": str(step_path),
                "placement_proxy_step_sha256": sha256_file(step_path)
                if step_path.is_file()
                else None,
                "placement_proxy_requested_extent_m": requested,
                "placement_proxy_reloaded_bbox_extent_m": reloaded,
                "placement_proxy_extent_delta_m": extent_deltas,
                "placement_proxy_reload_ok": bool(proxy.get("reload_ok")),
                "placement_proxy_extent_within_tolerance": extent_within_tolerance,
                "placement_proxy_solid_count": int(proxy.get("solid_count") or 0),
                "placement_proxy_verified": bool(
                    proxy.get("reload_ok")
                    and extent_within_tolerance
                    and int(proxy.get("solid_count") or 0) == 1
                ),
            }
        )
        mate = record.get("mate_feature_assignment")
        if isinstance(mate, dict):
            mate["proxy_verified"] = bool(
                record["placement_proxy_verified"]
                and len(record.get("mate_feature_ids") or []) >= 3
            )


def _candidate_placement_transform(
    *,
    generated: dict[str, Any],
    candidate: dict[str, Any],
    fit_report: dict[str, Any],
) -> dict[str, Any]:
    center = [
        float(value)
        for value in generated.get("requested_center_m", generated.get("center_m", [0.0, 0.0, 0.0]))
    ]
    axis_indices = [
        int(value)
        for value in candidate.get("sorted_axis_indices", [0, 1, 2])
    ]
    available = [
        float(value)
        for value in fit_report.get("available_sorted_extent_after_margin_m", [])
    ]
    required = [
        float(value)
        for value in fit_report.get("required_sorted_extent_m", [])
    ]
    slack = [
        available[index] - required[index]
        for index in range(min(len(available), len(required)))
    ]
    return {
        "source": "generated_bbox_center_axis_aligned_hypothesis",
        "translation_m": center,
        "rotation_quat_xyzw": [0.0, 0.0, 0.0, 1.0],
        "sorted_extent_axis_indices": axis_indices,
        "axis_alignment": {
            "short_axis": ("x", "y", "z")[axis_indices[0]],
            "middle_axis": ("x", "y", "z")[axis_indices[1]],
            "long_axis": ("x", "y", "z")[axis_indices[2]],
        }
        if len(axis_indices) == 3
        else None,
        "required_sorted_extent_m": required,
        "available_minus_required_sorted_extent_m": slack,
        "minimum_sorted_extent_slack_m": min(slack) if slack else None,
        "accepted": False,
        "blocking_reason": (
            "axis-aligned bbox-center transform is a placement hypothesis; exact "
            "STEP assembly transform and mate faces are not assigned"
        ),
    }


def _supplier_code_family(supplier_code: str) -> str:
    if supplier_code.startswith(("1600", "1602")):
        return "bearing_or_ring"
    if supplier_code.startswith(("2806", "2920")) or supplier_code.startswith("91390"):
        return "fastener_or_thread"
    return "vendor_off_the_shelf"


def _candidate_mate_feature_ids(
    *,
    link: str,
    supplier_code: str,
    placement_transform: dict[str, Any],
) -> list[str]:
    axis_alignment = placement_transform.get("axis_alignment") or {}
    return [
        f"{link}:{supplier_code}:bbox-center",
        f"{link}:{supplier_code}:short-axis-{axis_alignment.get('short_axis', 'unknown')}",
        f"{link}:{supplier_code}:long-axis-{axis_alignment.get('long_axis', 'unknown')}",
    ]


def _tool_access_candidate(
    *,
    supplier_family: str,
    placement_transform: dict[str, Any],
) -> dict[str, Any]:
    slack = [
        float(value)
        for value in placement_transform.get("available_minus_required_sorted_extent_m", [])
    ]
    minimum_slack = min(slack) if slack else None
    family_requires_fastener_tooling = supplier_family == "fastener_or_thread"
    return {
        "required": family_requires_fastener_tooling,
        "candidate": bool(
            family_requires_fastener_tooling
            and minimum_slack is not None
            and minimum_slack >= 0.0
        ),
        "minimum_sorted_extent_slack_m": minimum_slack,
        "source": "sorted_bbox_slack_screen",
        "verified": False,
        "blocking_reason": (
            "fastener/tool access has only an axis-aligned bbox slack screen; "
            "tool approach cone and exact thread/mate geometry are not assigned"
        )
        if family_requires_fastener_tooling
        else None,
    }


def _generated_bbox_bounds(generated: dict[str, Any]) -> tuple[list[float], list[float]] | None:
    center = [
        float(value)
        for value in generated.get("requested_center_m", generated.get("center_m", []))
    ]
    extents = [
        float(value)
        for value in generated.get("requested_extent_m", generated.get("extent_m", []))
    ]
    if len(center) != 3 or len(extents) != 3 or any(value <= 0.0 for value in extents):
        return None
    half = [value / 2.0 for value in extents]
    return (
        [center[index] - half[index] for index in range(3)],
        [center[index] + half[index] for index in range(3)],
    )


def _pocket_bounds_from_transform(
    *,
    placement_transform: dict[str, Any],
) -> tuple[list[float], list[float]] | None:
    center = [float(value) for value in placement_transform.get("translation_m", [])]
    extents = _placement_proxy_extent_xyz(
        {
            "placement_transform_m": placement_transform,
            "required_sorted_extent_m": placement_transform.get(
                "required_sorted_extent_m",
                [],
            ),
        }
    )
    if len(center) != 3 or extents is None:
        return None
    half = [value / 2.0 for value in extents]
    return (
        [center[index] - half[index] for index in range(3)],
        [center[index] + half[index] for index in range(3)],
    )


def _bbox_containment_margin_m(
    *,
    outer_bounds: tuple[list[float], list[float]] | None,
    inner_bounds: tuple[list[float], list[float]] | None,
) -> float | None:
    if outer_bounds is None or inner_bounds is None:
        return None
    outer_min, outer_max = outer_bounds
    inner_min, inner_max = inner_bounds
    margins = [
        inner_min[index] - outer_min[index]
        for index in range(3)
    ] + [
        outer_max[index] - inner_max[index]
        for index in range(3)
    ]
    return min(margins)


def _collision_precheck_candidate(
    *,
    generated: dict[str, Any],
    placement_transform: dict[str, Any],
    fit_report: dict[str, Any],
) -> dict[str, Any]:
    containment_margin = _bbox_containment_margin_m(
        outer_bounds=_generated_bbox_bounds(generated),
        inner_bounds=_pocket_bounds_from_transform(placement_transform=placement_transform),
    )
    minimum_slack = placement_transform.get("minimum_sorted_extent_slack_m")
    sorted_clearance_margin = (
        float(minimum_slack) / 2.0 if minimum_slack is not None else None
    )
    candidate = bool(
        fit_report.get("passes_after_adjustment")
        and minimum_slack is not None
        and float(minimum_slack) >= 0.0
    )
    return {
        "source": "generated_bbox_proxy_containment_screen",
        "candidate": candidate,
        "accepted": False,
        "minimum_sorted_extent_slack_m": minimum_slack,
        "adjusted_sorted_extent_clearance_margin_m": sorted_clearance_margin,
        "proxy_bbox_containment_margin_m": containment_margin,
        "blocking_reason": (
            "adjusted bbox slack proves only an axis-aligned candidate pocket volume; "
            "raw proxy containment may exceed the pre-growth source bbox, and final "
            "collision validation needs exact subtracted pocket geometry in the "
            "assembled MuJoCo/STEP model"
        ),
    }


def _structural_screen_by_link(report: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        str(record.get("link", "")).upper(): record
        for record in report.get("structural_remediation_preview_screen", [])
        if record.get("link")
    }


def _structural_precheck_candidate(
    *,
    link: str,
    structural_screens_by_link: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    screen = structural_screens_by_link.get(link.upper())
    if screen is None:
        return {
            "source": "no_structural_remediation_required_by_current_screen",
            "candidate": True,
            "accepted": False,
            "minimum_safety_factor": None,
            "max_deflection_m": None,
            "blocking_reason": (
                "link is not in the current structural remediation set, but final "
                "validation still needs exact pocket subtraction edge-distance, "
                "load-path, buckling, and deflection analysis"
            ),
        }
    return {
        "source": "structural_remediation_preview_screen",
        "candidate": bool(screen.get("accepted")),
        "accepted": False,
        "minimum_safety_factor": screen.get("minimum_safety_factor"),
        "max_deflection_m": screen.get("max_deflection_m"),
        "blocking_reason": (
            "structural remediation preview passes the analytic screen, but final "
            "validation still needs exact pocket subtraction edge-distance, load-path, "
            "buckling, and deflection analysis"
        ),
    }


def _plan_record(
    *,
    link: str,
    generated: dict[str, Any],
    supplier_code: str,
    supplier_target: dict[str, Any],
    fit_report: dict[str, Any],
    structural_screens_by_link: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    candidate = generated.get("supplier_vendor_adjusted_candidate") or {}
    placement_transform = _candidate_placement_transform(
        generated=generated,
        candidate=candidate,
        fit_report=fit_report,
    )
    supplier_family = _supplier_code_family(supplier_code)
    mate_feature_ids = _candidate_mate_feature_ids(
        link=link,
        supplier_code=supplier_code,
        placement_transform=placement_transform,
    )
    fastener_access = _tool_access_candidate(
        supplier_family=supplier_family,
        placement_transform=placement_transform,
    )
    collision_precheck = _collision_precheck_candidate(
        generated=generated,
        placement_transform=placement_transform,
        fit_report=fit_report,
    )
    structural_precheck = _structural_precheck_candidate(
        link=link,
        structural_screens_by_link=structural_screens_by_link,
    )
    return {
        "link": link,
        "supplier_code": supplier_code,
        "supplier_family": supplier_family,
        "source_paths": supplier_target.get("paths", []),
        "source_geometry": _supplier_code_body_summary(supplier_target),
        "generated_step_path": candidate.get("step_path"),
        "generated_step_sha256": candidate.get("step_sha256"),
        "available_sorted_extent_after_margin_m": fit_report.get(
            "available_sorted_extent_after_margin_m"
        ),
        "required_sorted_extent_m": fit_report.get("required_sorted_extent_m"),
        "residual_sorted_extent_growth_m": fit_report.get(
            "residual_sorted_extent_growth_m"
        ),
        "max_residual_extent_growth_m": fit_report.get("max_residual_extent_growth_m"),
        "bbox_fit_after_adjustment": bool(fit_report.get("passes_after_adjustment")),
        "placement_frame": "generated_link_local_bbox_center",
        "placement_transform_m": placement_transform,
        "placement_transform_accepted": False,
        "placement_proxy_verified": False,
        "mate_feature_ids": mate_feature_ids,
        "mate_feature_assignment": {
            "source": "generated_bbox_axis_alignment_candidate",
            "candidate": True,
            "proxy_verified": False,
            "accepted": False,
            "blocking_reason": (
                "candidate mate identifiers are derived from the generated bbox and "
                "supplier axis alignment; exact STEP faces/bores are not assigned"
            ),
        },
        "fastener_access": fastener_access,
        "fastener_access_verified": bool(fastener_access["verified"]),
        "collision_precheck": collision_precheck,
        "collision_precheck_candidate": bool(collision_precheck["candidate"]),
        "collision_validation_at_placed_pocket": False,
        "structural_precheck": structural_precheck,
        "structural_precheck_candidate": bool(structural_precheck["candidate"]),
        "structural_validation_at_placed_pocket": False,
        "accepted": False,
        "blocking_reason": (
            "supplier bbox fits the adjusted generated envelope, but exact vendor "
            "placement transform, mate faces, fastener/tool access, and physics/"
            "structural validation are not assigned"
        ),
    }


def build_fembot_supplier_pocket_plan_proof(
    body_groups: list[dict[str, Any]],
    *,
    component_constraint_report: dict[str, Any] | None = None,
    generated_cad_report: dict[str, Any] | None = None,
    parametric_constraint_report: dict[str, Any] | None = None,
    structural_report: dict[str, Any] | None = None,
    placement_proxy_root: Path = DEFAULT_PLACEMENT_PROXY_OUTPUT_ROOT,
    cad_python: Path | None = None,
    extent_tolerance_m: float = DEFAULT_EXTENT_TOLERANCE_M,
) -> dict[str, Any]:
    component = (
        component_constraint_report
        or _load_json(ASIMOV_PARAM_PROOFS / "fembot-component-constraints.json")
        or build_fembot_component_constraint_coverage_proof(body_groups)
    )
    generated = (
        generated_cad_report
        or _load_json(ASIMOV_PARAM_PROOFS / "fembot-generated-cad-envelope.json")
        or build_fembot_generated_cad_envelope_proof(body_groups)
    )
    persisted_generated = _load_json(
        ASIMOV_PARAM_PROOFS / "fembot-generated-cad-envelope.json"
    )
    supplier_generated = (
        generated
        if _generated_supplier_adjusted_links(generated)
        else (persisted_generated or generated)
    )
    parametric = (
        parametric_constraint_report
        or _load_json(ASIMOV_PARAM_PROOFS / "fembot-parametric-constraints.json")
        or build_fembot_parametric_constraints_proof(
            body_groups,
            generated_cad_report=generated,
        )
    )
    supplier_targets = _supplier_targets_by_code(component)
    generated_links = _generated_by_link(supplier_generated)
    supplier_links = sorted(
        _parametric_supplier_links(parametric)
        or _generated_supplier_adjusted_links(supplier_generated)
    )
    structural = (
        structural_report
        or _load_json(ASIMOV_PARAM_PROOFS / "fembot-structural-sanity.json")
        or {}
    )
    structural_screens_by_link = _structural_screen_by_link(structural)
    pocket_records = []
    missing_links = []
    for link in supplier_links:
        generated_record = generated_links.get(link)
        if not generated_record:
            missing_links.append(link)
            continue
        candidate = generated_record.get("supplier_vendor_adjusted_candidate") or {}
        for supplier_code, fit_report in sorted(_fit_reports_by_supplier(candidate).items()):
            supplier_target = supplier_targets.get(supplier_code)
            if supplier_target is None:
                continue
            pocket_records.append(
                _plan_record(
                    link=link,
                    generated=generated_record,
                    supplier_code=supplier_code,
                    supplier_target=supplier_target,
                    fit_report=fit_report,
                    structural_screens_by_link=structural_screens_by_link,
                )
            )
    proxy_specs = _placement_proxy_specs(
        pocket_records,
        placement_proxy_root=placement_proxy_root,
    )
    proxy_result = _cadquery_export_placement_proxies(
        specs=proxy_specs,
        cad_python=cad_python or _cad_python(),
    )
    _attach_placement_proxy_results(
        pocket_records,
        proxy_result=proxy_result,
        extent_tolerance_m=extent_tolerance_m,
    )
    proxy_failures = len(proxy_result.get("failures", []))
    proxy_reloads = sum(1 for record in pocket_records if record["placement_proxy_reload_ok"])
    proxy_extent_failures = sum(
        1
        for record in pocket_records
        if not record["placement_proxy_extent_within_tolerance"]
    )
    proxy_single_solid = sum(
        1 for record in pocket_records if record["placement_proxy_solid_count"] == 1
    )
    ok = bool(
        component.get("ok")
        and generated.get("ok")
        and parametric.get("ok")
        and supplier_links
        and not missing_links
        and pocket_records
        and all(record["bbox_fit_after_adjustment"] for record in pocket_records)
        and proxy_result.get("ok")
        and proxy_reloads == len(pocket_records)
        and proxy_extent_failures == 0
        and proxy_single_solid == len(pocket_records)
    )
    return {
        "schema": FEMBOT_SUPPLIER_POCKET_PLAN_SCHEMA,
        "ok": ok,
        "accepted": False,
        "source": {
            "component_constraint_schema": component.get("schema"),
            "generated_cad_schema": generated.get("schema"),
            "supplier_generated_cad_schema": supplier_generated.get("schema"),
            "supplier_generated_source": (
                "provided_generated_cad_report"
                if supplier_generated is generated
                else "persisted_generated_cad_report"
            ),
            "parametric_constraint_schema": parametric.get("schema"),
            "placement_proxy_backend": proxy_result.get("backend"),
            "placement_proxy_python": proxy_result.get("python"),
        },
        "summary": {
            "links_requiring_supplier_pockets": len(supplier_links),
            "missing_generated_links": missing_links,
            "supplier_codes": len({record["supplier_code"] for record in pocket_records}),
            "supplier_link_pocket_plans": len(pocket_records),
            "bbox_fit_after_adjustment": sum(
                1 for record in pocket_records if record["bbox_fit_after_adjustment"]
            ),
            "bbox_fit_after_adjustment_failures": sum(
                1 for record in pocket_records if not record["bbox_fit_after_adjustment"]
            ),
            "candidate_placement_transforms": sum(
                1 for record in pocket_records if record["placement_transform_m"] is not None
            ),
            "candidate_placement_proxy_root": str(placement_proxy_root),
            "candidate_placement_proxy_exports": sum(
                1 for record in pocket_records if record["placement_proxy_step_path"]
            ),
            "candidate_placement_proxy_reloads": proxy_reloads,
            "candidate_placement_proxy_failures": proxy_failures,
            "candidate_placement_proxy_extent_tolerance_failures": proxy_extent_failures,
            "candidate_placement_proxy_single_solid_plans": proxy_single_solid,
            "placement_proxy_verified_plans": sum(
                1 for record in pocket_records if record["placement_proxy_verified"]
            ),
            "accepted_placement_transforms": sum(
                1 for record in pocket_records if record["placement_transform_accepted"]
            ),
            "unassigned_placement_transforms": sum(
                1 for record in pocket_records if record["placement_transform_m"] is None
            ),
            "mate_feature_candidate_plans": sum(
                1
                for record in pocket_records
                if record.get("mate_feature_assignment", {}).get("candidate")
            ),
            "mate_feature_proxy_verified_plans": sum(
                1
                for record in pocket_records
                if record.get("mate_feature_assignment", {}).get("proxy_verified")
            ),
            "mate_feature_unassigned_plans": sum(
                1 for record in pocket_records if not record["mate_feature_ids"]
            ),
            "fastener_access_required_plans": sum(
                1 for record in pocket_records if record.get("fastener_access", {}).get("required")
            ),
            "fastener_access_candidate_plans": sum(
                1 for record in pocket_records if record.get("fastener_access", {}).get("candidate")
            ),
            "fastener_access_unverified_plans": sum(
                1
                for record in pocket_records
                if record.get("fastener_access", {}).get("required")
                and not record["fastener_access_verified"]
            ),
            "fastener_access_not_required_plans": sum(
                1
                for record in pocket_records
                if not record.get("fastener_access", {}).get("required")
            ),
            "collision_precheck_candidate_plans": sum(
                1 for record in pocket_records if record["collision_precheck_candidate"]
            ),
            "collision_validation_missing_plans": sum(
                1
                for record in pocket_records
                if not record["collision_validation_at_placed_pocket"]
            ),
            "structural_precheck_candidate_plans": sum(
                1 for record in pocket_records if record["structural_precheck_candidate"]
            ),
            "structural_validation_missing_plans": sum(
                1
                for record in pocket_records
                if not record["structural_validation_at_placed_pocket"]
            ),
            "accepted": False,
            "acceptance_blocker": (
                "supplier pocket plans are bbox-cleared with reloadable placement "
                "proxy STEP artifacts and proxy mate identifiers; exact assembly "
                "placement, STEP face/bores, fastener/tool access, collision "
                "validation, and structural validation remain unaccepted"
            ),
        },
        "pocket_plans": pocket_records,
    }


def dump_fembot_supplier_pocket_plan_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_supplier_pocket_plan_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-supplier-pocket-plan.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_fembot_supplier_pocket_plan_proof_json(report), encoding="utf-8")
    return output
