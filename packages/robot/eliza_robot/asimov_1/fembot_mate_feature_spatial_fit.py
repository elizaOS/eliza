"""Spatial fit checks for ASIMOV fembot mate-feature specs."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.fembot_generated_cad import build_fembot_generated_cad_envelope_proof
from eliza_robot.asimov_1.fembot_mate_feature_specs import (
    build_fembot_mate_feature_specs_proof,
)
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS

FEMBOT_MATE_FEATURE_SPATIAL_FIT_SCHEMA = "asimov-fembot-mate-feature-spatial-fit-v1"
DEFAULT_EDGE_DISTANCE_MARGIN_M = 0.001


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


def _axis_index(axis: list[float]) -> int:
    return max(range(3), key=lambda index: abs(float(axis[index])))


def _transverse_extent(extent: list[float], axis: list[float]) -> list[float]:
    axis_i = _axis_index(axis)
    return [float(value) for index, value in enumerate(extent) if index != axis_i]


def _spatial_record(
    *,
    link: str,
    group: str,
    generated: dict[str, Any],
    joint_spec: dict[str, Any],
) -> dict[str, Any]:
    axis = [float(value) for value in joint_spec["axis_unit_vector"]]
    extent = [float(value) for value in generated["reloaded_bbox_extent_m"]]
    transverse = _transverse_extent(extent, axis)
    available_radius = min(transverse) * 0.5
    bore_radius = float(joint_spec["bore"]["diameter_m"]) * 0.5
    bearing_radius = float(joint_spec["bearing_seat"]["outer_diameter_m"]) * 0.5
    fastener = joint_spec["fastener_pattern"]
    fastener_swept_radius = (
        float(fastener["bolt_circle_diameter_m"]) * 0.5
        + float(fastener["fastener_diameter_m"]) * 0.5
        + float(fastener["minimum_edge_distance_m"])
        + DEFAULT_EDGE_DISTANCE_MARGIN_M
    )
    required_radius = max(bore_radius, bearing_radius, fastener_swept_radius)
    margin = available_radius - required_radius
    if margin >= 0.0:
        action = "fits_current_source_fitted_envelope"
    elif fastener_swept_radius > available_radius and bearing_radius <= available_radius:
        action = "reduce_fastener_pattern_or_use_inserted_off_axis_boss"
    elif bearing_radius > available_radius:
        action = "smaller_bearing_motor_stack_or_local_external_boss_required"
    else:
        action = "local_shell_boss_or_envelope_redesign_required"
    return {
        "link": link,
        "group": group,
        "joint_name": joint_spec["joint_name"],
        "axis_unit_vector": axis,
        "transverse_extent_m": transverse,
        "available_transverse_radius_m": available_radius,
        "bore_radius_m": bore_radius,
        "bearing_outer_radius_m": bearing_radius,
        "fastener_swept_radius_m": fastener_swept_radius,
        "required_transverse_radius_m": required_radius,
        "fit_margin_m": margin,
        "fits_current_envelope": margin >= 0.0,
        "redesign_action": action,
        "accepted": False,
    }


def build_fembot_mate_feature_spatial_fit_proof(
    body_groups: list[dict[str, Any]],
    *,
    generated_cad_report: dict[str, Any] | None = None,
    mate_feature_specs_report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    generated = (
        generated_cad_report
        or _load_json(ASIMOV_PARAM_PROOFS / "fembot-generated-cad-envelope.json")
        or build_fembot_generated_cad_envelope_proof(body_groups)
    )
    mate_specs = (
        mate_feature_specs_report
        or _load_json(ASIMOV_PARAM_PROOFS / "fembot-mate-feature-specs.json")
        or build_fembot_mate_feature_specs_proof(
            body_groups,
            generated_cad_report=generated,
        )
    )
    generated_by_link = _records_by_link(generated, "link_steps")
    records = []
    for spec_record in mate_specs.get("links", []):
        link = str(spec_record.get("link")).upper()
        generated_record = generated_by_link.get(link)
        if not generated_record:
            continue
        for joint_spec in spec_record.get("joint_feature_specs") or []:
            records.append(
                _spatial_record(
                    link=link,
                    group=str(spec_record.get("group")),
                    generated=generated_record,
                    joint_spec=joint_spec,
                )
            )
    fit_records = [record for record in records if record["fits_current_envelope"]]
    redesign_records = [record for record in records if not record["fits_current_envelope"]]
    action_counts: dict[str, int] = {}
    for record in redesign_records:
        action = str(record["redesign_action"])
        action_counts[action] = action_counts.get(action, 0) + 1
    worst = sorted(records, key=lambda record: float(record["fit_margin_m"]))[:8]
    ok = bool(
        generated.get("ok")
        and mate_specs.get("ok")
        and len(records) == int(mate_specs.get("summary", {}).get("joint_feature_spec_records") or 0)
    )
    accepted = False
    return {
        "schema": FEMBOT_MATE_FEATURE_SPATIAL_FIT_SCHEMA,
        "ok": ok,
        "accepted": accepted,
        "source": {
            "generated_cad_schema": generated.get("schema"),
            "mate_feature_specs_schema": mate_specs.get("schema"),
        },
        "summary": {
            "joint_feature_records": len(records),
            "fits_current_envelope_records": len(fit_records),
            "redesign_required_records": len(redesign_records),
            "redesign_required_links": len({record["link"] for record in redesign_records}),
            "worst_fit_margin_m": min((float(record["fit_margin_m"]) for record in records), default=None),
            "action_counts": dict(sorted(action_counts.items())),
            "accepted": accepted,
            "acceptance_blocker": (
                "mate-feature spatial fit has been checked against source-fitted "
                "envelopes, but failing joints need smaller hardware, external "
                "bosses, or local envelope redesign before source-body feature "
                "cuts and post-cut validation can be accepted"
            ),
        },
        "spatial_fit": records,
        "worst_fit_records": worst,
    }


def dump_fembot_mate_feature_spatial_fit_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_mate_feature_spatial_fit_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-mate-feature-spatial-fit.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        dump_fembot_mate_feature_spatial_fit_proof_json(report),
        encoding="utf-8",
    )
    return output
