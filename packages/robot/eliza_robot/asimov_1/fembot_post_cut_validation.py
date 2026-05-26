"""Post-cut validation screens for ASIMOV fembot mate-feature STEP previews."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.fembot_generated_cad import (
    build_fembot_generated_cad_envelope_proof,
)
from eliza_robot.asimov_1.fembot_mate_feature_cut_preview import (
    build_fembot_mate_feature_cut_preview_proof,
)
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS

FEMBOT_POST_CUT_VALIDATION_SCHEMA = "asimov-fembot-post-cut-validation-v1"
DEFAULT_ENVELOPE_TOLERANCE_M = 1e-6
DEFAULT_STRUCTURAL_VOLUME_LOSS_WARNING_FRACTION = 0.20


def _load_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _generated_by_link(generated_cad_report: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        str(record.get("link")).upper(): record
        for record in generated_cad_report.get("link_steps", [])
        if record.get("link")
    }


def _extent_delta_m(
    cut_extent: list[float],
    source_extent: list[float],
) -> float:
    if len(cut_extent) != 3 or len(source_extent) != 3:
        return float("inf")
    return max(
        float(cut) - float(source)
        for cut, source in zip(cut_extent, source_extent, strict=True)
    )


def _validation_record(
    record: dict[str, Any],
    *,
    generated_by_link: dict[str, dict[str, Any]],
    envelope_tolerance_m: float,
    structural_volume_loss_warning_fraction: float,
) -> dict[str, Any]:
    link = str(record.get("link")).upper()
    source = generated_by_link.get(link, {})
    cut_extent = [float(value) for value in record.get("cut_reloaded_bbox_extent_m") or []]
    source_extent = [
        float(value) for value in source.get("reloaded_bbox_extent_m") or []
    ]
    max_extent_growth_m = _extent_delta_m(cut_extent, source_extent)
    removed_fraction = float(record.get("removed_to_source_volume_fraction") or 0.0)
    solid_count = int(record.get("cut_solid_count") or 0)
    geometry_validated = bool(
        record.get("cut_export_ok")
        and record.get("cut_reload_ok")
        and float(record.get("cut_volume_m3") or 0.0) > 0.0
        and float(record.get("removed_volume_m3") or 0.0) > 0.0
        and max_extent_growth_m <= envelope_tolerance_m
    )
    topology_validated = bool(geometry_validated and solid_count >= 1)
    manufacturing_screen_pass = bool(
        geometry_validated
        and not record.get("source_cut_fallback_strategy")
        and int(record.get("source_cut_feature_count") or 0)
        == int(record.get("cut_feature_count") or -1)
    )
    structural_screen_pass = bool(
        geometry_validated
        and removed_fraction <= structural_volume_loss_warning_fraction
        and solid_count == 1
    )
    return {
        "link": link,
        "group": record.get("group"),
        "cut_step_path": record.get("cut_step_path"),
        "cut_step_sha256": record.get("cut_step_sha256"),
        "source_step_path": record.get("source_step_path"),
        "cut_feature_count": int(record.get("cut_feature_count") or 0),
        "source_cut_feature_count": int(record.get("source_cut_feature_count") or 0),
        "source_cut_fallback_strategy": record.get("source_cut_fallback_strategy"),
        "source_cut_boolean_recovery_strategy": record.get(
            "source_cut_boolean_recovery_strategy"
        ),
        "cut_solid_count": solid_count,
        "source_volume_m3": float(record.get("source_volume_m3") or 0.0),
        "cut_volume_m3": float(record.get("cut_volume_m3") or 0.0),
        "removed_volume_m3": float(record.get("removed_volume_m3") or 0.0),
        "removed_to_source_volume_fraction": removed_fraction,
        "source_bbox_extent_m": source_extent,
        "cut_bbox_extent_m": cut_extent,
        "max_extent_growth_m": max_extent_growth_m,
        "geometry_validated": geometry_validated,
        "topology_validated": topology_validated,
        "manufacturing_screen_pass": manufacturing_screen_pass,
        "structural_screen_pass": structural_screen_pass,
        "structural_volume_loss_warning": bool(
            removed_fraction > structural_volume_loss_warning_fraction
        ),
        "fragmented_cut_body": bool(solid_count != 1),
        "blocking_reasons": [
            reason
            for reason, active in (
                ("cut body failed export/reload/positive-volume/envelope screen", not geometry_validated),
                ("cut body is fragmented into multiple solids", solid_count != 1),
                (
                    "cut removes more source volume than the preliminary structural warning limit",
                    removed_fraction > structural_volume_loss_warning_fraction,
                ),
                (
                    "source cut omitted one or more requested mate features",
                    bool(record.get("source_cut_fallback_strategy")),
                ),
            )
            if active
        ],
        "accepted": False,
    }


def build_fembot_post_cut_validation_proof(
    body_groups: list[dict[str, Any]],
    *,
    generated_cad_report: dict[str, Any] | None = None,
    mate_feature_cut_preview_report: dict[str, Any] | None = None,
    envelope_tolerance_m: float = DEFAULT_ENVELOPE_TOLERANCE_M,
    structural_volume_loss_warning_fraction: float = (
        DEFAULT_STRUCTURAL_VOLUME_LOSS_WARNING_FRACTION
    ),
) -> dict[str, Any]:
    generated = (
        generated_cad_report
        or _load_json(ASIMOV_PARAM_PROOFS / "fembot-generated-cad-envelope.json")
        or build_fembot_generated_cad_envelope_proof(body_groups)
    )
    cut_preview = (
        mate_feature_cut_preview_report
        or _load_json(ASIMOV_PARAM_PROOFS / "fembot-mate-feature-cut-preview.json")
        or build_fembot_mate_feature_cut_preview_proof(body_groups)
    )
    generated_by_link = _generated_by_link(generated)
    records = [
        _validation_record(
            record,
            generated_by_link=generated_by_link,
            envelope_tolerance_m=envelope_tolerance_m,
            structural_volume_loss_warning_fraction=structural_volume_loss_warning_fraction,
        )
        for record in cut_preview.get("feature_cut_tool_steps", [])
    ]
    geometry_validated_links = [
        record["link"] for record in records if record["geometry_validated"]
    ]
    topology_validated_links = [
        record["link"] for record in records if record["topology_validated"]
    ]
    manufacturing_pass_links = [
        record["link"] for record in records if record["manufacturing_screen_pass"]
    ]
    structural_pass_links = [
        record["link"] for record in records if record["structural_screen_pass"]
    ]
    fragmented_links = [
        record["link"] for record in records if record["fragmented_cut_body"]
    ]
    high_volume_loss_links = [
        record["link"] for record in records if record["structural_volume_loss_warning"]
    ]
    fallback_links = [
        record["link"] for record in records if record["source_cut_fallback_strategy"]
    ]
    ok = bool(
        cut_preview.get("ok")
        and len(records)
        == int(cut_preview.get("summary", {}).get("feature_cut_step_links") or 0)
        and len(geometry_validated_links) == len(records)
        and len(topology_validated_links) == len(records)
        and not fallback_links
    )
    accepted = False
    return {
        "schema": FEMBOT_POST_CUT_VALIDATION_SCHEMA,
        "ok": ok,
        "accepted": accepted,
        "source": {
            "generated_cad_schema": generated.get("schema"),
            "mate_feature_cut_preview_schema": cut_preview.get("schema"),
            "envelope_tolerance_m": envelope_tolerance_m,
            "structural_volume_loss_warning_fraction": (
                structural_volume_loss_warning_fraction
            ),
        },
        "summary": {
            "links": len(records),
            "post_cut_geometry_validated_links": len(geometry_validated_links),
            "post_cut_topology_validated_links": len(topology_validated_links),
            "post_cut_manufacturing_screen_pass_links": len(manufacturing_pass_links),
            "post_cut_structural_screen_pass_links": len(structural_pass_links),
            "post_cut_fragmented_links": len(fragmented_links),
            "post_cut_fragmented_link_names": fragmented_links,
            "post_cut_high_volume_loss_links": len(high_volume_loss_links),
            "post_cut_high_volume_loss_link_names": high_volume_loss_links,
            "post_cut_source_cut_fallback_links": len(fallback_links),
            "post_cut_source_cut_fallback_link_names": fallback_links,
            "post_cut_boolean_recovery_links": sum(
                1 for record in records if record["source_cut_boolean_recovery_strategy"]
            ),
            "accepted": accepted,
            "acceptance_blocker": (
                "post-cut STEP previews reload and have geometry/topology screens, "
                "but production acceptance still requires collision simulation, "
                "hardware-fit measurements, tool-access review, and structural "
                "remediation for fragmented or high-volume-loss cut bodies"
            ),
        },
        "post_cut_validations": records,
    }


def dump_fembot_post_cut_validation_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_post_cut_validation_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-post-cut-validation.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        dump_fembot_post_cut_validation_proof_json(report),
        encoding="utf-8",
    )
    return output
