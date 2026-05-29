"""Per-link source decision proof for ASIMOV fembot geometry."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS


SOURCE_DECISION_SCHEMA = "asimov-fembot-source-decision-v1"


def _load_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return value if isinstance(value, dict) else None


def _records_by_link(report: dict[str, Any] | None, key: str) -> dict[str, dict[str, Any]]:
    if not report:
        return {}
    return {
        str(record.get("link", "")).upper(): record
        for record in report.get(key, [])
        if isinstance(record, dict) and record.get("link")
    }


def build_fembot_source_decision_proof(
    *,
    link_source_report: dict[str, Any] | None = None,
    brep_surface_fit_report: dict[str, Any] | None = None,
    proof_root: Path = ASIMOV_PARAM_PROOFS,
) -> dict[str, Any]:
    """Choose controlled lofts unless a STEP/B-rep candidate proves stronger evidence.

    This proof is intentionally not exact STEP/B-rep production acceptance. It records
    why the current controlled-loft source is the selected parametric source for each
    visual link while exact B-rep identity remains unresolved.
    """
    link_source_report = link_source_report or _load_json(
        proof_root / "fembot-link-source-assignments.json"
    )
    brep_surface_fit_report = brep_surface_fit_report or _load_json(
        proof_root / "fembot-brep-surface-fit.json"
    )
    assignments = _records_by_link(link_source_report, "link_assignments")
    brep_fits = _records_by_link(brep_surface_fit_report, "link_fits")

    records: list[dict[str, Any]] = []
    all_links = sorted(set(assignments) | set(brep_fits))
    for link in all_links:
        assignment = assignments.get(link)
        brep = brep_fits.get(link)
        controlled_hausdorff = (
            float(assignment["surface_symmetric_hausdorff_m"])
            if assignment and assignment.get("surface_symmetric_hausdorff_m") is not None
            else None
        )
        controlled_fit_ok = bool(
            assignment
            and assignment.get("accepted")
            and assignment.get("controlled_loft_assigned")
            and controlled_hausdorff is not None
        )
        brep_raw = (
            float(brep["symmetric_hausdorff_m"])
            if brep and brep.get("symmetric_hausdorff_m") is not None
            else None
        )
        brep_bbox_affine = (
            float(brep["bbox_affine_aligned_symmetric_hausdorff_m"])
            if brep and brep.get("bbox_affine_aligned_symmetric_hausdorff_m") is not None
            else None
        )
        brep_tolerance = (
            float(brep["surface_tolerance_m"])
            if brep and brep.get("surface_tolerance_m") is not None
            else None
        )
        brep_candidate_rejected = bool(
            brep
            and brep.get("exported")
            and not brep.get("accepted")
            and brep_raw is not None
            and brep_tolerance is not None
            and brep_raw > brep_tolerance
        )
        brep_shape_mismatch = bool(
            brep
            and brep.get("residual_classification")
            == "shape_mismatch_after_bbox_alignment"
        )
        controlled_beats_brep_after_alignment = bool(
            controlled_hausdorff is not None
            and brep_bbox_affine is not None
            and controlled_hausdorff < brep_bbox_affine
        )
        selected_controlled_loft = bool(
            controlled_fit_ok
            and brep_candidate_rejected
            and brep_shape_mismatch
            and controlled_beats_brep_after_alignment
        )
        missing = []
        if not assignment:
            missing.append("link_source_assignment")
        elif not controlled_fit_ok:
            missing.append("accepted_controlled_loft_source")
        if not brep:
            missing.append("brep_surface_fit")
        elif not brep.get("exported"):
            missing.append("exported_step_candidate")
        elif not brep_candidate_rejected:
            missing.append("rejected_step_candidate")
        if brep and not brep_shape_mismatch:
            missing.append("shape_mismatch_classification")
        if brep and not controlled_beats_brep_after_alignment:
            missing.append("controlled_loft_better_than_aligned_step_candidate")
        records.append(
            {
                "link": link,
                "selected_source_kind": "accepted_controlled_loft_source"
                if selected_controlled_loft
                else "unresolved",
                "selected_controlled_loft": selected_controlled_loft,
                "production_exact_brep_ready": bool(
                    assignment and assignment.get("exact_brep_body_assigned")
                ),
                "controlled_loft": {
                    "accepted": controlled_fit_ok,
                    "proof": assignment.get("controlled_loft_proof") if assignment else None,
                    "validation_source": assignment.get("controlled_loft_validation_source")
                    if assignment
                    else None,
                    "surface_symmetric_hausdorff_m": controlled_hausdorff,
                    "fit_max_error_m": assignment.get("fit_max_error_m")
                    if assignment
                    else None,
                    "fit_rms_error_m": assignment.get("fit_rms_error_m")
                    if assignment
                    else None,
                    "interface_max_delta_m": assignment.get("interface_max_delta_m")
                    if assignment
                    else None,
                },
                "best_step_brep_candidate": {
                    "exported": bool(brep and brep.get("exported")),
                    "accepted": bool(brep and brep.get("accepted")),
                    "source_step": brep.get("source_step") if brep else None,
                    "cad_body_index": brep.get("cad_body_index") if brep else None,
                    "body_matching_rank": brep.get("body_matching_rank") if brep else None,
                    "surface_tolerance_m": brep_tolerance,
                    "symmetric_hausdorff_m": brep_raw,
                    "center_aligned_symmetric_hausdorff_m": brep.get(
                        "center_aligned_symmetric_hausdorff_m"
                    )
                    if brep
                    else None,
                    "bbox_affine_aligned_symmetric_hausdorff_m": brep_bbox_affine,
                    "residual_classification": brep.get("residual_classification")
                    if brep
                    else None,
                    "blocking_reason": brep.get("blocking_reason") if brep else None,
                },
                "controlled_loft_beats_bbox_affine_brep_candidate": (
                    controlled_beats_brep_after_alignment
                ),
                "missing": missing,
                "decision_ready": selected_controlled_loft,
            }
        )

    decision_ready = [record for record in records if record["decision_ready"]]
    exact_ready = [record for record in records if record["production_exact_brep_ready"]]
    rejected_brep = [
        record
        for record in records
        if record["best_step_brep_candidate"]["exported"]
        and not record["best_step_brep_candidate"]["accepted"]
    ]
    controlled_better = [
        record
        for record in records
        if record["controlled_loft_beats_bbox_affine_brep_candidate"]
    ]
    ok = bool(len(records) == 28 and len(decision_ready) == len(records))
    accepted = bool(ok and len(exact_ready) == len(records))
    return {
        "schema": SOURCE_DECISION_SCHEMA,
        "ok": ok,
        "accepted": accepted,
        "source": {
            "proof_root": str(proof_root),
            "link_source_schema": link_source_report.get("schema")
            if link_source_report
            else None,
            "brep_surface_fit_schema": brep_surface_fit_report.get("schema")
            if brep_surface_fit_report
            else None,
        },
        "summary": {
            "links": len(records),
            "decision_ready_links": len(decision_ready),
            "selected_controlled_loft_links": sum(
                1 for record in records if record["selected_controlled_loft"]
            ),
            "exact_brep_ready_links": len(exact_ready),
            "rejected_step_brep_candidate_links": len(rejected_brep),
            "controlled_loft_beats_bbox_affine_brep_candidate_links": len(
                controlled_better
            ),
            "accepted": accepted,
            "acceptance_blocker": None
            if accepted
            else "controlled loft is the selected bounded source, but exact STEP/B-rep identity remains unresolved for at least one link",
        },
        "records": records,
    }


def dump_fembot_source_decision_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_source_decision_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-source-decision.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_fembot_source_decision_proof_json(report), encoding="utf-8")
    return output
