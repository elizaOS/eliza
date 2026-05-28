"""Parametric mate-feature specifications for ASIMOV fembot production CAD."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.fembot_assembly import build_fembot_assembly_proof
from eliza_robot.asimov_1.fembot_generated_cad import build_fembot_generated_cad_envelope_proof
from eliza_robot.asimov_1.fembot_hardware_measurements import (
    build_fembot_hardware_measurement_requirements_proof,
)
from eliza_robot.asimov_1.fembot_mate_features import build_fembot_mate_features_plan_proof
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS

FEMBOT_MATE_FEATURE_SPECS_SCHEMA = "asimov-fembot-mate-feature-specs-v1"


def _load_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _records_by_link(report: dict[str, Any], key: str) -> dict[str, dict[str, Any]]:
    return {
        str(record.get("link")).upper(): record
        for record in report.get(key, [])
        if isinstance(record, dict) and record.get("link")
    }


def _normalize(vector: list[float]) -> list[float]:
    length = math.sqrt(sum(float(value) * float(value) for value in vector))
    if length <= 0.0:
        return [0.0, 0.0, 1.0]
    return [float(value) / length for value in vector]


def _axis_index(axis: list[float]) -> int:
    normalized = _normalize(axis)
    return max(range(3), key=lambda index: abs(normalized[index]))


def _transverse_extents(extent: list[float], axis: list[float]) -> list[float]:
    axis_i = _axis_index(axis)
    return [float(value) for index, value in enumerate(extent) if index != axis_i]


def _round(value: float) -> float:
    return round(float(value), 9)


def _feature_dimensions(*, extent: list[float], axis: list[float], actuated: bool) -> dict[str, float]:
    transverse = _transverse_extents(extent, axis)
    min_cross = max(min(transverse), 0.001)
    max_cross = max(transverse)
    bore = min(max(min_cross * (0.30 if actuated else 0.22), 0.006), 0.055)
    bearing_outer = min(max(bore * 1.75, bore + 0.008), max_cross * 0.78)
    seat_width = min(max(float(extent[_axis_index(axis)]) * 0.18, 0.004), 0.025)
    fastener = min(max(bore * 0.16, 0.0025), 0.008)
    bolt_circle = min(max(bearing_outer * 1.28, bearing_outer + 0.008), max_cross * 0.92)
    return {
        "bore_diameter_m": _round(bore),
        "bearing_outer_diameter_m": _round(max(bearing_outer, bore + 0.003)),
        "bearing_seat_width_m": _round(seat_width),
        "retention_clearance_m": _round(max(0.001, bore * 0.08)),
        "fastener_diameter_m": _round(fastener),
        "fastener_bolt_circle_diameter_m": _round(max(bolt_circle, bearing_outer + fastener)),
        "minimum_edge_distance_m": _round(max(fastener * 2.0, 0.004)),
    }


def _fastener_pattern(axis: list[float], count: int = 4) -> list[dict[str, float]]:
    axis_i = _axis_index(axis)
    transverse_axes = [index for index in range(3) if index != axis_i]
    pattern = []
    for index in range(count):
        angle = math.tau * index / count
        offset = [0.0, 0.0, 0.0]
        offset[transverse_axes[0]] = round(math.cos(angle), 9)
        offset[transverse_axes[1]] = round(math.sin(angle), 9)
        pattern.append(
            {
                "x": offset[0],
                "y": offset[1],
                "z": offset[2],
            }
        )
    return pattern


def _joint_specs_for_link(
    *,
    mate_record: dict[str, Any],
    generated_record: dict[str, Any],
) -> list[dict[str, Any]]:
    extent = [float(value) for value in generated_record.get("reloaded_bbox_extent_m", [])]
    center = [float(value) for value in generated_record.get("requested_center_m", [0.0, 0.0, 0.0])]
    specs = []
    actuated = set(mate_record.get("actuated_joint_names") or [])
    for joint_name, axis in zip(
        mate_record.get("joint_names") or [],
        mate_record.get("joint_axes") or [],
        strict=False,
    ):
        normalized_axis = _normalize([float(value) for value in axis])
        dimensions = _feature_dimensions(
            extent=extent,
            axis=normalized_axis,
            actuated=str(joint_name) in actuated,
        )
        specs.append(
            {
                "joint_name": joint_name,
                "axis_unit_vector": normalized_axis,
                "local_center_m": center,
                "bore": {
                    "type": "cylindrical_cut",
                    "diameter_m": dimensions["bore_diameter_m"],
                    "axis_unit_vector": normalized_axis,
                    "center_m": center,
                },
                "bearing_seat": {
                    "type": "counterbore_or_ring_seat",
                    "outer_diameter_m": dimensions["bearing_outer_diameter_m"],
                    "width_m": dimensions["bearing_seat_width_m"],
                    "axis_unit_vector": normalized_axis,
                    "center_m": center,
                },
                "retention_feature": {
                    "type": "snap_ring_or_retainer_relief",
                    "radial_clearance_m": dimensions["retention_clearance_m"],
                },
                "fastener_pattern": {
                    "type": "four_point_bolt_circle",
                    "fastener_diameter_m": dimensions["fastener_diameter_m"],
                    "bolt_circle_diameter_m": dimensions[
                        "fastener_bolt_circle_diameter_m"
                    ],
                    "minimum_edge_distance_m": dimensions["minimum_edge_distance_m"],
                    "unit_offsets": _fastener_pattern(normalized_axis),
                },
                "measurement_evidence_required": True,
                "post_cut_collision_validation_required": True,
                "post_cut_structural_validation_required": True,
            }
        )
    return specs


def _child_datums_for_link(
    *,
    mate_record: dict[str, Any],
    generated_record: dict[str, Any],
) -> list[dict[str, Any]]:
    extent = [float(value) for value in generated_record.get("reloaded_bbox_extent_m", [])]
    center = [float(value) for value in generated_record.get("requested_center_m", [0.0, 0.0, 0.0])]
    child_links = [str(link).upper() for link in mate_record.get("child_links") or []]
    datums = []
    for index, child_link in enumerate(child_links):
        axis = index % 3
        sign = -1.0 if index % 2 else 1.0
        datum_center = list(center)
        datum_center[axis] += sign * float(extent[axis]) * 0.5
        datums.append(
            {
                "child_link": child_link,
                "datum_plane_center_m": [_round(value) for value in datum_center],
                "datum_normal_axis": ["x", "y", "z"][axis],
                "datum_normal_sign": sign,
                "mate_transform_source": "mjcf_parent_child_body_tree",
                "measurement_evidence_required": True,
            }
        )
    return datums


def build_fembot_mate_feature_specs_proof(
    body_groups: list[dict[str, Any]],
    *,
    generated_cad_report: dict[str, Any] | None = None,
    assembly_report: dict[str, Any] | None = None,
    hardware_measurements_report: dict[str, Any] | None = None,
    mate_features_report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    generated = (
        generated_cad_report
        or _load_json(ASIMOV_PARAM_PROOFS / "fembot-generated-cad-envelope.json")
        or build_fembot_generated_cad_envelope_proof(body_groups)
    )
    assembly = (
        assembly_report
        or _load_json(ASIMOV_PARAM_PROOFS / "fembot-assembly.json")
        or build_fembot_assembly_proof(body_groups, generated_cad_report=generated)
    )
    hardware = (
        hardware_measurements_report
        or _load_json(ASIMOV_PARAM_PROOFS / "fembot-hardware-measurements.json")
        or build_fembot_hardware_measurement_requirements_proof(
            body_groups,
            generated_cad_report=generated,
        )
    )
    mate_features = (
        mate_features_report
        or _load_json(ASIMOV_PARAM_PROOFS / "fembot-mate-features-plan.json")
        or build_fembot_mate_features_plan_proof(
            body_groups,
            assembly_report=assembly,
            hardware_measurements_report=hardware,
        )
    )
    generated_by_link = _records_by_link(generated, "link_steps")
    mate_by_link = _records_by_link(mate_features, "links")
    requested = [
        (str(group.get("group")), str(link).upper())
        for group in body_groups
        for link in group.get("links", [])
    ]
    records = []
    for group, link in requested:
        generated_record = generated_by_link.get(link, {})
        mate_record = mate_by_link.get(link, {})
        joint_specs = (
            _joint_specs_for_link(
                mate_record=mate_record,
                generated_record=generated_record,
            )
            if generated_record and mate_record
            else []
        )
        child_datums = (
            _child_datums_for_link(
                mate_record=mate_record,
                generated_record=generated_record,
            )
            if generated_record and mate_record
            else []
        )
        records.append(
            {
                "link": link,
                "group": group,
                "generated_step_path": generated_record.get("step_path"),
                "shape_family": generated_record.get("shape_family"),
                "joint_feature_specs": joint_specs,
                "child_interface_datums": child_datums,
                "parametric_mate_feature_spec_ready": bool(
                    generated_record
                    and mate_record
                    and (joint_specs or child_datums or mate_record.get("parent_body") is None)
                ),
                "accepted": False,
                "blocking_reason": (
                    "parametric feature math is available, but production acceptance "
                    "requires hardware measurements, CAD face selection, feature-cut "
                    "STEP regeneration, post-cut collision validation, and structural "
                    "validation"
                ),
            }
        )
    joint_spec_records = sum(len(record["joint_feature_specs"]) for record in records)
    child_datum_records = sum(len(record["child_interface_datums"]) for record in records)
    ready_links = [
        record for record in records if record["parametric_mate_feature_spec_ready"]
    ]
    hardware_missing_links = int(
        hardware.get("summary", {}).get("missing_measurement_links")
        or hardware.get("summary", {}).get("hardware_measurement_required_links")
        or len(records)
    )
    ok = bool(
        generated.get("ok")
        and assembly.get("ok")
        and mate_features.get("ok")
        and len(records) == 28
        and len(ready_links) == len(records)
        and joint_spec_records == int(mate_features.get("summary", {}).get("joint_mate_links") or 0)
    )
    accepted = bool(
        ok
        and hardware.get("accepted")
        and mate_features.get("accepted")
        and all(record.get("accepted") for record in records)
    )
    return {
        "schema": FEMBOT_MATE_FEATURE_SPECS_SCHEMA,
        "ok": ok,
        "accepted": accepted,
        "source": {
            "generated_cad_schema": generated.get("schema"),
            "assembly_schema": assembly.get("schema"),
            "hardware_measurements_schema": hardware.get("schema"),
            "mate_features_schema": mate_features.get("schema"),
        },
        "summary": {
            "links": len(records),
            "parametric_mate_feature_spec_ready_links": len(ready_links),
            "joint_feature_spec_records": joint_spec_records,
            "child_interface_datum_records": child_datum_records,
            "hardware_measurement_missing_links": hardware_missing_links,
            "feature_cut_step_links": 0,
            "post_cut_collision_validated_links": 0,
            "post_cut_structural_validated_links": 0,
            "accepted": accepted,
            "acceptance_blocker": None
            if accepted
            else (
                "parametric joint and child-interface mate feature specs are "
                "derived, but exact measured hardware dimensions, selected CAD "
                "faces, regenerated feature-cut STEP bodies, and post-cut "
                "collision/structural validation are still required"
            ),
        },
        "links": records,
    }


def dump_fembot_mate_feature_specs_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_mate_feature_specs_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-mate-feature-specs.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_fembot_mate_feature_specs_proof_json(report), encoding="utf-8")
    return output
