"""Projected keepout clearance for initial ASIMOV fembot slimming envelopes."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.constants import ASIMOV1_GENERATED_MJCF, ASIMOV1_SOURCE_MESH_DIR
from eliza_robot.asimov_1.fembot_keepouts import build_fembot_keepout_proof
from eliza_robot.asimov_1.fembot_slimming_envelope import build_fembot_slimming_envelope_proof
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS

CLEARANCE_PROJECTION_SCHEMA = "asimov-fembot-clearance-projection-v1"
DEFAULT_KEEPOUT_MARGIN_M = 0.002
DEFAULT_JOINT_AXIS_RADIUS_M = 0.004
DEFAULT_ACTUATOR_RADIUS_M = 0.018
DEFAULT_SITE_RADIUS_M = 0.002
DEFAULT_COLLISION_RADIUS_M = 0.004


def _bbox_center(minimum: list[float], maximum: list[float]) -> list[float]:
    return [(a + b) * 0.5 for a, b in zip(minimum, maximum, strict=True)]


def _candidate_bbox(record: dict[str, Any]) -> tuple[list[float], list[float]]:
    center = _bbox_center(record["source_bbox_min_m"], record["source_bbox_max_m"])
    extents = [float(value) for value in record["candidate_min_bbox_extent_m"]]
    half = [value * 0.5 for value in extents]
    return (
        [center[index] - half[index] for index in range(3)],
        [center[index] + half[index] for index in range(3)],
    )


def _bbox_from_center_extents(center: list[float], extents: list[float]) -> tuple[list[float], list[float]]:
    half = [value * 0.5 for value in extents]
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


def _axis_clearance(point: list[float], minimum: list[float], maximum: list[float], axis: int) -> float:
    if point[axis] < minimum[axis]:
        return point[axis] - minimum[axis]
    if point[axis] > maximum[axis]:
        return maximum[axis] - point[axis]
    return min(point[axis] - minimum[axis], maximum[axis] - point[axis])


def _point_record(
    *,
    component_type: str,
    name: str | None,
    point: list[float],
    radius_m: float,
    candidate_min: list[float],
    candidate_max: list[float],
    margin_m: float,
) -> dict[str, Any]:
    outside = _outside_distance(point, candidate_min, candidate_max)
    clearance = margin_m - outside
    return {
        "component_type": component_type,
        "name": name,
        "point_m": point,
        "component_radius_m": radius_m,
        "outside_distance_m": outside,
        "minimum_margin_m": margin_m,
        "projected_clearance_m": clearance,
        "violates_candidate_envelope": clearance < 0.0,
    }


def _adjusted_extents_for_points(
    *,
    source_min: list[float],
    source_max: list[float],
    candidate_extents: list[float],
    keepout_points: list[dict[str, Any]],
    margin_m: float,
) -> tuple[list[float], list[float], list[float], bool]:
    center = _bbox_center(source_min, source_max)
    source_extents = [source_max[index] - source_min[index] for index in range(3)]
    adjusted = list(candidate_extents)
    for axis in (0, 1):
        required_half = adjusted[axis] * 0.5
        for point in keepout_points:
            required_half = max(required_half, abs(float(point["point_m"][axis]) - center[axis]) + margin_m)
        adjusted[axis] = min(source_extents[axis], required_half * 2.0)
    adjusted[2] = source_extents[2]
    minimum, maximum = _bbox_from_center_extents(center, adjusted)
    clipped = any(adjusted[index] >= source_extents[index] for index in (0, 1))
    return adjusted, minimum, maximum, clipped


def _collision_points(keepout: dict[str, Any]) -> list[tuple[str, list[float]]]:
    points: list[tuple[str, list[float]]] = []
    fromto = keepout.get("fromto") or []
    if len(fromto) == 6:
        points.append(("start", [float(value) for value in fromto[:3]]))
        points.append(("end", [float(value) for value in fromto[3:]]))
    pos = keepout.get("pos") or []
    if len(pos) == 3:
        points.append(("pos", [float(value) for value in pos]))
    return points


def _first_size_radius(record: dict[str, Any], default: float) -> float:
    sizes = record.get("size") or []
    if not sizes:
        return default
    return max(float(sizes[0]), default)


def _link_keepout_points(link_keepout: dict[str, Any]) -> list[dict[str, Any]]:
    points: list[dict[str, Any]] = []
    for joint in link_keepout.get("joint_keepouts", []):
        points.append(
            {
                "component_type": "joint_axis",
                "name": joint.get("name"),
                "point_m": [0.0, 0.0, 0.0],
                "component_radius_m": DEFAULT_JOINT_AXIS_RADIUS_M,
            }
        )
    for actuator in link_keepout.get("actuator_keepouts", []):
        points.append(
            {
                "component_type": "motor_actuator",
                "name": actuator.get("joint"),
                "point_m": [0.0, 0.0, 0.0],
                "component_radius_m": DEFAULT_ACTUATOR_RADIUS_M,
            }
        )
    for site in link_keepout.get("site_keepouts", []):
        pos = site.get("pos") or []
        if len(pos) == 3:
            points.append(
                {
                    "component_type": "site",
                    "name": site.get("name"),
                    "point_m": [float(value) for value in pos],
                    "component_radius_m": _first_size_radius(site, DEFAULT_SITE_RADIUS_M),
                }
            )
    for collision in link_keepout.get("collision_keepouts", []):
        radius = _first_size_radius(collision, DEFAULT_COLLISION_RADIUS_M)
        for suffix, point in _collision_points(collision):
            points.append(
                {
                    "component_type": "collision_keepout",
                    "name": f"{collision.get('name')}:{suffix}",
                    "point_m": point,
                    "component_radius_m": radius,
                }
            )
    return points


def build_fembot_clearance_projection_proof(
    body_groups: list[dict[str, Any]],
    *,
    mesh_dir: Path = ASIMOV1_SOURCE_MESH_DIR,
    mjcf_path: Path = ASIMOV1_GENERATED_MJCF,
    keepout_margin_m: float = DEFAULT_KEEPOUT_MARGIN_M,
) -> dict[str, Any]:
    slimming = build_fembot_slimming_envelope_proof(
        body_groups,
        mesh_dir=mesh_dir,
        mjcf_path=mjcf_path,
    )
    keepouts = build_fembot_keepout_proof(
        body_groups,
        mjcf_path=mjcf_path,
        mesh_dir=mesh_dir,
    )
    slimming_by_link = {
        record["link"]: record
        for group in slimming.get("body_groups", [])
        for record in group.get("link_records", [])
    }
    keepouts_by_link = {
        record["link"]: record
        for group in keepouts.get("body_groups", [])
        for record in group.get("link_keepouts", [])
    }

    link_records: list[dict[str, Any]] = []
    missing_links: list[str] = []
    for group in body_groups:
        group_name = str(group.get("group"))
        for link in [str(link).upper() for link in group.get("links", [])]:
            slim = slimming_by_link.get(link)
            keepout = keepouts_by_link.get(link)
            if not slim or not keepout:
                missing_links.append(link)
                continue
            candidate_min, candidate_max = _candidate_bbox(slim)
            keepout_points = _link_keepout_points(keepout)
            point_reports = [
                _point_record(
                    component_type=point["component_type"],
                    name=point.get("name"),
                    point=[float(value) for value in point["point_m"]],
                    radius_m=float(point["component_radius_m"]),
                    candidate_min=candidate_min,
                    candidate_max=candidate_max,
                    margin_m=keepout_margin_m,
                )
                for point in keepout_points
            ]
            violations = [point for point in point_reports if point["violates_candidate_envelope"]]
            adjusted_extents, adjusted_min, adjusted_max, adjusted_clipped = _adjusted_extents_for_points(
                source_min=[float(value) for value in slim["source_bbox_min_m"]],
                source_max=[float(value) for value in slim["source_bbox_max_m"]],
                candidate_extents=[float(value) for value in slim["candidate_min_bbox_extent_m"]],
                keepout_points=keepout_points,
                margin_m=keepout_margin_m,
            )
            adjusted_point_reports = [
                _point_record(
                    component_type=point["component_type"],
                    name=point.get("name"),
                    point=[float(value) for value in point["point_m"]],
                    radius_m=float(point["component_radius_m"]),
                    candidate_min=adjusted_min,
                    candidate_max=adjusted_max,
                    margin_m=keepout_margin_m,
                )
                for point in keepout_points
            ]
            adjusted_violations = [
                point for point in adjusted_point_reports if point["violates_candidate_envelope"]
            ]
            min_clearance = min(
                (float(point["projected_clearance_m"]) for point in point_reports),
                default=None,
            )
            adjusted_min_clearance = min(
                (float(point["projected_clearance_m"]) for point in adjusted_point_reports),
                default=None,
            )
            source_extents = [
                float(slim["source_bbox_max_m"][index]) - float(slim["source_bbox_min_m"][index])
                for index in range(3)
            ]
            current_xy_area = source_extents[0] * source_extents[1]
            adjusted_xy_area = adjusted_extents[0] * adjusted_extents[1]
            link_records.append(
                {
                    "group": group_name,
                    "link": link,
                    "candidate_bbox_min_m": candidate_min,
                    "candidate_bbox_max_m": candidate_max,
                    "candidate_bbox_extent_m": slim["candidate_min_bbox_extent_m"],
                    "adjusted_bbox_min_m": adjusted_min,
                    "adjusted_bbox_max_m": adjusted_max,
                    "adjusted_bbox_extent_m": adjusted_extents,
                    "adjusted_bbox_clipped_to_source": adjusted_clipped,
                    "adjusted_xy_area_m2": adjusted_xy_area,
                    "adjusted_xy_area_reduction_fraction": (
                        1.0 - adjusted_xy_area / current_xy_area if current_xy_area > 0.0 else None
                    ),
                    "keepout_point_count": len(point_reports),
                    "violation_count": len(violations),
                    "adjusted_violation_count": len(adjusted_violations),
                    "minimum_projected_clearance_m": min_clearance,
                    "adjusted_minimum_projected_clearance_m": adjusted_min_clearance,
                    "projected_points": point_reports,
                    "adjusted_projected_points": adjusted_point_reports,
                    "accepted": False,
                    "blocking_reason": (
                        "projected point clearance is not a generated-CAD clearance proof; "
                        "full volume clearances against motors, bearings, gears, pulleys, "
                        "vendor envelopes, wiring, and collision geometry are still required"
                    ),
                }
            )

    group_records = []
    for group in body_groups:
        group_name = str(group.get("group"))
        records = [record for record in link_records if record["group"] == group_name]
        min_clearance = min(
            (
                float(record["minimum_projected_clearance_m"])
                for record in records
                if record["minimum_projected_clearance_m"] is not None
            ),
            default=None,
        )
        group_records.append(
            {
                "group": group_name,
                "links": [str(link).upper() for link in group.get("links", [])],
                "link_count": len(records),
                "keepout_point_count": sum(record["keepout_point_count"] for record in records),
                "violation_count": sum(record["violation_count"] for record in records),
                "adjusted_violation_count": sum(record["adjusted_violation_count"] for record in records),
                "minimum_projected_clearance_m": min_clearance,
                "adjusted_minimum_projected_clearance_m": min(
                    (
                        float(record["adjusted_minimum_projected_clearance_m"])
                        for record in records
                        if record["adjusted_minimum_projected_clearance_m"] is not None
                    ),
                    default=None,
                ),
                "adjusted_xy_area_m2": sum(float(record["adjusted_xy_area_m2"]) for record in records),
                "accepted": False,
            }
        )

    violation_links = [record for record in link_records if record["violation_count"] > 0]
    adjusted_violation_links = [
        record for record in link_records if record["adjusted_violation_count"] > 0
    ]
    minimum_clearance = min(
        (
            float(record["minimum_projected_clearance_m"])
            for record in link_records
            if record["minimum_projected_clearance_m"] is not None
        ),
        default=None,
    )
    adjusted_minimum_clearance = min(
        (
            float(record["adjusted_minimum_projected_clearance_m"])
            for record in link_records
            if record["adjusted_minimum_projected_clearance_m"] is not None
        ),
        default=None,
    )
    current_total_xy_area = sum(
        (
            float(record["candidate_bbox_extent_m"][0]) * float(record["candidate_bbox_extent_m"][1])
            for record in link_records
        ),
        0.0,
    )
    adjusted_total_xy_area = sum(float(record["adjusted_xy_area_m2"]) for record in link_records)
    ok = bool(slimming.get("ok") and keepouts.get("ok") and len(link_records) == 28 and not missing_links)
    return {
        "schema": CLEARANCE_PROJECTION_SCHEMA,
        "ok": ok,
        "accepted": False,
        "source": {
            "mesh_dir": str(mesh_dir),
            "mjcf": str(mjcf_path),
            "slimming_schema": slimming.get("schema"),
            "keepout_schema": keepouts.get("schema"),
            "keepout_margin_m": keepout_margin_m,
        },
        "summary": {
            "links": len(link_records),
            "body_groups": len(group_records),
            "missing_links": sorted(set(missing_links)),
            "keepout_points": sum(record["keepout_point_count"] for record in link_records),
            "violation_links": len(violation_links),
            "violations": sum(record["violation_count"] for record in link_records),
            "minimum_projected_clearance_m": minimum_clearance,
            "adjusted_violation_links": len(adjusted_violation_links),
            "adjusted_violations": sum(record["adjusted_violation_count"] for record in link_records),
            "adjusted_minimum_projected_clearance_m": adjusted_minimum_clearance,
            "candidate_total_xy_area_m2": current_total_xy_area,
            "adjusted_total_xy_area_m2": adjusted_total_xy_area,
            "adjusted_area_increase_fraction": (
                adjusted_total_xy_area / current_total_xy_area - 1.0
                if current_total_xy_area > 0.0
                else None
            ),
            "accepted": False,
            "acceptance_blocker": (
                "candidate slimming envelopes have only point-projected keepout checks; "
                "generated CAD must still pass full volume clearance, structural, collision, "
                "and MuJoCo gates"
            ),
        },
        "body_groups": group_records,
        "link_clearance": link_records,
    }


def dump_fembot_clearance_projection_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_clearance_projection_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-clearance-projection.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_fembot_clearance_projection_proof_json(report), encoding="utf-8")
    return output
