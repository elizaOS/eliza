"""Wrist fastener-pattern redesign for ASIMOV fembot mate-feature fit."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.fembot_mate_feature_spatial_fit import (
    DEFAULT_EDGE_DISTANCE_MARGIN_M,
    build_fembot_mate_feature_spatial_fit_proof,
)
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS

FEMBOT_WRIST_FASTENER_REDESIGN_SCHEMA = "asimov-fembot-wrist-fastener-redesign-v1"
TARGET_LINKS = ("LEFT_WRIST_YAW", "RIGHT_WRIST_YAW")


def _load_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _candidate_for_record(record: dict[str, Any]) -> dict[str, Any]:
    available = float(record["available_transverse_radius_m"])
    bearing_radius = float(record["bearing_outer_radius_m"])
    fastener_diameter = 0.0025
    fastener_radius = fastener_diameter * 0.5
    minimum_edge_distance = 0.004
    max_bolt_circle = 2.0 * (
        available
        - fastener_radius
        - minimum_edge_distance
        - DEFAULT_EDGE_DISTANCE_MARGIN_M
    )
    min_bolt_circle = 2.0 * bearing_radius + fastener_diameter
    bolt_circle = max(min_bolt_circle, max_bolt_circle - 0.00025)
    revised_swept_radius = (
        bolt_circle * 0.5
        + fastener_radius
        + minimum_edge_distance
        + DEFAULT_EDGE_DISTANCE_MARGIN_M
    )
    margin = available - revised_swept_radius
    return {
        "link": record["link"],
        "group": record["group"],
        "joint_name": record["joint_name"],
        "original_fastener_swept_radius_m": record["fastener_swept_radius_m"],
        "available_transverse_radius_m": available,
        "preserved_bore_radius_m": record["bore_radius_m"],
        "preserved_bearing_outer_radius_m": bearing_radius,
        "original_fit_margin_m": record["fit_margin_m"],
        "revised_fastener_diameter_m": fastener_diameter,
        "revised_bolt_circle_diameter_m": bolt_circle,
        "minimum_edge_distance_m": minimum_edge_distance,
        "revised_fastener_swept_radius_m": revised_swept_radius,
        "revised_fit_margin_m": margin,
        "fits_current_envelope_after_redesign": margin >= 0.0,
        "redesign_strategy": "reduce_wrist_bolt_circle_preserve_bore_and_bearing",
        "manufacturing_note": (
            "use smaller local wrist fastener circle or threaded insert pattern; "
            "preserve bore and bearing seat, then verify tool access and local "
            "boss/rib stress after source-body feature cuts"
        ),
        "accepted": False,
    }


def build_fembot_wrist_fastener_redesign_proof(
    body_groups: list[dict[str, Any]],
    *,
    spatial_fit_report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    spatial_fit = (
        spatial_fit_report
        or _load_json(ASIMOV_PARAM_PROOFS / "fembot-mate-feature-spatial-fit.json")
        or build_fembot_mate_feature_spatial_fit_proof(body_groups)
    )
    failing = [
        record
        for record in spatial_fit.get("spatial_fit", [])
        if str(record.get("link")).upper() in TARGET_LINKS
        and not record.get("fits_current_envelope")
    ]
    candidates = [_candidate_for_record(record) for record in failing]
    ready = [record for record in candidates if record["fits_current_envelope_after_redesign"]]
    ok = bool(
        spatial_fit.get("ok")
        and {record["link"] for record in candidates} == set(TARGET_LINKS)
        and len(ready) == len(candidates) == 2
    )
    accepted = False
    return {
        "schema": FEMBOT_WRIST_FASTENER_REDESIGN_SCHEMA,
        "ok": ok,
        "accepted": accepted,
        "source": {
            "spatial_fit_schema": spatial_fit.get("schema"),
        },
        "summary": {
            "target_links": len(TARGET_LINKS),
            "redesign_candidate_links": len(candidates),
            "redesign_fits_current_envelope_links": len(ready),
            "remaining_spatial_fit_failures_after_redesign": len(candidates) - len(ready),
            "min_revised_fit_margin_m": min(
                (float(record["revised_fit_margin_m"]) for record in candidates),
                default=None,
            ),
            "max_bolt_circle_reduction_m": max(
                (
                    float(record["original_fastener_swept_radius_m"])
                    - float(record["revised_fastener_swept_radius_m"])
                    for record in candidates
                ),
                default=None,
            ),
            "accepted": accepted,
            "acceptance_blocker": (
                "wrist fastener pattern redesign fits the current thin envelope, "
                "but production acceptance still requires updated mate-feature "
                "tooling, exact inserts/fasteners, source-body feature cuts, "
                "tool-access validation, and post-cut structural/collision checks"
            ),
        },
        "redesigns": candidates,
    }


def dump_fembot_wrist_fastener_redesign_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_wrist_fastener_redesign_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-wrist-fastener-redesign.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        dump_fembot_wrist_fastener_redesign_proof_json(report),
        encoding="utf-8",
    )
    return output
