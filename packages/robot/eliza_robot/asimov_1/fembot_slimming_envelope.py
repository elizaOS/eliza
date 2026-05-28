"""Initial slimming envelope proof for ASIMOV fembot links."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.constants import ASIMOV1_GENERATED_MJCF, ASIMOV1_SOURCE_MESH_DIR
from eliza_robot.asimov_1.fembot_body_matching import _collect_mjcf_spatial_anchors
from eliza_robot.asimov_1.fembot_materials import MANUFACTURING_BASELINES
from eliza_robot.asimov_1.fembot_surface_quality import measure_surface_quality_for_stl
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS


SLIMMING_ENVELOPE_SCHEMA = "asimov-fembot-slimming-envelope-v1"
DEFAULT_ANCHOR_CLEARANCE_M = 0.005
DEFAULT_ENVELOPE_MIN_EXTENT_M = 0.012

AXES = ("x", "y", "z")


def _axis_span(points: list[list[float]], axis: int) -> float:
    if not points:
        return 0.0
    values = [point[axis] for point in points]
    return max(values) - min(values)


def _safe_ratio(numerator: float, denominator: float) -> float | None:
    if denominator <= 0.0:
        return None
    return numerator / denominator


def _link_slimming_record(
    *,
    group_name: str,
    link: str,
    mesh_dir: Path,
    anchors_by_link: dict[str, list[dict[str, Any]]],
    anchor_clearance_m: float,
    envelope_min_extent_m: float,
    manufacturing_constraints: dict[str, Any],
) -> dict[str, Any]:
    stl_path = mesh_dir / f"{link}.STL"
    if not stl_path.is_file():
        return {
            "group": group_name,
            "link": link,
            "source_stl": str(stl_path),
            "ok": False,
            "accepted": False,
            "blocking_reason": "source STL is missing",
        }

    surface = measure_surface_quality_for_stl(stl_path)
    current_extents = [float(value) for value in surface["bbox_extent_m"]]
    anchors = anchors_by_link.get(link, [])
    anchor_points = [[float(value) for value in anchor["pos_m"]] for anchor in anchors]
    axis_records: dict[str, dict[str, Any]] = {}
    candidate_min_extents: list[float] = []
    reduction_candidates: list[float] = []
    process_min_extent = float(manufacturing_constraints["minimum_envelope_extent_m"])

    for axis_index, axis in enumerate(AXES):
        current = current_extents[axis_index]
        anchor_span = _axis_span(anchor_points, axis_index)
        anchor_required = anchor_span + 2.0 * anchor_clearance_m if anchors else 0.0
        manufacturable_required = max(envelope_min_extent_m, process_min_extent)
        preserve_current = axis == "z"
        min_required = current if preserve_current else max(anchor_required, manufacturable_required)
        min_required = min(current, min_required)
        reduction = max(0.0, current - min_required)
        candidate_min_extents.append(min_required)
        reduction_candidates.append(reduction)
        axis_records[axis] = {
            "current_extent_m": current,
            "anchor_span_m": anchor_span,
            "anchor_clearance_m": anchor_clearance_m,
            "anchor_required_extent_m": anchor_required,
            "minimum_envelope_extent_m": envelope_min_extent_m,
            "process_minimum_extent_m": process_min_extent,
            "minimum_manufacturable_extent_m": manufacturable_required,
            "preserve_current_extent": preserve_current,
            "candidate_min_extent_m": min_required,
            "candidate_reduction_m": reduction,
            "candidate_scale": _safe_ratio(min_required, current),
        }

    current_xy_area = current_extents[0] * current_extents[1]
    candidate_xy_area = candidate_min_extents[0] * candidate_min_extents[1]
    return {
        "group": group_name,
        "link": link,
        "source_stl": surface["source_path"],
        "source_sha256": surface["source_sha256"],
        "source_bbox_min_m": surface["bbox_min_m"],
        "source_bbox_max_m": surface["bbox_max_m"],
        "source_bbox_extent_m": current_extents,
        "protected_anchor_count": len(anchors),
        "manufacturing_constraints": manufacturing_constraints,
        "axis_constraints": axis_records,
        "candidate_min_bbox_extent_m": candidate_min_extents,
        "candidate_xy_area_m2": candidate_xy_area,
        "current_xy_area_m2": current_xy_area,
        "candidate_xy_area_reduction_fraction": (
            1.0 - candidate_xy_area / current_xy_area if current_xy_area > 0.0 else None
        ),
        "max_axis_reduction_m": max(reduction_candidates),
        "z_height_preserved": candidate_min_extents[2] == current_extents[2],
        "ok": True,
        "accepted": False,
        "blocking_reason": (
            "initial shrink envelope only; generated fembot geometry must still pass "
            "CAD rebuild, keepout clearance, flatness/smoothness, structural, collision, "
            "and MuJoCo simulation gates"
        ),
    }


def build_fembot_slimming_envelope_proof(
    body_groups: list[dict[str, Any]],
    *,
    mesh_dir: Path = ASIMOV1_SOURCE_MESH_DIR,
    mjcf_path: Path = ASIMOV1_GENERATED_MJCF,
    anchor_clearance_m: float = DEFAULT_ANCHOR_CLEARANCE_M,
    min_manufacturable_extent_m: float = DEFAULT_ENVELOPE_MIN_EXTENT_M,
) -> dict[str, Any]:
    anchors_by_link = _collect_mjcf_spatial_anchors(mjcf_path)
    link_records: list[dict[str, Any]] = []
    group_records: list[dict[str, Any]] = []
    missing_links: list[str] = []

    for group in body_groups:
        group_name = str(group.get("group"))
        group_links = [str(link).upper() for link in group.get("links", [])]
        manufacturing_constraints = _manufacturing_constraints_for_group(group)
        records = [
            _link_slimming_record(
                group_name=group_name,
                link=link,
                mesh_dir=mesh_dir,
                anchors_by_link=anchors_by_link,
                anchor_clearance_m=anchor_clearance_m,
                envelope_min_extent_m=min_manufacturable_extent_m,
                manufacturing_constraints=manufacturing_constraints,
            )
            for link in group_links
        ]
        missing_links.extend(record["link"] for record in records if not record.get("ok"))
        link_records.extend(records)
        current_xy_area = sum(float(record.get("current_xy_area_m2") or 0.0) for record in records)
        candidate_xy_area = sum(float(record.get("candidate_xy_area_m2") or 0.0) for record in records)
        group_records.append(
            {
                "group": group_name,
                "links": group_links,
                "link_count": len(group_links),
                "current_xy_area_m2": current_xy_area,
                "candidate_xy_area_m2": candidate_xy_area,
                "manufacturing_constraints": manufacturing_constraints,
                "candidate_xy_area_reduction_fraction": (
                    1.0 - candidate_xy_area / current_xy_area if current_xy_area > 0.0 else None
                ),
                "accepted": False,
                "link_records": records,
            }
        )

    current_total_xy_area = sum(float(record.get("current_xy_area_m2") or 0.0) for record in link_records)
    candidate_total_xy_area = sum(float(record.get("candidate_xy_area_m2") or 0.0) for record in link_records)
    ok_records = [record for record in link_records if record.get("ok")]
    z_preserved = [record for record in ok_records if record.get("z_height_preserved")]
    ok = bool(len(link_records) == 28 and len(ok_records) == 28 and not missing_links)
    return {
        "schema": SLIMMING_ENVELOPE_SCHEMA,
        "ok": ok,
        "accepted": False,
        "source": {
            "mesh_dir": str(mesh_dir),
            "mjcf": str(mjcf_path),
            "anchor_clearance_m": anchor_clearance_m,
            "minimum_manufacturable_extent_m": min_manufacturable_extent_m,
        },
        "summary": {
            "links": len(link_records),
            "body_groups": len(group_records),
            "missing_links": sorted(set(missing_links)),
            "links_with_protected_anchors": sum(1 for record in ok_records if record["protected_anchor_count"] > 0),
            "links_with_process_constraints": sum(
                1
                for record in ok_records
                if record["manufacturing_constraints"]["minimum_envelope_extent_m"] > 0.0
            ),
            "process_active_limiter_links": sum(
                1
                for record in ok_records
                if any(
                    axis["minimum_manufacturable_extent_m"] == axis["process_minimum_extent_m"]
                    for axis in record["axis_constraints"].values()
                )
            ),
            "z_preserved_links": len(z_preserved),
            "current_total_xy_area_m2": current_total_xy_area,
            "candidate_total_xy_area_m2": candidate_total_xy_area,
            "candidate_total_xy_area_reduction_fraction": (
                1.0 - candidate_total_xy_area / current_total_xy_area
                if current_total_xy_area > 0.0
                else None
            ),
            "accepted": False,
            "acceptance_blocker": (
                "slimming lower bounds are estimated from source envelopes and MJCF anchors, "
                "but no generated fembot CAD has been rebuilt, clearance-checked, structurally "
                "analyzed, or simulated against these bounds yet"
            ),
        },
        "body_groups": group_records,
    }


def _manufacturing_constraints_for_group(group: dict[str, Any]) -> dict[str, Any]:
    classes = sorted(
        {
            str(candidate.get("fabrication_class"))
            for candidate in group.get("step_candidates", [])
            if candidate.get("fabrication_class") not in (None, "ASSEMBLY", "OFF_THE_SHELF")
        }
    )
    process_records = {
        fabrication_class: MANUFACTURING_BASELINES[fabrication_class]
        for fabrication_class in classes
        if fabrication_class in MANUFACTURING_BASELINES
    }
    minimum_wall = max(
        (
            float(record["minimum_wall_thickness_m"])
            for record in process_records.values()
            if record.get("minimum_wall_thickness_m") is not None
        ),
        default=0.0,
    )
    minimum_feature = max(
        (
            float(record["minimum_feature_size_m"])
            for record in process_records.values()
            if record.get("minimum_feature_size_m") is not None
        ),
        default=0.0,
    )
    return {
        "fabrication_classes": classes,
        "process_records": process_records,
        "minimum_wall_thickness_m": minimum_wall,
        "minimum_feature_size_m": minimum_feature,
        "minimum_envelope_extent_m": max(2.0 * minimum_wall, minimum_feature),
        "requires_flatness_check": any(record.get("requires_flatness_check") for record in process_records.values()),
        "requires_smoothness_check": any(record.get("requires_smoothness_check") for record in process_records.values()),
        "requires_tool_access_check": any(record.get("requires_tool_access_check") for record in process_records.values()),
    }


def dump_fembot_slimming_envelope_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_slimming_envelope_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-slimming-envelope.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_fembot_slimming_envelope_proof_json(report), encoding="utf-8")
    return output
