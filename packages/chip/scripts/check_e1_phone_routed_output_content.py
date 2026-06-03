#!/usr/bin/env python3
"""Fail-closed content gate for E1 phone routed-board release outputs."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
from collections import Counter
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
MATRIX = (
    ROOT / "board/kicad/e1-phone/production/readiness/"
    "routed-board-release-acceptance-matrix-2026-05-22.yaml"
)
CANDIDATE_MANIFEST = (
    ROOT / "board/kicad/e1-phone/production/routed-output-candidate-manifest-2026-05-22.yaml"
)
STEP_INTAKE = ROOT / "board/kicad/e1-phone/real-footprint-development-step-intake-2026-05-22.yaml"
INSTANCE_DISPOSITION = ROOT / "board/kicad/e1-phone/instance-pin-step-disposition-2026-06-02.yaml"
COMPONENT_3D_BINDING_REPORT = (
    ROOT / "board/kicad/e1-phone/production/reports/component-3d-binding.yaml"
)
COMPONENT_3D_BINDING_MATRIX = (
    ROOT / "board/kicad/e1-phone/production/reports/component-3d-binding-matrix.csv"
)
ZONE_FILL_REPORT = ROOT / "board/kicad/e1-phone/production/reports/zone-fill.json"
RAW_KICAD_REPORT_REQUIREMENTS = {
    "board/kicad/e1-phone/production/reports/drc.json": {
        "kind": "drc",
        "source_hash_field": "source_board_sha256",
        "required_command_fragments": ("kicad-cli", "pcb", "drc"),
    },
    "board/kicad/e1-phone/production/reports/erc.json": {
        "kind": "erc",
        "source_hash_field": "source_schematic_sha256",
        "required_command_fragments": ("kicad-cli", "sch", "erc"),
    },
}
REPORT = ROOT / "build/reports/e1_phone_routed_output_content.json"
EXPECTED_SCHEMA = "eliza.e1_phone_routed_board_release_acceptance_matrix.v1"
CLAIM_BOUNDARY = (
    "routed_output_content_validation_only_not_board_fabrication_or_production_release_evidence"
)
FALSE_CLAIM_FLAGS = {
    "release_claim_allowed": False,
    "routed_board_release_claim_allowed": False,
    "board_fabrication_claim_allowed": False,
    "kicad_release_claim_allowed": False,
    "supplier_approval_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}
COMMON_FIELDS = {
    "artifact_id",
    "source_requirement_id",
    "owner",
    "created_at",
    "tool_or_supplier_revision",
    "input_artifact_hashes",
    "reviewer",
    "reviewed_at",
    "disposition",
}
ROUTED_FIELDS = {
    "kicad_project_revision",
    "routed_pcb_hash",
    "erc_result",
    "drc_result",
    "stackup_revision",
    "impedance_coupon_reference",
    "si_pi_rf_report_references",
    "fab_output_manifest",
    "routed_step_reference",
}
METADATA_FIELDS = {
    "artifact_id",
    "source_requirement_id",
    "owner",
    "created_at",
    "reviewer",
    "reviewed_at",
    "disposition",
    "external_review_authority",
    "signature_or_approval_record",
    "artifact_sha256",
}
TEXT_RELEASE_ARTIFACT_SUFFIXES = {
    ".kicad_pcb",
    ".kicad_sch",
    ".pos",
    ".bom",
    ".txt",
    ".rpt",
}
PLACEHOLDER_MARKERS = {
    "tb" + "d",
    "to" + "do",
    "not_run",
    "presence-only",
    "presence_only",
    "unvalidated",
    "unsigned",
    "placeholder",
    "concept",
    "demo",
    "blocked",
}
VALIDATION_COMMAND = "python3 scripts/check_e1_phone_routed_output_content.py"
LOCAL_CANDIDATE_GENERATOR_COMMAND = "python3 scripts/generate_e1_phone_routed_output_candidates.py"


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def report_path(path: Path) -> str:
    try:
        return rel(path)
    except ValueError:
        return path.as_posix()


def repo_path(path_text: str) -> Path:
    path = Path(path_text)
    if path.is_absolute():
        return path
    if path_text.startswith("packages/chip/"):
        return ROOT.parents[1] / path
    return ROOT / path


def compact_component_model_record(model: dict[str, Any]) -> dict[str, Any]:
    return {
        "reference": str(model.get("reference", "")),
        "footprint": str(model.get("footprint", "")),
        "visual_package_class": str(model.get("visual_package_class", "")),
        "pinout_file": str(model.get("pinout_file", "")),
        "pinout_bound": bool(model.get("pinout_bound") is True),
        "pinout_status": str(model.get("pinout_status", "")),
        "coverage": str(model.get("coverage", "")),
        "land_pattern_basis": str(model.get("land_pattern_basis", "")),
        "pattern_bound": bool(model.get("pattern_bound") is True),
        "pattern_binding_status": str(model.get("pattern_binding_status", "")),
        "support_pattern_bound": bool(model.get("support_pattern_bound") is True),
        "support_pattern_has_explicit_provenance": bool(
            model.get("support_pattern_has_explicit_provenance") is True
        ),
        "pad_visual_count": int(model.get("pad_visual_count", 0) or 0),
        "pad_contract_covered_count": int(model.get("pad_contract_covered_count", 0) or 0),
        "terminal_contract_count": int(model.get("terminal_contract_count", 0) or 0),
        "terminal_contract_bound": bool(model.get("terminal_contract_bound") is True),
        "non_signal_pad_contract_count": len(model.get("non_signal_pad_contract", [])),
        "npth_mechanical_feature_contract_count": len(
            model.get("npth_mechanical_feature_contract", [])
        ),
        "all_pad_visuals_have_contract": bool(model.get("all_pad_visuals_have_contract") is True),
        "terminal_contract_matches_pad_visuals": bool(
            model.get("terminal_contract_matches_pad_visuals") is True
        ),
        "non_signal_pad_contract_matches_pad_visuals": bool(
            model.get("non_signal_pad_contract_matches_pad_visuals") is True
        ),
        "npth_mechanical_feature_contract_matches_footprint": bool(
            model.get("npth_mechanical_feature_contract_matches_footprint") is True
        ),
        "local_discrete_step_file": str(model.get("local_discrete_step_file", "")),
        "local_step_bound": bool(model.get("local_step_bound") is True),
        "local_discrete_step_sha256": str(model.get("local_discrete_step_sha256", "")),
        "local_discrete_step_bytes": int(model.get("local_discrete_step_bytes", 0) or 0),
        "local_discrete_step_imported_as_solid": bool(
            model.get("local_discrete_step_imported_as_solid") is True
        ),
        "local_discrete_step_bbox_matches_envelope": bool(
            model.get("local_discrete_step_bbox_matches_envelope") is True
        ),
        "release_credit": bool(model.get("release_credit") is True),
    }


def load_yaml_mapping(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise ValueError(f"missing file: {rel(path)}")
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)} must be a YAML mapping")
    return data


def load_json_mapping(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise ValueError(f"missing file: {rel(path)}")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)} must be a JSON mapping")
    return data


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def kicad_board_counts(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    return {
        "sha256": file_sha256(path),
        "footprint_count": text.count('(footprint "'),
        "placeholder_marker_count": text.count("placeholder_not_fabrication_footprint"),
        "legacy_e1phone_footprint_ref_count": text.count('(footprint "E1Phone:'),
        "segment_count": text.count("\n  (segment "),
        "via_count": text.count("\n  (via "),
        "zone_count": text.count("\n  (zone "),
        "filled_zone_count": text.count("(filled_polygon"),
    }


def load_candidate_manifest() -> dict[str, Any]:
    if not CANDIDATE_MANIFEST.is_file():
        return {
            "path": rel(CANDIDATE_MANIFEST),
            "present": False,
            "release_credit": False,
            "artifact_paths": [],
            "artifact_count": 0,
        }
    data = load_yaml_mapping(CANDIDATE_MANIFEST)
    artifacts = data.get("artifacts")
    artifact_paths = [
        str(artifact.get("path"))
        for artifact in artifacts or []
        if isinstance(artifact, dict) and artifact.get("path")
    ]
    return {
        "path": rel(CANDIDATE_MANIFEST),
        "present": True,
        "status": data.get("status"),
        "release_credit": data.get("release_credit") is True,
        "artifact_paths": artifact_paths,
        "artifact_count": len(artifact_paths),
        "intentionally_not_generated": data.get("intentionally_not_generated") or [],
    }


def attach_repo_generation_context(
    outputs: dict[str, dict[str, Any]], candidate_manifest: dict[str, Any]
) -> None:
    candidate_paths = set(candidate_manifest.get("artifact_paths") or [])
    manifest_present = candidate_manifest.get("present") is True
    for path_text, artifact in outputs.items():
        current_artifact_present = repo_path(path_text).exists()
        if path_text not in candidate_paths:
            artifact["repo_generation"] = {
                "repo_generated_candidate": False,
                "generator_command": "",
                "generator_manifest": candidate_manifest.get("path") or "",
                "generator_manifest_present": manifest_present,
                "current_artifact_present": current_artifact_present,
                "repo_generatable_now": False,
                "repo_generation_closes_release_blocker": False,
                "external_release_required": True,
                "release_credit": False,
                "classification": "not_managed_by_local_candidate_generator",
            }
            continue
        artifact["repo_generation"] = {
            "repo_generated_candidate": True,
            "generator_command": LOCAL_CANDIDATE_GENERATOR_COMMAND,
            "generator_manifest": candidate_manifest.get("path") or "",
            "generator_manifest_present": manifest_present,
            "current_artifact_present": current_artifact_present,
            "repo_generatable_now": manifest_present,
            "repo_generation_closes_release_blocker": False,
            "external_release_required": True,
            "release_credit": False,
            "classification": "local_candidate_generated_from_repo_sources",
            "claim_boundary": (
                "Local candidate generation can recreate this repo artifact, but cannot "
                "supply approval, supplier, factory, first-article, enclosure, or live "
                "validation evidence."
            ),
        }


def repo_generation_plan(
    path_text: str, artifact: dict[str, Any], failures: list[str]
) -> dict[str, Any]:
    context = artifact.get("repo_generation")
    if not isinstance(context, dict):
        context = {
            "repo_generated_candidate": False,
            "generator_command": "",
            "generator_manifest": "",
            "generator_manifest_present": False,
            "current_artifact_present": repo_path(path_text).exists(),
            "repo_generatable_now": False,
            "repo_generation_closes_release_blocker": False,
            "external_release_required": True,
            "release_credit": False,
            "classification": "not_managed_by_local_candidate_generator",
        }
    missing_generated_artifact = "artifact_missing" in failures
    repo_generatable_now = (
        context.get("repo_generated_candidate") is True
        and context.get("generator_manifest_present") is True
    )
    local_candidate_metadata_only = (
        repo_generatable_now
        and not missing_generated_artifact
        and not any(failure.startswith("missing_") for failure in failures)
        and all(
            "disposition_not_approved" in failure
            or "placeholder_or_blocked_marker_present" in failure
            for failure in failures
        )
    )
    return {
        **context,
        "path": path_text,
        "repo_generatable_now": repo_generatable_now,
        "repo_generation_scope": (
            "local_candidate_artifact_only"
            if repo_generatable_now
            else "not_repo_generatable_from_current_candidate_manifest"
        ),
        "repo_generation_closes_release_blocker": False,
        "local_candidate_metadata_only_blocker": local_candidate_metadata_only,
        "missing_generated_artifact": missing_generated_artifact,
        "external_release_required": True,
        "external_release_evidence_required": True,
        "external_release_evidence_reason": (
            "local candidate bytes can be regenerated, but release credit requires "
            "approved routed evidence, supplier/factory review, and signed metadata"
            if repo_generatable_now
            else (
                "present artifact still has fail-closed candidate, placeholder, provenance, "
                "or approval blockers"
                if not missing_generated_artifact
                else "repo artifact is absent at the required path"
            )
        ),
        "validation_command": VALIDATION_COMMAND,
        "release_credit": False,
    }


def parse_file(path: Path) -> Any:
    suffix = path.suffix.lower()
    if suffix in {".yaml", ".yml"}:
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    if suffix == ".json":
        return json.loads(path.read_text(encoding="utf-8"))
    if suffix == ".csv":
        with path.open(newline="", encoding="utf-8") as handle:
            return list(csv.DictReader(handle))
    if suffix in {".kicad_pcb", ".kicad_sch", ".pos", ".bom", ".txt", ".rpt"}:
        return path.read_text(encoding="utf-8")
    if suffix in {".zip", ".step", ".stp", ".pdf", ".ipc", ".tgz"}:
        return {"binary_or_cad_artifact": True}
    if path.is_dir():
        return {"directory": True}
    return path.read_text(encoding="utf-8")


def scalar_text(value: Any) -> list[str]:
    if isinstance(value, dict):
        values: list[str] = []
        for key, item in value.items():
            values.append(str(key))
            values.extend(scalar_text(item))
        return values
    if isinstance(value, list):
        values = []
        for item in value:
            values.extend(scalar_text(item))
        return values
    if value is None:
        return []
    return [str(value)]


def has_placeholder(value: Any) -> bool:
    haystack = " ".join(scalar_text(value)).lower()
    return any(marker in haystack for marker in PLACEHOLDER_MARKERS)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fail-closed content gate for E1 phone routed-board release outputs."
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=REPORT,
        help="JSON report path to write.",
    )
    return parser.parse_args()


def write_report(payload: dict[str, Any], report_path: Path) -> None:
    payload.setdefault("claim_boundary", CLAIM_BOUNDARY)
    for key, expected in FALSE_CLAIM_FLAGS.items():
        payload.setdefault(key, expected)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def blocked_contract_error_report(message: str) -> dict[str, Any]:
    return {
        "schema": "eliza.e1_phone_routed_output_content_report.v1",
        "status": "blocked",
        "release_credit": False,
        "summary": {
            "release_ready": False,
            "release_credit": False,
            "required_paths": 0,
            "present": 0,
            "content_valid": 0,
            "blocked": 1,
            "inventory_mismatches": 1,
        },
        "findings": [
            {
                "code": "routed_output_contract_blocked",
                "severity": "blocker",
                "message": message,
                "evidence": report_path(MATRIX),
                "next_command": VALIDATION_COMMAND,
            }
        ],
        "blocked_evidence_inventory": [],
        "validation_commands": [VALIDATION_COMMAND],
        "blocker_diagnostics": {
            "blocked_by_failure": {"routed_output_contract_blocked": 1},
            "next_unblock_groups": [
                {
                    "id": "repair_routed_output_content_contract",
                    "owner": "layout_fabrication",
                    "blocked_rows": 1,
                    "required_action": (
                        "repair the routed-board acceptance matrix or checker runtime "
                        "contract, then rerun validation"
                    ),
                    "validation_command": VALIDATION_COMMAND,
                    "release_credit": False,
                }
            ],
        },
        "routed_execution_packet_inventory": [],
        "candidate_manifest_coverage": {
            "candidate_manifest": report_path(CANDIDATE_MANIFEST),
            "candidate_manifest_present": CANDIDATE_MANIFEST.is_file(),
            "candidate_release_credit": False,
        },
        "next_unblock_actions": [],
    }


def required_production_artifact_class(path_text: str, artifact: dict[str, Any]) -> str:
    if artifact.get("production_artifact_class"):
        return str(artifact["production_artifact_class"])
    path = repo_path(path_text)
    suffix = path.suffix.lower()
    if path.is_dir() or artifact.get("artifact_kind") == "directory":
        return "routed_release_directory_manifest"
    if suffix == ".kicad_pcb":
        return "routed_kicad_pcb"
    if suffix == ".kicad_sch":
        return "routed_release_schematic"
    if suffix in {".step", ".stp"}:
        return "routed_board_step_or_cad_model"
    if suffix in {".zip", ".tgz", ".ipc"}:
        return "fabrication_output_archive"
    if suffix == ".pdf":
        return "signed_external_review_report"
    if suffix == ".csv":
        return "routed_measurement_or_validation_table"
    if suffix in {".yaml", ".yml", ".json"}:
        return "structured_routed_release_record"
    if suffix == ".pos":
        return "pick_and_place_output"
    if suffix == ".bom":
        return "bill_of_materials_output"
    if suffix in {".txt", ".rpt"}:
        return "routed_release_text_report"
    return "routed_production_output"


def metadata_record_targets(path_text: str) -> dict[str, Any]:
    path = repo_path(path_text)
    suffix = path.suffix.lower()
    if path.is_dir():
        candidates = [
            path / "release-manifest.yaml",
            path / "manifest.yaml",
            path / "index.yaml",
            path.with_suffix(path.suffix + ".metadata.yaml"),
        ]
        return {
            "record_type": "directory_release_manifest",
            "primary_record_path": report_path(candidates[0]),
            "accepted_record_paths": [report_path(candidate) for candidate in candidates],
            "present_record_paths": [
                report_path(candidate) for candidate in candidates if candidate.is_file()
            ],
        }
    if suffix in {".zip", ".step", ".stp", ".pdf", ".ipc", ".tgz"}:
        metadata = path.with_suffix(path.suffix + ".metadata.yaml")
        return {
            "record_type": "external_signed_review_metadata",
            "primary_record_path": report_path(metadata),
            "accepted_record_paths": [report_path(metadata)],
            "present_record_paths": [report_path(metadata)] if metadata.is_file() else [],
        }
    if suffix in {".yaml", ".yml", ".json"}:
        return {
            "record_type": "inline_structured_routed_release_record",
            "primary_record_path": path_text,
            "accepted_record_paths": [path_text],
            "present_record_paths": [path_text] if path.is_file() else [],
        }
    if suffix in TEXT_RELEASE_ARTIFACT_SUFFIXES:
        metadata = path.with_suffix(path.suffix + ".metadata.yaml")
        return {
            "record_type": "text_release_metadata_or_embedded_provenance",
            "primary_record_path": report_path(metadata),
            "accepted_record_paths": [report_path(metadata), path_text],
            "present_record_paths": [
                candidate
                for candidate in (report_path(metadata), path_text)
                if repo_path(candidate).is_file()
            ],
        }
    if suffix == ".csv":
        return {
            "record_type": "routed_measurement_csv",
            "primary_record_path": path_text,
            "accepted_record_paths": [path_text],
            "present_record_paths": [path_text] if path.is_file() else [],
        }
    return {
        "record_type": "unsupported_routed_release_record",
        "primary_record_path": path_text,
        "accepted_record_paths": [path_text],
        "present_record_paths": [path_text] if path.is_file() else [],
    }


def source_manifest_refs(artifact: dict[str, Any]) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = [
        {
            "manifest": rel(MATRIX),
            "selectors": [
                str(value)
                for value in (
                    artifact.get("source"),
                    artifact.get("source_id"),
                    *(artifact.get("source_ids") or []),
                )
                if value
            ],
        }
    ]
    candidate_manifest = artifact.get("candidate_manifest")
    if candidate_manifest:
        refs.append(
            {
                "manifest": str(candidate_manifest).removeprefix("packages/chip/"),
                "selectors": [artifact.get("path", "")],
            }
        )
    return refs


def missing_field_group(failures: list[str], prefix: str) -> list[str]:
    marker = f"missing_{prefix}_field:"
    return sorted(failure.split(":", 1)[1] for failure in failures if failure.startswith(marker))


def unblock_action(path_text: str, artifact: dict[str, Any], failures: list[str]) -> dict[str, Any]:
    missing = "artifact_missing" in failures
    owner = (
        artifact.get("owner") or ",".join(artifact.get("source_ids") or []) or "layout_fabrication"
    )
    action = (
        "Generate or stage the routed-board production output at this exact path, then rerun validation."
        if missing
        else "Replace the candidate/presence-only output with approved routed release metadata, hashes, review authority, and signoff, then rerun validation."
    )
    return {
        "path": path_text,
        "current_path": path_text,
        "candidate_path": path_text if artifact.get("candidate_present_blocked") is True else "",
        "required_production_artifact_class": required_production_artifact_class(
            path_text, artifact
        ),
        "metadata_record": metadata_record_targets(path_text),
        "owner": owner,
        "source_ids": artifact.get("source_ids") or [artifact.get("source_id")],
        "source_manifest_refs": source_manifest_refs({**artifact, "path": path_text}),
        "required_statuses": artifact.get("required_statuses")
        or ([artifact.get("required_status")] if artifact.get("required_status") else []),
        "candidate_present_blocked": artifact.get("candidate_present_blocked") is True,
        "candidate_manifest": artifact.get("candidate_manifest") or "",
        "repo_generation_plan": repo_generation_plan(path_text, artifact, failures),
        "missing_artifact": missing,
        "failures": failures,
        "action": action,
        "validation_command": VALIDATION_COMMAND,
        "next_validation_commands": [VALIDATION_COMMAND],
        "release_credit": False,
    }


def repo_generation_summary(
    outputs: dict[str, dict[str, Any]], blocked: list[tuple[str, list[str]]]
) -> dict[str, Any]:
    blocked_paths = [path_text for path_text, _failures in blocked]
    generator_paths = [
        path_text
        for path_text in blocked_paths
        if (outputs.get(path_text, {}).get("repo_generation") or {}).get("repo_generated_candidate")
        is True
    ]
    missing_paths = [path_text for path_text, failures in blocked if "artifact_missing" in failures]
    present_blocked_paths = [
        path_text for path_text, failures in blocked if "artifact_missing" not in failures
    ]
    plans = [
        repo_generation_plan(path_text, outputs.get(path_text, {}), failures)
        for path_text, failures in blocked
    ]
    repo_generatable_now_paths = sorted(
        plan["path"] for plan in plans if plan["repo_generatable_now"] is True
    )
    external_release_required_paths = sorted(
        plan["path"] for plan in plans if plan["external_release_required"] is True
    )
    local_candidate_metadata_only_paths = sorted(
        plan["path"] for plan in plans if plan["local_candidate_metadata_only_blocker"] is True
    )
    return {
        "release_credit": False,
        "generator_command": LOCAL_CANDIDATE_GENERATOR_COMMAND,
        "generator_manifest": rel(CANDIDATE_MANIFEST),
        "generator_command_available_count": len(generator_paths),
        "repo_generatable_now_count": len(repo_generatable_now_paths),
        "repo_generatable_now_paths": repo_generatable_now_paths,
        "repo_generation_closes_release_blocker_count": 0,
        "repo_generation_closes_release_blocker_paths": [],
        "local_candidate_metadata_only_blocker_count": len(local_candidate_metadata_only_paths),
        "local_candidate_metadata_only_blocker_paths": local_candidate_metadata_only_paths,
        "repo_generated_candidate_blocked_count": len(generator_paths),
        "repo_generated_candidate_blocked_paths": sorted(generator_paths),
        "not_managed_by_local_generator_blocked_count": len(blocked_paths) - len(generator_paths),
        "true_missing_generated_artifact_count": len(missing_paths),
        "true_missing_generated_artifact_paths": sorted(missing_paths),
        "present_fail_closed_artifact_count": len(present_blocked_paths),
        "present_fail_closed_artifact_paths": sorted(present_blocked_paths),
        "external_release_required_count": len(external_release_required_paths),
        "external_release_required_paths": external_release_required_paths,
        "external_release_evidence_required_count": len(external_release_required_paths),
        "claim_boundary": (
            "These commands only regenerate local fail-closed candidate files; they do "
            "not create approved routed release evidence or unlock fabrication."
        ),
    }


def routed_execution_packet_inventory(
    outputs: dict[str, dict[str, Any]],
    blocked: list[tuple[str, list[str]]],
) -> list[dict[str, Any]]:
    packets: list[dict[str, Any]] = []
    for path_text, failures in blocked:
        artifact = outputs.get(path_text, {})
        packet = unblock_action(path_text, artifact, failures)
        packet.update(
            {
                "packet_id": ",".join(
                    str(source_id)
                    for source_id in (artifact.get("source_ids") or [artifact.get("source_id")])
                    if source_id
                )
                or path_text,
                "required_field_groups": {
                    "common_release_record": sorted(COMMON_FIELDS),
                    "routed_release_traceability": sorted(ROUTED_FIELDS),
                    "external_review_metadata": sorted(METADATA_FIELDS | ROUTED_FIELDS),
                },
                "missing_common_release_record_fields": missing_field_group(failures, "common"),
                "missing_routed_traceability_fields": missing_field_group(failures, "routed"),
                "missing_external_review_metadata_fields": missing_field_group(
                    failures, "external_metadata"
                ),
                "missing_directory_manifest_fields": missing_field_group(
                    failures, "directory_manifest"
                ),
                "missing_text_provenance_fields": missing_field_group(failures, "text_provenance"),
                "required_action": packet["action"],
            }
        )
        packets.append(packet)
    return packets


MISSING_APPROVAL_METADATA_FAILURES = {
    "missing_external_signed_review_metadata",
    "missing_text_release_metadata_or_provenance",
    "directory_missing_release_manifest",
}


def routed_failure_buckets(failures: list[str]) -> dict[str, Any]:
    missing_fields = [failure.split(":", 1)[1] for failure in failures if "_field:" in failure]
    return {
        "missing_generated_output": "artifact_missing" in failures,
        "missing_approval_metadata": bool(set(failures) & MISSING_APPROVAL_METADATA_FAILURES),
        "missing_release_fields": sorted(missing_fields),
        "missing_release_field_count": len(missing_fields),
        "disposition_not_approved": any(
            failure.endswith("disposition_not_approved") for failure in failures
        ),
        "placeholder_or_blocked_marker_present": any(
            failure.endswith("placeholder_or_blocked_marker_present")
            or failure == "placeholder_or_blocked_marker_present"
            for failure in failures
        ),
        "release_credit_false": True,
        "release_credit_false_reason": (
            "routed production output is present only as local/planning/candidate "
            "evidence or lacks approved release metadata; it cannot unlock fabrication"
        ),
    }


def routed_output_blocker_categories(
    outputs: dict[str, dict[str, Any]],
    blocked: list[tuple[str, list[str]]],
) -> dict[str, Any]:
    categories: dict[str, dict[str, Any]] = {
        "true_missing_generated_outputs": {
            "count": 0,
            "paths": [],
            "required_action": (
                "generate or stage the missing routed-board output files at the exact "
                "matrix paths from the real routed board, then rerun validation"
            ),
            "release_credit": False,
        },
        "missing_approval_metadata": {
            "count": 0,
            "paths": [],
            "required_action": (
                "attach signed approval metadata, release manifests, or embedded "
                "release provenance for routed outputs that already exist on disk"
            ),
            "release_credit": False,
        },
        "candidate_present_but_blocked": {
            "count": 0,
            "paths": [],
            "required_action": (
                "promote the local routed-output candidates to approved release "
                "records with non-placeholder disposition, hashes, review authority, "
                "and signoff"
            ),
            "release_credit": False,
        },
        "present_unapproved_or_placeholder": {
            "count": 0,
            "paths": [],
            "required_action": (
                "replace present routed-output records that are outside the candidate "
                "manifest but still unapproved, placeholder, or blocked"
            ),
            "release_credit": False,
        },
    }
    by_path: dict[str, dict[str, Any]] = {}
    for path_text, failures in blocked:
        artifact = outputs.get(path_text, {})
        failure_set = set(failures)
        if "artifact_missing" in failure_set:
            category_id = "true_missing_generated_outputs"
        elif failure_set & MISSING_APPROVAL_METADATA_FAILURES:
            category_id = "missing_approval_metadata"
        elif artifact.get("candidate_present_blocked") is True:
            category_id = "candidate_present_but_blocked"
        else:
            category_id = "present_unapproved_or_placeholder"

        categories[category_id]["count"] += 1
        categories[category_id]["paths"].append(path_text)
        metadata_record = metadata_record_targets(path_text)
        failure_buckets = routed_failure_buckets(failures)
        by_path[path_text] = {
            "category": category_id,
            "missing_generated_output": failure_buckets["missing_generated_output"],
            "missing_approval_metadata": failure_buckets["missing_approval_metadata"],
            "candidate_present_but_blocked": category_id == "candidate_present_but_blocked",
            "present_unapproved_or_placeholder": category_id == "present_unapproved_or_placeholder",
            "failures": failures,
            "failure_buckets": failure_buckets,
            "required_metadata_record": metadata_record,
            "repo_generation_plan": repo_generation_plan(path_text, artifact, failures),
            "candidate_fail_closed_metadata": {
                "candidate_manifest": artifact.get("candidate_manifest") or "",
                "candidate_present_blocked": artifact.get("candidate_present_blocked") is True,
                "candidate_release_credit": False,
                "required_release_metadata_record": metadata_record["primary_record_path"],
                "required_non_placeholder_disposition": "approved",
                "required_review_authority": True,
                "required_signature_or_approval_record": True,
                "required_artifact_sha256": True,
                "required_routed_traceability_fields": sorted(ROUTED_FIELDS),
                "validation_command": VALIDATION_COMMAND,
            },
            "release_credit_false": True,
            "release_credit_false_reason": failure_buckets["release_credit_false_reason"],
            "release_credit": False,
        }

    for category in categories.values():
        category["paths"] = sorted(category["paths"])
        category["validation_command"] = VALIDATION_COMMAND

    return {
        "categories": categories,
        "release_credit_false_artifacts": {
            "count": len(blocked),
            "paths": sorted(path_text for path_text, _failures in blocked),
            "required_action": (
                "replace every routed-output candidate/presence-only row with a signed, "
                "approved release record before granting fabrication release credit"
            ),
            "validation_command": VALIDATION_COMMAND,
            "release_credit": False,
        },
        "by_path": dict(sorted(by_path.items())),
        "counts": {category_id: category["count"] for category_id, category in categories.items()},
        "release_credit": False,
    }


def candidate_coverage(
    outputs: dict[str, dict[str, Any]],
    blocked: list[tuple[str, list[str]]],
    candidate_manifest: dict[str, Any],
) -> dict[str, Any]:
    candidate_paths = set(candidate_manifest.get("artifact_paths") or [])
    blocked_candidate_paths = sorted(
        path_text
        for path_text, failures in blocked
        if path_text in candidate_paths and "artifact_missing" not in failures
    )
    missing_candidate_paths = sorted(
        path_text
        for path_text, failures in blocked
        if path_text in candidate_paths and "artifact_missing" in failures
    )
    missing_non_candidate_paths = sorted(
        path_text
        for path_text, failures in blocked
        if path_text not in candidate_paths and "artifact_missing" in failures
    )
    required_candidate_paths = sorted(path for path in outputs if path in candidate_paths)
    return {
        "candidate_manifest": candidate_manifest.get("path"),
        "candidate_manifest_present": candidate_manifest.get("present") is True,
        "candidate_manifest_status": candidate_manifest.get("status"),
        "candidate_release_credit": candidate_manifest.get("release_credit") is True,
        "candidate_artifact_count": int(candidate_manifest.get("artifact_count") or 0),
        "required_paths_covered_by_candidate_manifest": len(required_candidate_paths),
        "candidate_present_but_blocked_paths": blocked_candidate_paths,
        "candidate_present_but_blocked_count": len(blocked_candidate_paths),
        "candidate_paths_missing_from_repo": missing_candidate_paths,
        "candidate_paths_missing_from_repo_count": len(missing_candidate_paths),
        "missing_required_paths_not_in_candidate_manifest": missing_non_candidate_paths,
        "missing_required_paths_not_in_candidate_manifest_count": len(missing_non_candidate_paths),
        "intentionally_not_generated": candidate_manifest.get("intentionally_not_generated") or [],
    }


def approval_metadata_unblock_summary(
    blocked: list[tuple[str, list[str]]],
) -> list[dict[str, Any]]:
    missing_review_metadata = 0
    missing_text_provenance = 0
    missing_fields: Counter[str] = Counter()
    unapproved = 0
    placeholder = 0
    for _path_text, failures in blocked:
        if "missing_external_signed_review_metadata" in failures:
            missing_review_metadata += 1
        if "missing_text_release_metadata_or_provenance" in failures:
            missing_text_provenance += 1
        if any(failure.endswith("disposition_not_approved") for failure in failures):
            unapproved += 1
        if any(failure.endswith("placeholder_or_blocked_marker_present") for failure in failures):
            placeholder += 1
        for failure in failures:
            if "_field:" in failure:
                missing_fields[failure.split(":", 1)[1]] += 1

    return [
        {
            "id": "attach_routed_external_review_metadata",
            "blocked_rows": missing_review_metadata,
            "required_action": (
                "add signed .metadata.yaml companions for binary routed outputs with "
                "external review authority, approval record, artifact SHA-256, routed PCB "
                "hash, DRC/ERC status, stackup, SI/PI/RF references, and routed STEP link"
            ),
            "validation_command": VALIDATION_COMMAND,
            "release_credit": False,
        },
        {
            "id": "add_text_release_metadata_or_provenance",
            "blocked_rows": missing_text_provenance,
            "required_action": (
                "add approved companion metadata or embedded release provenance to KiCad, "
                "BOM, placement, report, and text artifacts"
            ),
            "validation_command": VALIDATION_COMMAND,
            "release_credit": False,
        },
        {
            "id": "complete_routed_approval_metadata_fields",
            "blocked_rows": sum(missing_fields.values()),
            "top_missing_fields": dict(sorted(missing_fields.most_common(12))),
            "required_action": (
                "fill the highest-count routed release metadata fields first; every "
                "candidate still needs approved disposition and signed review authority"
            ),
            "validation_command": VALIDATION_COMMAND,
            "release_credit": False,
        },
        {
            "id": "approve_and_deplaceholder_routed_records",
            "blocked_rows": unapproved + placeholder,
            "unapproved_rows": unapproved,
            "placeholder_rows": placeholder,
            "required_action": (
                "replace candidate/presence-only routed outputs with approved, signed, "
                "non-placeholder release records"
            ),
            "validation_command": VALIDATION_COMMAND,
            "release_credit": False,
        },
    ]


def blocker_diagnostics(
    outputs: dict[str, dict[str, Any]],
    blocked: list[tuple[str, list[str]]],
) -> dict[str, Any]:
    by_owner: Counter[str] = Counter()
    by_source_id: Counter[str] = Counter()
    by_required_status: Counter[str] = Counter()
    by_failure: Counter[str] = Counter()
    missing_paths: list[str] = []
    present_blocked_paths: list[str] = []
    missing_fields_by_path: dict[str, list[str]] = {}
    for path_text, failures in blocked:
        artifact = outputs.get(path_text, {})
        owner = artifact.get("owner") or ",".join(artifact.get("source_ids") or [])
        owner = str(owner or "layout_fabrication")
        by_owner[owner] += 1
        source_ids = artifact.get("source_ids") or [artifact.get("source_id")]
        for source_id in source_ids:
            if source_id:
                by_source_id[str(source_id)] += 1
        required_statuses = artifact.get("required_statuses") or []
        if artifact.get("required_status"):
            required_statuses = [*required_statuses, artifact.get("required_status")]
        for status in required_statuses or ["routed_release_output_required"]:
            by_required_status[str(status)] += 1
        for failure in failures:
            by_failure[failure] += 1
        if "artifact_missing" in failures:
            missing_paths.append(path_text)
        else:
            present_blocked_paths.append(path_text)
        missing_fields = [
            failure.split(":", 1)[1]
            for failure in failures
            if failure.startswith("missing_common_field:")
            or failure.startswith("missing_routed_field:")
            or failure.startswith("missing_external_metadata_field:")
            or failure.startswith("missing_directory_manifest_field:")
            or failure.startswith("missing_text_provenance_field:")
        ]
        if missing_fields:
            missing_fields_by_path[path_text] = sorted(missing_fields)
    return {
        "blocked_by_owner": dict(sorted(by_owner.items())),
        "blocked_by_source_id": dict(sorted(by_source_id.items())),
        "blocked_by_required_status": dict(sorted(by_required_status.items())),
        "blocked_by_failure": dict(sorted(by_failure.items())),
        "missing_paths": sorted(missing_paths),
        "present_blocked_paths": sorted(present_blocked_paths),
        "missing_fields_by_path": dict(sorted(missing_fields_by_path.items())),
        "approval_metadata_unblock_summary": approval_metadata_unblock_summary(blocked),
        "next_unblock_groups": [
            {
                "id": "stage_missing_routed_release_outputs",
                "owner": "layout_fabrication",
                "blocked_rows": by_failure.get("artifact_missing", 0),
                "required_action": (
                    "generate or stage missing routed PCB, fabrication, SI/PI/RF, "
                    "DFM, ERC/DRC, and routed STEP release outputs from the real route"
                ),
            },
            {
                "id": "replace_routed_candidates_with_signed_release_records",
                "owner": "layout_fabrication",
                "blocked_rows": len(present_blocked_paths),
                "required_action": (
                    "replace local candidates or presence-only files with approved "
                    "routed release metadata, hashes, external review authority, "
                    "and signoff"
                ),
            },
        ],
    }


def missing_fields(data: Any, fields: set[str]) -> list[str]:
    if not isinstance(data, dict):
        return sorted(fields)
    return sorted(field for field in fields if not data.get(field))


def approved_record_failures(data: Any, field_set: set[str], prefix: str) -> list[str]:
    failures: list[str] = []
    failures.extend(f"missing_{prefix}_field:{field}" for field in missing_fields(data, field_set))
    if isinstance(data, dict) and data.get("disposition") != "approved":
        failures.append(f"{prefix}_disposition_not_approved")
    if has_placeholder(data):
        failures.append(f"{prefix}_placeholder_or_blocked_marker_present")
    return failures


def directory_failures(path: Path) -> list[str]:
    manifest_candidates = [
        path / "release-manifest.yaml",
        path / "manifest.yaml",
        path / "index.yaml",
        path.with_suffix(path.suffix + ".metadata.yaml"),
    ]
    manifest = next((candidate for candidate in manifest_candidates if candidate.is_file()), None)
    if manifest is None:
        return ["directory_missing_release_manifest"]
    if manifest.stat().st_size == 0:
        return ["directory_release_manifest_empty"]
    try:
        parsed = load_yaml_mapping(manifest)
    except Exception as exc:  # noqa: BLE001 - release gate error surface.
        return [f"directory_release_manifest_parse_failed:{type(exc).__name__}"]
    failures = approved_record_failures(parsed, COMMON_FIELDS | ROUTED_FIELDS, "directory_manifest")
    children = [
        child
        for child in path.rglob("*")
        if child.is_file() and child != manifest and child.stat().st_size > 0
    ]
    if not children:
        failures.append("directory_missing_release_children")
    child_paths = sorted(rel(child) for child in children)
    inventory = parsed.get("child_artifact_inventory")
    if isinstance(inventory, list):
        inventory_paths = sorted(
            str(record.get("path"))
            for record in inventory
            if isinstance(record, dict) and record.get("path")
        )
        if inventory_paths != child_paths:
            failures.append("directory_child_artifact_inventory_stale")
        placeholder_paths = sorted(
            str(record.get("path"))
            for record in inventory
            if isinstance(record, dict) and record.get("candidate_placeholder") is True
        )
        actual_placeholder_paths = sorted(
            rel(child) for child in children if child.name == "candidate-placeholder.txt"
        )
        if placeholder_paths != actual_placeholder_paths:
            failures.append("directory_candidate_placeholder_inventory_stale")
        if int(parsed.get("child_artifact_count") or 0) != len(child_paths):
            failures.append("directory_child_artifact_count_stale")
        if int(parsed.get("candidate_placeholder_child_count") or 0) != len(
            actual_placeholder_paths
        ):
            failures.append("directory_candidate_placeholder_child_count_stale")
        if parsed.get("release_child_count") != 0:
            failures.append("directory_claims_release_children")
        if (
            "board/kicad/e1-phone/production/reports/" in rel(path)
            and parsed.get("all_non_manifest_children_classified") is not True
        ):
            failures.append("directory_unclassified_non_manifest_children")
    return sorted(dict.fromkeys(failures))


def companion_metadata_failures(path: Path) -> list[str]:
    metadata = path.with_suffix(path.suffix + ".metadata.yaml")
    if not metadata.is_file():
        return ["missing_external_signed_review_metadata"]
    if metadata.stat().st_size == 0:
        return ["external_signed_review_metadata_empty"]
    try:
        parsed = load_yaml_mapping(metadata)
    except Exception as exc:  # noqa: BLE001 - release gate error surface.
        return [f"external_signed_review_metadata_parse_failed:{type(exc).__name__}"]
    return approved_record_failures(parsed, METADATA_FIELDS | ROUTED_FIELDS, "external_metadata")


def embedded_text_provenance(path: Path, text: str) -> dict[str, str]:
    provenance: dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        while stripped.startswith(("#", "//", ";")):
            stripped = stripped[1:].strip()
        if ":" not in stripped:
            continue
        key, value = stripped.split(":", 1)
        key = key.strip().strip('"')
        if key in METADATA_FIELDS or key in ROUTED_FIELDS:
            provenance[key] = value.strip().strip('"')
    if provenance:
        provenance.setdefault("artifact_id", path.stem)
    return provenance


def text_artifact_release_failures(path: Path, text: str) -> list[str]:
    metadata = path.with_suffix(path.suffix + ".metadata.yaml")
    if metadata.exists():
        return companion_metadata_failures(path)
    provenance = embedded_text_provenance(path, text)
    if not provenance:
        return ["missing_text_release_metadata_or_provenance"]
    return approved_record_failures(
        provenance,
        METADATA_FIELDS | ROUTED_FIELDS,
        "text_provenance",
    )


def raw_kicad_report_failures(path_text: str, parsed: Any) -> list[str]:
    requirements = RAW_KICAD_REPORT_REQUIREMENTS.get(path_text)
    if not requirements:
        return []
    failures: list[str] = []
    if not isinstance(parsed, dict):
        return [f"raw_kicad_{requirements['kind']}_report_not_mapping"]
    if parsed.get("raw_kicad_report_kind") != requirements["kind"]:
        failures.append(f"raw_kicad_{requirements['kind']}_report_kind_missing")
    command = str(parsed.get("raw_kicad_cli_command") or "")
    for fragment in requirements["required_command_fragments"]:
        if fragment not in command:
            failures.append(f"raw_kicad_{requirements['kind']}_command_missing:{fragment}")
    if not parsed.get("kicad_cli_version"):
        failures.append(f"raw_kicad_{requirements['kind']}_tool_version_missing")
    if not parsed.get(requirements["source_hash_field"]):
        failures.append(
            f"raw_kicad_{requirements['kind']}_{requirements['source_hash_field']}_missing"
        )
    if parsed.get("tool_exit_code") != 0:
        failures.append(f"raw_kicad_{requirements['kind']}_tool_exit_code_not_zero")
    raw_payload = parsed.get("raw_kicad_cli_report")
    if not isinstance(raw_payload, (dict, list)) or not raw_payload:
        failures.append(f"raw_kicad_{requirements['kind']}_payload_missing")
    if parsed.get("schema") == "eliza.e1_phone_routed_output_candidate_report.v1":
        failures.append(f"raw_kicad_{requirements['kind']}_is_candidate_metadata_not_cli_report")
    if str(parsed.get("claim_boundary") or "").lower().find("candidate") >= 0:
        failures.append(f"raw_kicad_{requirements['kind']}_claim_boundary_candidate")
    return failures


def collect_required_outputs(
    matrix: dict[str, Any],
    *,
    include_present_validation_artifacts: bool = True,
) -> dict[str, dict[str, Any]]:
    outputs: dict[str, dict[str, Any]] = {}

    def add(artifact: Any) -> None:
        if isinstance(artifact, dict) and isinstance(artifact.get("path"), str):
            outputs.setdefault(artifact["path"], artifact)

    for row in matrix.get("required_production_outputs", []):
        add(row)
    for row in matrix.get("missing_production_outputs", []):
        add(row)
    for domain in matrix.get("route_domain_acceptance_matrix", []):
        for artifact in domain.get("required_production_outputs", []):
            add(artifact)
    if include_present_validation_artifacts:
        for category in matrix.get("required_acceptance_evidence", []):
            for artifact in category.get("required_artifacts", []):
                if artifact.get("present") is True:
                    add(artifact)
    return outputs


def content_failures(path_text: str) -> list[str]:
    failures: list[str] = []
    path = repo_path(path_text)
    if not path.exists():
        return ["artifact_missing"]
    if path.is_dir():
        return directory_failures(path)
    if path.stat().st_size == 0:
        failures.append("artifact_empty")

    try:
        parsed = parse_file(path)
    except Exception as exc:  # noqa: BLE001 - release gate error surface.
        return [f"artifact_parse_failed:{type(exc).__name__}"]

    suffix = path.suffix.lower()
    if suffix in {".yaml", ".yml", ".json"}:
        failures.extend(approved_record_failures(parsed, COMMON_FIELDS, "common"))
        failures.extend(
            f"missing_routed_field:{field}" for field in missing_fields(parsed, ROUTED_FIELDS)
        )
        failures.extend(
            f"missing_common_field:{field}" for field in missing_fields(parsed, COMMON_FIELDS)
        )
        failures.extend(raw_kicad_report_failures(path_text, parsed))
        if isinstance(parsed, dict) and parsed.get("disposition") != "approved":
            failures.append("disposition_not_approved")
    elif suffix == ".csv":
        if not isinstance(parsed, list) or not parsed:
            failures.append("csv_empty")
        else:
            headers = set(parsed[0])
            if not ({"net", "measured_value", "limit", "result"} <= headers):
                failures.append("csv_missing_measurement_limit_result_columns")
    elif suffix in {".step", ".stp", ".pdf", ".zip", ".ipc", ".tgz"}:
        failures.extend(companion_metadata_failures(path))
    elif suffix in TEXT_RELEASE_ARTIFACT_SUFFIXES and isinstance(parsed, str):
        failures.extend(text_artifact_release_failures(path, parsed))
    elif isinstance(parsed, str) and has_placeholder(parsed):
        failures.append("placeholder_or_blocked_marker_present")

    if has_placeholder(parsed):
        failures.append("placeholder_or_blocked_marker_present")
    return sorted(dict.fromkeys(failures))


def main() -> int:
    args = parse_args()
    try:
        matrix = load_yaml_mapping(MATRIX)
        if matrix.get("schema") != EXPECTED_SCHEMA:
            raise ValueError(f"unexpected schema: {matrix.get('schema')!r}")
        summary = matrix.get("summary")
        if not isinstance(summary, dict):
            raise ValueError("summary must be a mapping")
        candidate_context = matrix.get("candidate_end_to_end_context")
        if not isinstance(candidate_context, dict):
            raise ValueError("candidate_end_to_end_context must be a mapping")
        candidate_visual = candidate_context.get("routed_step_visual_detail")
        candidate_connection = candidate_context.get("cad_connection_coverage")
        candidate_traceability = candidate_context.get("kicad_cad_traceability")
        candidate_instance_disposition = candidate_context.get("instance_pin_step_disposition")
        candidate_models = candidate_context.get("component_model_manifest_summary")
        candidate_model_dir = candidate_context.get("component_model_directory_summary")
        candidate_source_binding = candidate_context.get("routed_candidate_source_binding")
        if not all(
            isinstance(item, dict)
            for item in (
                candidate_visual,
                candidate_connection,
                candidate_traceability,
                candidate_instance_disposition,
                candidate_models,
                candidate_model_dir,
                candidate_source_binding,
            )
        ):
            raise ValueError("candidate_end_to_end_context nested summaries must be mappings")
        assert isinstance(candidate_visual, dict)
        assert isinstance(candidate_source_binding, dict)
        assert isinstance(candidate_instance_disposition, dict)
        assert isinstance(candidate_models, dict)
        contract_mismatches: list[str] = []
        expected_candidate_context = {
            "status": "blocked_local_candidate_outputs_not_release",
            "release_credit": False,
            "local_candidate_can_satisfy_release_gate": False,
        }
        for key, expected in expected_candidate_context.items():
            if candidate_context.get(key) != expected:
                contract_mismatches.append(f"candidate context stale: {key}")
        candidate_manifest_context = load_yaml_mapping(CANDIDATE_MANIFEST)
        source_step_path = ROOT / str(candidate_manifest_context.get("source_step") or "")
        if not source_step_path.is_file():
            raise ValueError("candidate manifest source STEP path is missing")
        source_board_path = ROOT / str(candidate_source_binding.get("source_board") or "")
        candidate_board_path = ROOT / str(candidate_source_binding.get("candidate_board") or "")
        if not source_board_path.is_file() or not candidate_board_path.is_file():
            raise ValueError("candidate source-binding board paths are missing")
        source_board_counts = kicad_board_counts(source_board_path)
        candidate_board_counts = kicad_board_counts(candidate_board_path)
        step_intake = load_yaml_mapping(STEP_INTAKE)
        step_segments = [
            segment for segment in step_intake.get("segments", []) if isinstance(segment, dict)
        ]
        step_vias = [via for via in step_intake.get("vias", []) if isinstance(via, dict)]
        component_manifest_source = load_yaml_mapping(
            repo_path(str(candidate_context.get("component_model_manifest") or ""))
        )
        component_dir_manifest_source = load_yaml_mapping(
            repo_path(str(candidate_context.get("component_model_directory") or ""))
            / "release-manifest.yaml"
        )
        traceability_source = load_yaml_mapping(
            ROOT / "board/kicad/e1-phone/kicad-cad-traceability-matrix-2026-05-22.yaml"
        )
        instance_disposition_source = load_yaml_mapping(INSTANCE_DISPOSITION)
        instance_summary = instance_disposition_source.get("summary")
        if not isinstance(instance_summary, dict):
            raise ValueError("instance pin/STEP disposition summary missing")
        traceability_summary = traceability_source.get("summary")
        if not isinstance(traceability_summary, dict):
            raise ValueError("KiCad/CAD traceability summary missing")
        cad_connection_summary = component_manifest_source.get("cad_connection_coverage")
        if not isinstance(cad_connection_summary, dict):
            raise ValueError("component manifest CAD connection coverage missing")
        component_package_summary = component_manifest_source.get("package_visual_summary")
        component_terminal_summary = component_manifest_source.get("terminal_contract_binding")
        if not isinstance(component_package_summary, dict) or not isinstance(
            component_terminal_summary, dict
        ):
            raise ValueError("component manifest package/terminal summaries missing")
        component_models_source = [
            model
            for model in component_manifest_source.get("models", [])
            if isinstance(model, dict)
        ]
        for model in component_models_source:
            if bool(model.get("pinout_bound")) != bool(model.get("pinout_file")):
                raise ValueError(
                    "component model pinout_bound field diverges from pinout_file: "
                    f"{model.get('reference', '')}"
                )
        expected_candidate_counts: dict[str | tuple[str, str], Any] = {
            "source_step_size_bytes": source_step_path.stat().st_size,
            ("routed_candidate_source_binding", "source_board_sha256"): source_board_counts[
                "sha256"
            ],
            ("routed_candidate_source_binding", "candidate_board_sha256"): candidate_board_counts[
                "sha256"
            ],
            ("routed_candidate_source_binding", "candidate_matches_source_board"): True,
            (
                "routed_candidate_source_binding",
                "source_is_zero_placeholder_real_footprint_board",
            ): True,
            (
                "routed_candidate_source_binding",
                "candidate_is_zero_placeholder_real_footprint_board",
            ): True,
            (
                "routed_candidate_source_binding",
                "source_placeholder_marker_count",
            ): source_board_counts["placeholder_marker_count"],
            (
                "routed_candidate_source_binding",
                "candidate_placeholder_marker_count",
            ): candidate_board_counts["placeholder_marker_count"],
            ("instance_pin_step_disposition", "source"): rel(INSTANCE_DISPOSITION),
            (
                "instance_pin_step_disposition",
                "status",
            ): instance_disposition_source.get("status"),
            (
                "instance_pin_step_disposition",
                "component_instance_count",
            ): int(instance_summary.get("component_instance_count") or 0),
            (
                "instance_pin_step_disposition",
                "routed_board_footprint_count",
            ): int(instance_summary.get("routed_board_footprint_count") or 0),
            (
                "instance_pin_step_disposition",
                "pinout_bound_instance_count",
            ): int(instance_summary.get("pinout_bound_instance_count") or 0),
            (
                "instance_pin_step_disposition",
                "support_pattern_instance_count",
            ): int(instance_summary.get("support_pattern_instance_count") or 0),
            (
                "instance_pin_step_disposition",
                "pending_supplier_pad_map_or_order_instance_count",
            ): int(instance_summary.get("pending_supplier_pad_map_or_order_instance_count") or 0),
            (
                "instance_pin_step_disposition",
                "public_candidate_package_conflict_instance_count",
            ): int(instance_summary.get("public_candidate_package_conflict_instance_count") or 0),
            (
                "instance_pin_step_disposition",
                "local_step_instance_count",
            ): int(instance_summary.get("local_step_instance_count") or 0),
            (
                "instance_pin_step_disposition",
                "local_step_hash_match_count",
            ): int(instance_summary.get("local_step_hash_match_count") or 0),
            (
                "instance_pin_step_disposition",
                "local_contract_pass_count",
            ): int(instance_summary.get("local_contract_pass_count") or 0),
            (
                "instance_pin_step_disposition",
                "local_review_pass_count",
            ): int(instance_summary.get("local_review_pass_count") or 0),
            (
                "instance_pin_step_disposition",
                "supplier_approved_instance_count",
            ): int(instance_summary.get("supplier_approved_instance_count") or 0),
            (
                "instance_pin_step_disposition",
                "release_credit_instance_count",
            ): int(instance_summary.get("release_credit_instance_count") or 0),
            (
                "instance_pin_step_disposition",
                "local_failure_count",
            ): int(instance_summary.get("local_failure_count") or 0),
            (
                "instance_pin_step_disposition",
                "record_count",
            ): len(instance_disposition_source.get("records", []) or []),
            (
                "routed_candidate_source_binding",
                "candidate_legacy_e1phone_footprint_ref_count",
            ): candidate_board_counts["legacy_e1phone_footprint_ref_count"],
            (
                "routed_candidate_source_binding",
                "candidate_footprint_count",
            ): candidate_board_counts["footprint_count"],
            ("routed_candidate_source_binding", "candidate_segment_count"): candidate_board_counts[
                "segment_count"
            ],
            ("routed_candidate_source_binding", "candidate_via_count"): candidate_board_counts[
                "via_count"
            ],
            ("routed_candidate_source_binding", "candidate_zone_count"): candidate_board_counts[
                "zone_count"
            ],
            (
                "routed_candidate_source_binding",
                "candidate_filled_zone_count",
            ): candidate_board_counts["filled_zone_count"],
            ("routed_step_visual_detail", "footprint_envelope_count"): step_intake.get(
                "footprint_envelope_count"
            ),
            ("routed_step_visual_detail", "pad_contact_visual_count"): step_intake.get(
                "pad_contact_visual_count"
            ),
            ("routed_step_visual_detail", "route_segment_visual_count"): step_intake.get(
                "route_segment_visual_count"
            ),
            ("routed_step_visual_detail", "route_segment_net_name_count"): step_intake.get(
                "route_segment_net_name_count"
            ),
            ("routed_step_visual_detail", "route_segment_trace_bound_count"): step_intake.get(
                "route_segment_trace_bound_count"
            ),
            ("routed_step_visual_detail", "route_segment_trace_unbound_count"): step_intake.get(
                "route_segment_trace_unbound_count"
            ),
            ("routed_step_visual_detail", "controlled_impedance_segment_visual_count"): (
                step_intake.get("controlled_impedance_segment_visual_count")
            ),
            ("routed_step_visual_detail", "board_via_count"): candidate_board_counts["via_count"],
            ("routed_step_visual_detail", "via_net_name_count"): step_intake.get(
                "via_net_name_count"
            ),
            ("routed_step_visual_detail", "route_visual_record_count"): len(step_segments),
            ("routed_step_visual_detail", "route_visual_route_id_count"): len(
                {str(segment.get("route_id", "")) for segment in step_segments}
            ),
            ("routed_step_visual_detail", "route_visual_net_name_count"): len(
                {str(segment.get("net", "")) for segment in step_segments}
            ),
            ("routed_step_visual_detail", "route_visual_all_records_have_route_id"): all(
                bool(segment.get("route_id")) for segment in step_segments
            ),
            ("routed_step_visual_detail", "route_visual_all_records_have_net"): all(
                bool(segment.get("net")) for segment in step_segments
            ),
            ("routed_step_visual_detail", "route_visual_all_records_have_layer"): all(
                bool(segment.get("layer")) for segment in step_segments
            ),
            ("routed_step_visual_detail", "route_visual_all_records_have_route_class"): all(
                bool(segment.get("route_classes")) for segment in step_segments
            ),
            ("routed_step_visual_detail", "route_visual_all_records_have_source_domain"): all(
                bool(segment.get("source_domains")) for segment in step_segments
            ),
            ("routed_step_visual_detail", "via_visual_record_count"): len(step_vias),
            ("routed_step_visual_detail", "via_visual_net_name_count"): len(
                {str(via.get("net", "")) for via in step_vias}
            ),
            ("routed_step_visual_detail", "via_visual_all_records_have_net"): all(
                bool(via.get("net")) for via in step_vias
            ),
            ("routed_step_visual_detail", "via_visual_all_records_have_layers"): all(
                bool(via.get("layers")) for via in step_vias
            ),
            ("routed_step_visual_detail", "filled_copper_zone_record_count"): step_intake.get(
                "filled_copper_zone_visual_count"
            ),
            ("routed_step_visual_detail", "filled_copper_zone_all_records_have_net"): (
                int(step_intake.get("filled_copper_zone_net_name_count") or 0) > 0
            ),
            ("routed_step_visual_detail", "filled_copper_zone_all_records_have_bbox"): (
                int(step_intake.get("filled_copper_zone_visual_count") or 0) > 0
            ),
            ("routed_step_visual_detail", "release_credit"): False,
            ("cad_connection_coverage", "required_connection_count"): cad_connection_summary.get(
                "required_connection_count"
            ),
            ("cad_connection_coverage", "passing_connection_count"): cad_connection_summary.get(
                "passing_connection_count"
            ),
            (
                "cad_connection_coverage",
                "required_connection_terminal_marker_count",
            ): cad_connection_summary.get("required_connection_terminal_marker_count"),
            (
                "cad_connection_coverage",
                "passing_connection_terminal_pair_count",
            ): cad_connection_summary.get("passing_connection_terminal_pair_count"),
            (
                "cad_connection_coverage",
                "required_connection_solid_step_part_count",
            ): cad_connection_summary.get("required_connection_solid_step_part_count"),
            (
                "cad_connection_coverage",
                "passing_connection_solid_step_part_set_count",
            ): cad_connection_summary.get("passing_connection_solid_step_part_set_count"),
            ("cad_connection_coverage", "assembly_manifest_part_count"): cad_connection_summary.get(
                "assembly_manifest_part_count"
            ),
            (
                "cad_connection_coverage",
                "assembly_manifest_connection_terminal_marker_count",
            ): cad_connection_summary.get("assembly_manifest_connection_terminal_marker_count"),
            (
                "cad_connection_coverage",
                "assembly_manifest_connection_solid_step_part_count",
            ): cad_connection_summary.get("assembly_manifest_connection_solid_step_part_count"),
            (
                "cad_connection_coverage",
                "assembly_manifest_missing_connection_solid_step_part_count",
            ): cad_connection_summary.get(
                "assembly_manifest_missing_connection_solid_step_part_count"
            ),
            ("cad_connection_coverage", "represented_net_count_total"): cad_connection_summary.get(
                "represented_net_count_total"
            ),
            (
                "cad_connection_coverage",
                "represented_route_record_count_total",
            ): cad_connection_summary.get("represented_route_record_count_total"),
            (
                "cad_connection_coverage",
                "represented_route_records_with_layer_count_total",
            ): cad_connection_summary.get("represented_route_records_with_layer_count_total"),
            (
                "cad_connection_coverage",
                "represented_route_records_with_source_domain_count_total",
            ): cad_connection_summary.get(
                "represented_route_records_with_source_domain_count_total"
            ),
            (
                "cad_connection_coverage",
                "represented_route_records_with_route_class_count_total",
            ): cad_connection_summary.get("represented_route_records_with_route_class_count_total"),
            (
                "cad_connection_coverage",
                "represented_route_classification_gap_count",
            ): cad_connection_summary.get("represented_route_classification_gap_count"),
            ("cad_connection_coverage", "connection_record_count"): cad_connection_summary.get(
                "required_connection_count"
            ),
            ("cad_connection_coverage", "represented_net_list_total"): cad_connection_summary.get(
                "represented_net_count_total"
            ),
            (
                "cad_connection_coverage",
                "controlled_impedance_connection_count",
            ): cad_connection_summary.get("controlled_impedance_connection_count"),
            (
                "cad_connection_coverage",
                "controlled_impedance_requirement_defined_count",
            ): cad_connection_summary.get("controlled_impedance_requirement_defined_count"),
            (
                "cad_connection_coverage",
                "bend_radius_requirement_defined_count",
            ): cad_connection_summary.get("bend_radius_requirement_defined_count"),
            (
                "cad_connection_coverage",
                "supplier_release_required_connection_count",
            ): cad_connection_summary.get("supplier_release_required_connection_count"),
            ("kicad_cad_traceability", "footprint_library_count"): traceability_summary.get(
                "footprint_library_count"
            ),
            ("kicad_cad_traceability", "board_bound_instance_count"): traceability_summary.get(
                "board_bound_instance_count"
            ),
            ("kicad_cad_traceability", "step_footprint_instance_count"): traceability_summary.get(
                "step_footprint_instance_count"
            ),
            ("kicad_cad_traceability", "pinout_bound_footprint_count"): traceability_summary.get(
                "pinout_bound_footprint_count"
            ),
            ("kicad_cad_traceability", "cad_connection_count"): traceability_summary.get(
                "cad_connection_count"
            ),
            (
                "kicad_cad_traceability",
                "cad_connection_represented_net_count_total",
            ): traceability_summary.get("cad_connection_represented_net_count_total"),
            (
                "kicad_cad_traceability",
                "cad_connection_represented_route_count_total",
            ): traceability_summary.get("cad_connection_represented_route_count_total"),
            (
                "kicad_cad_traceability",
                "cad_connection_represented_route_record_count_total",
            ): traceability_summary.get("cad_connection_represented_route_record_count_total"),
            (
                "kicad_cad_traceability",
                "cad_connection_represented_route_records_with_layer_count_total",
            ): traceability_summary.get(
                "cad_connection_represented_route_records_with_layer_count_total"
            ),
            (
                "kicad_cad_traceability",
                "cad_connection_represented_route_records_with_source_domain_count_total",
            ): traceability_summary.get(
                "cad_connection_represented_route_records_with_source_domain_count_total"
            ),
            (
                "kicad_cad_traceability",
                "cad_connection_represented_route_records_with_route_class_count_total",
            ): traceability_summary.get(
                "cad_connection_represented_route_records_with_route_class_count_total"
            ),
            (
                "kicad_cad_traceability",
                "cad_connection_represented_route_classification_gap_count",
            ): traceability_summary.get(
                "cad_connection_represented_route_classification_gap_count"
            ),
            (
                "kicad_cad_traceability",
                "cad_connection_visual_route_span_total_mm",
            ): traceability_summary.get("cad_connection_visual_route_span_total_mm"),
            (
                "kicad_cad_traceability",
                "cad_connection_terminal_marker_count",
            ): traceability_summary.get("cad_connection_terminal_marker_count"),
            (
                "kicad_cad_traceability",
                "cad_connection_terminal_pair_count",
            ): traceability_summary.get("cad_connection_terminal_pair_count"),
            (
                "kicad_cad_traceability",
                "cad_connection_solid_step_part_count",
            ): traceability_summary.get("cad_connection_solid_step_part_count"),
            (
                "kicad_cad_traceability",
                "cad_connection_solid_step_part_set_count",
            ): traceability_summary.get("cad_connection_solid_step_part_set_count"),
            (
                "kicad_cad_traceability",
                "cad_connection_solid_step_part_bytes_total",
            ): traceability_summary.get("cad_connection_solid_step_part_bytes_total"),
            (
                "kicad_cad_traceability",
                "cad_connection_controlled_impedance_count",
            ): traceability_summary.get("cad_connection_controlled_impedance_count"),
            (
                "kicad_cad_traceability",
                "cad_connection_controlled_impedance_requirement_defined_count",
            ): traceability_summary.get(
                "cad_connection_controlled_impedance_requirement_defined_count"
            ),
            (
                "kicad_cad_traceability",
                "cad_connection_bend_radius_requirement_defined_count",
            ): traceability_summary.get("cad_connection_bend_radius_requirement_defined_count"),
            (
                "kicad_cad_traceability",
                "cad_connection_mechanical_envelope_defined_count",
            ): traceability_summary.get("cad_connection_mechanical_envelope_defined_count"),
            (
                "kicad_cad_traceability",
                "cad_connection_all_records_have_mechanical_envelope",
            ): traceability_summary.get("cad_connection_all_records_have_mechanical_envelope"),
            (
                "kicad_cad_traceability",
                "cad_connection_mechanical_envelope_release_credit",
            ): traceability_summary.get("cad_connection_mechanical_envelope_release_credit"),
            (
                "kicad_cad_traceability",
                "cad_connection_supplier_release_required_count",
            ): traceability_summary.get("cad_connection_supplier_release_required_count"),
            ("kicad_cad_traceability", "incomplete_footprint_count"): traceability_summary.get(
                "incomplete_footprint_count"
            ),
            ("kicad_cad_traceability", "incomplete_cad_connection_count"): traceability_summary.get(
                "incomplete_cad_connection_count"
            ),
            (
                "component_model_manifest_summary",
                "component_model_count",
            ): component_manifest_source.get("component_model_count"),
            (
                "component_model_manifest_summary",
                "supplier_approved_model_count",
            ): component_manifest_source.get("supplier_approved_model_count"),
            (
                "component_model_manifest_summary",
                "total_electrical_pad_count",
            ): component_package_summary.get("total_electrical_pad_count"),
            (
                "component_model_manifest_summary",
                "total_mechanical_pad_count",
            ): component_package_summary.get("total_mechanical_pad_count"),
            (
                "component_model_manifest_summary",
                "total_pad_visual_count",
            ): component_package_summary.get("total_pad_visual_count"),
            (
                "component_model_manifest_summary",
                "pinout_bound_model_count",
            ): component_terminal_summary.get("pinout_bound_model_count"),
            (
                "component_model_manifest_summary",
                "support_pattern_model_count",
            ): component_terminal_summary.get("support_pattern_model_count"),
            (
                "component_model_manifest_summary",
                "pattern_bound_model_count",
            ): component_terminal_summary.get("pattern_bound_model_count"),
            (
                "component_model_manifest_summary",
                "terminal_contract_bound_model_count",
            ): component_terminal_summary.get("terminal_contract_bound_model_count"),
            (
                "component_model_manifest_summary",
                "models_with_terminal_contract_or_no_electrical_pads_count",
            ): component_terminal_summary.get(
                "models_with_terminal_contract_or_no_electrical_pads_count"
            ),
            (
                "component_model_manifest_summary",
                "total_pad_contract_visual_count",
            ): component_terminal_summary.get("total_pad_contract_visual_count"),
            (
                "component_model_manifest_summary",
                "uncovered_pad_visual_count",
            ): component_terminal_summary.get("uncovered_pad_visual_count"),
            (
                "component_model_manifest_summary",
                "non_signal_pad_contract_count",
            ): component_terminal_summary.get("non_signal_pad_contract_count"),
            (
                "component_model_manifest_summary",
                "models_with_non_signal_pad_contract_count",
            ): component_terminal_summary.get("models_with_non_signal_pad_contract_count"),
            (
                "component_model_manifest_summary",
                "npth_mechanical_feature_contract_count",
            ): component_terminal_summary.get("npth_mechanical_feature_contract_count"),
            (
                "component_model_manifest_summary",
                "models_with_npth_mechanical_feature_contract_count",
            ): component_terminal_summary.get("models_with_npth_mechanical_feature_contract_count"),
            (
                "component_model_manifest_summary",
                "local_discrete_step_file_count",
            ): sum(1 for model in component_models_source if model.get("local_discrete_step_file")),
            (
                "component_model_manifest_summary",
                "local_discrete_step_imported_solid_count",
            ): sum(
                1
                for model in component_models_source
                if model.get("local_discrete_step_imported_as_solid") is True
            ),
            (
                "component_model_manifest_summary",
                "local_discrete_step_bbox_match_count",
            ): sum(
                1
                for model in component_models_source
                if model.get("local_discrete_step_bbox_matches_envelope") is True
            ),
            (
                "component_model_manifest_summary",
                "local_step_bound_model_count",
            ): sum(1 for model in component_models_source if model.get("local_step_bound") is True),
            ("component_model_manifest_summary", "component_model_record_count"): len(
                component_models_source
            ),
            (
                "component_model_manifest_summary",
                "component_model_record_reference_count",
            ): len({str(model.get("reference", "")) for model in component_models_source}),
            (
                "component_model_directory_summary",
                "model_record_count",
            ): component_dir_manifest_source.get("model_record_count"),
            (
                "component_model_directory_summary",
                "component_model_count",
            ): component_dir_manifest_source.get("component_model_count"),
            (
                "component_model_directory_summary",
                "supplier_approved_model_count",
            ): component_dir_manifest_source.get("supplier_approved_model_count"),
            (
                "component_model_directory_summary",
                "pinout_bound_model_record_count",
            ): component_dir_manifest_source.get("pinout_bound_model_record_count"),
            (
                "component_model_directory_summary",
                "support_pattern_model_record_count",
            ): component_dir_manifest_source.get("support_pattern_model_record_count"),
            (
                "component_model_directory_summary",
                "pattern_bound_model_record_count",
            ): component_dir_manifest_source.get("pattern_bound_model_record_count"),
            (
                "component_model_directory_summary",
                "terminal_contract_model_record_count",
            ): component_dir_manifest_source.get("terminal_contract_model_record_count"),
            (
                "component_model_directory_summary",
                "terminal_contract_bound_model_record_count",
            ): component_dir_manifest_source.get("terminal_contract_bound_model_record_count"),
            (
                "component_model_directory_summary",
                "terminal_contract_total_count",
            ): component_dir_manifest_source.get("terminal_contract_total_count"),
            (
                "component_model_directory_summary",
                "total_pad_contract_visual_count",
            ): component_dir_manifest_source.get("total_pad_contract_visual_count"),
            (
                "component_model_directory_summary",
                "uncovered_pad_visual_count",
            ): component_dir_manifest_source.get("uncovered_pad_visual_count"),
            (
                "component_model_directory_summary",
                "non_signal_pad_contract_total_count",
            ): component_dir_manifest_source.get("non_signal_pad_contract_total_count"),
            (
                "component_model_directory_summary",
                "local_discrete_step_file_count",
            ): component_dir_manifest_source.get("local_discrete_step_file_count"),
            (
                "component_model_directory_summary",
                "local_discrete_step_imported_solid_count",
            ): component_dir_manifest_source.get("local_discrete_step_imported_solid_count"),
            (
                "component_model_directory_summary",
                "local_discrete_step_bbox_match_count",
            ): component_dir_manifest_source.get("local_discrete_step_bbox_match_count"),
            (
                "component_model_directory_summary",
                "local_step_bound_model_record_count",
            ): component_dir_manifest_source.get("local_step_bound_model_record_count"),
            (
                "component_model_directory_summary",
                "npth_mechanical_feature_contract_total_count",
            ): component_dir_manifest_source.get("npth_mechanical_feature_contract_total_count"),
            (
                "component_model_directory_summary",
                "models_with_npth_mechanical_feature_contract_count",
            ): component_dir_manifest_source.get(
                "models_with_npth_mechanical_feature_contract_count"
            ),
            (
                "component_model_directory_summary",
                "missing_supplier_discrete_model_count",
            ): component_dir_manifest_source.get("missing_supplier_discrete_model_count"),
            (
                "component_model_directory_summary",
                "supplier_step_intake_placeholder_count",
            ): component_dir_manifest_source.get("supplier_step_intake_placeholder_count"),
            (
                "component_model_directory_summary",
                "supplier_step_intake_local_surrogate_count",
            ): component_dir_manifest_source.get("supplier_step_intake_local_surrogate_count"),
            (
                "component_model_directory_summary",
                "supplier_step_intake_missing_count",
            ): component_dir_manifest_source.get("supplier_step_intake_missing_count"),
            (
                "component_model_directory_summary",
                "supplier_step_intake_not_applicable_count",
            ): component_dir_manifest_source.get("supplier_step_intake_not_applicable_count"),
            (
                "component_model_directory_summary",
                "supplier_step_intake_release_candidate_count",
            ): component_dir_manifest_source.get("supplier_step_intake_release_candidate_count"),
        }
        for count_key, expected_count in expected_candidate_counts.items():
            if isinstance(count_key, tuple):
                section, field = count_key
                actual = candidate_context[section].get(field)
                label = f"{section}.{field}"
            else:
                actual = candidate_context.get(count_key)
                label = count_key
            if actual != expected_count:
                contract_mismatches.append(f"candidate context count stale: {label}")
        expected_route_records = [
            {
                "index": index,
                "route_id": str(segment.get("route_id", "")),
                "net": str(segment.get("net", "")),
                "layer": str(segment.get("layer", "")),
                "width_mm": segment.get("width_mm"),
                "start_mm": segment.get("start_mm", {}),
                "end_mm": segment.get("end_mm", {}),
                "route_classes": segment.get("route_classes", []),
                "source_domains": segment.get("source_domains", []),
                "controlled_impedance_targets_ohm": segment.get(
                    "controlled_impedance_targets_ohm", []
                ),
            }
            for index, segment in enumerate(step_intake.get("segments", []), start=1)
            if isinstance(segment, dict)
        ]
        expected_via_records = [
            {
                "index": index,
                "net": str(via.get("net", "")),
                "at_mm": via.get("at_mm", {}),
                "size_mm": via.get("size_mm"),
                "drill_mm": via.get("drill_mm"),
                "layers": via.get("layers", []),
            }
            for index, via in enumerate(step_intake.get("vias", []), start=1)
            if isinstance(via, dict)
        ]
        expected_zone_records = [
            {
                "index": zone.get("index", index),
                "name": str(zone.get("name", "")),
                "net": str(zone.get("net", "")),
                "layers": zone.get("layers", []),
                "polygon_point_count": int(zone.get("polygon_point_count", 0) or 0),
                "filled_polygon_count": int(zone.get("filled_polygon_count", 0) or 0),
                "bbox_mm": zone.get("bbox_mm", {}),
            }
            for index, zone in enumerate(step_intake.get("filled_copper_zones", []), start=1)
            if isinstance(zone, dict)
        ]
        if candidate_visual.get("route_visual_records") != expected_route_records:
            contract_mismatches.append("candidate routed STEP route visual records stale")
        if candidate_visual.get("via_visual_records") != expected_via_records:
            contract_mismatches.append("candidate routed STEP via visual records stale")
        if candidate_visual.get("filled_copper_zone_records") != expected_zone_records:
            contract_mismatches.append("candidate routed STEP filled-zone records stale")
        route_layer_counts = candidate_visual.get("route_visual_layer_counts")
        if not isinstance(route_layer_counts, dict) or sum(route_layer_counts.values()) != 306:
            contract_mismatches.append("candidate route layer visual counts stale")
        route_class_counts = candidate_visual.get("route_visual_route_class_counts")
        if not isinstance(route_class_counts, dict) or sum(route_class_counts.values()) < 306:
            contract_mismatches.append("candidate route class visual counts stale")
        route_source_counts = candidate_visual.get("route_visual_source_domain_counts")
        if not isinstance(route_source_counts, dict) or sum(route_source_counts.values()) < 306:
            contract_mismatches.append("candidate route source-domain visual counts stale")
        if not ZONE_FILL_REPORT.is_file():
            contract_mismatches.append("zone-fill candidate report missing")
        else:
            zone_report = load_json_mapping(ZONE_FILL_REPORT)
            zone_summary = zone_report.get("zone_summary")
            zone_records = zone_report.get("zone_records")
            if zone_report.get("schema") != "eliza.e1_phone_zone_fill_report_candidate.v1":
                contract_mismatches.append("zone-fill candidate report schema stale")
            if not isinstance(zone_summary, dict):
                contract_mismatches.append("zone-fill candidate summary missing")
            else:
                expected_zone_summary = {
                    "zone_count": 13,
                    "keepout_zone_count": 11,
                    "copper_zone_count": 2,
                    "filled_zone_count": 2,
                    "unfilled_copper_zone_count": 0,
                    "local_filled_copper_zones_present": True,
                    "local_filled_copper_zones_release_credit": False,
                    "release_zone_fill_complete": False,
                    "all_zones_have_polygon_points": True,
                    "all_keepouts_have_copperpour_blocked": True,
                }
                for key, expected in expected_zone_summary.items():
                    if zone_summary.get(key) != expected:
                        contract_mismatches.append(f"zone-fill candidate summary stale: {key}")
            if not isinstance(zone_records, list) or len(zone_records) != 13:
                contract_mismatches.append("zone-fill candidate records stale")
            else:
                keepout_records = [
                    row for row in zone_records if isinstance(row, dict) and row.get("is_keepout")
                ]
                copper_records = [
                    row
                    for row in zone_records
                    if isinstance(row, dict) and not row.get("is_keepout")
                ]
                if (
                    len(keepout_records) != 11
                    or len(copper_records) != 2
                    or not all(
                        int(row.get("polygon_point_count", 0) or 0) >= 4
                        and int(row.get("filled_polygon_count", 0) or 0) == 0
                        and isinstance(row.get("bbox_mm"), dict)
                        for row in keepout_records
                    )
                    or not all(
                        str(row.get("net_name", "")) == "GND"
                        and int(row.get("polygon_point_count", 0) or 0) >= 4
                        and int(row.get("filled_polygon_count", 0) or 0) > 0
                        and isinstance(row.get("bbox_mm"), dict)
                        for row in copper_records
                    )
                ):
                    contract_mismatches.append("zone-fill candidate record content stale")
        if (
            candidate_context["cad_connection_coverage"].get(
                "assembly_manifest_missing_connection_solid_step_part_names"
            )
            != []
        ):
            contract_mismatches.append("candidate context assembly missing-part list stale")
        expected_supplier_lane_counts = {
            "audio_speaker_microphone_flexes": 8,
            "battery_pack": 2,
            "board_support_passives_mechanicals": 42,
            "cellular": 8,
            "charger_power_path": 1,
            "display_touch": 3,
            "front_camera": 2,
            "pmic": 9,
            "rear_camera": 2,
            "side_buttons": 3,
            "top_bottom_interconnect": 2,
            "usb_c_receptacle_evt0": 1,
            "usb_pd_controller": 1,
            "wifi_bluetooth": 5,
        }
        if (
            candidate_context["component_model_directory_summary"].get(
                "supplier_step_intake_lane_counts"
            )
            != expected_supplier_lane_counts
        ):
            contract_mismatches.append("candidate context supplier STEP intake lane counts stale")
        for section, field in [
            ("cad_connection_coverage", "release_credit"),
            ("kicad_cad_traceability", "release_credit"),
            ("kicad_cad_traceability", "cad_connection_mechanical_envelope_release_credit"),
            ("component_model_manifest_summary", "release_allowed"),
            ("component_model_directory_summary", "release_allowed"),
            ("instance_pin_step_disposition", "release_credit"),
        ]:
            if candidate_context[section].get(field) is not False:
                contract_mismatches.append(
                    f"candidate context unexpectedly grants release: {section}.{field}"
                )
        for section, field in [
            (
                "kicad_cad_traceability",
                "all_pinout_bound_footprints_have_terminal_contract",
            ),
            (
                "kicad_cad_traceability",
                "cad_connection_all_represented_routes_have_layer_source_and_class",
            ),
            (
                "kicad_cad_traceability",
                "cad_connection_all_records_have_mechanical_envelope",
            ),
            ("component_model_manifest_summary", "all_model_pad_counts_match_visuals"),
            ("component_model_manifest_summary", "all_models_have_visual_package_class"),
            (
                "component_model_manifest_summary",
                "all_package_visual_counts_match_step_intake",
            ),
            (
                "component_model_manifest_summary",
                "all_pinout_bound_models_have_terminal_contract",
            ),
            (
                "component_model_manifest_summary",
                "all_pinout_bound_model_contracts_match_pad_visuals",
            ),
            (
                "component_model_manifest_summary",
                "all_support_pattern_models_have_explicit_provenance",
            ),
            (
                "component_model_manifest_summary",
                "all_models_have_pattern_binding",
            ),
            (
                "component_model_manifest_summary",
                "all_models_have_terminal_contract_binding",
            ),
            (
                "component_model_manifest_summary",
                "all_model_pad_visuals_have_contract",
            ),
            (
                "component_model_manifest_summary",
                "all_non_signal_pad_contracts_match_pad_visuals",
            ),
            (
                "component_model_manifest_summary",
                "all_npth_mechanical_features_have_contract",
            ),
            (
                "component_model_manifest_summary",
                "all_models_have_local_discrete_step_file",
            ),
            (
                "component_model_manifest_summary",
                "all_models_have_local_step_binding",
            ),
            (
                "component_model_manifest_summary",
                "all_local_discrete_step_hashes_match_files",
            ),
            (
                "component_model_manifest_summary",
                "all_local_discrete_step_sizes_match_files",
            ),
            (
                "component_model_manifest_summary",
                "all_local_discrete_steps_import_as_solids",
            ),
            (
                "component_model_manifest_summary",
                "all_local_discrete_step_bboxes_match_envelopes",
            ),
            (
                "component_model_manifest_summary",
                "all_component_model_records_have_local_step",
            ),
            (
                "component_model_manifest_summary",
                "all_component_model_records_have_step_hash",
            ),
            (
                "component_model_manifest_summary",
                "all_component_model_records_import_as_solids",
            ),
            (
                "component_model_manifest_summary",
                "all_component_model_records_match_step_envelope",
            ),
            (
                "component_model_manifest_summary",
                "all_component_model_records_release_credit_false",
            ),
            (
                "cad_connection_coverage",
                "all_connection_records_have_represented_nets",
            ),
            (
                "cad_connection_coverage",
                "all_connection_represented_nets_match_routed_nets",
            ),
            (
                "cad_connection_coverage",
                "all_represented_routes_have_layer_source_and_class",
            ),
            (
                "instance_pin_step_disposition",
                "all_records_local_review_pass",
            ),
            (
                "instance_pin_step_disposition",
                "all_records_have_local_step",
            ),
            (
                "instance_pin_step_disposition",
                "all_records_local_step_hashes_match",
            ),
            (
                "instance_pin_step_disposition",
                "all_records_release_credit_false",
            ),
            ("component_model_directory_summary", "all_model_records_present"),
            (
                "component_model_directory_summary",
                "all_model_records_source_routed_step_bound",
            ),
            (
                "component_model_directory_summary",
                "all_model_records_have_combined_step_locator",
            ),
            (
                "component_model_directory_summary",
                "all_model_records_have_local_discrete_step_file",
            ),
            (
                "component_model_directory_summary",
                "all_model_records_have_local_step_binding",
            ),
            (
                "component_model_directory_summary",
                "all_local_discrete_step_files_import_as_solids",
            ),
            (
                "component_model_directory_summary",
                "all_local_discrete_step_bboxes_match_envelopes",
            ),
            (
                "component_model_directory_summary",
                "all_model_records_have_expected_supplier_step_file",
            ),
            ("component_model_directory_summary", "all_records_release_credit_false"),
            (
                "component_model_directory_summary",
                "all_pinout_bound_records_have_terminal_contract",
            ),
            (
                "component_model_directory_summary",
                "all_support_pattern_records_have_explicit_provenance",
            ),
            (
                "component_model_directory_summary",
                "all_model_records_have_pattern_binding",
            ),
            (
                "component_model_directory_summary",
                "all_model_records_have_terminal_contract_binding",
            ),
            (
                "component_model_directory_summary",
                "all_terminal_contracts_match_pad_visuals",
            ),
            (
                "component_model_directory_summary",
                "all_non_signal_pad_contracts_match_pad_visuals",
            ),
            (
                "component_model_directory_summary",
                "all_npth_mechanical_features_have_contract",
            ),
        ]:
            if candidate_context[section].get(field) is not True:
                contract_mismatches.append(
                    f"candidate context traceability flag failed: {section}.{field}"
                )
        routed_step_path = repo_path(
            "board/kicad/e1-phone/production/step/routed-board-with-components.step"
        )
        component_model_dir = repo_path(
            str(candidate_context.get("component_model_directory") or "")
        )
        component_manifest_path = repo_path(
            str(candidate_context.get("component_model_manifest") or "")
        )
        if not routed_step_path.is_file():
            contract_mismatches.append("candidate routed STEP source missing")
        if not component_manifest_path.is_file():
            contract_mismatches.append("component 3D model manifest missing")
        if not component_model_dir.is_dir():
            contract_mismatches.append("component model directory missing")
        component_manifest_models_by_reference: dict[str, dict[str, Any]] = {}
        if component_manifest_path.is_file():
            component_manifest = load_yaml_mapping(component_manifest_path)
            models = component_manifest.get("models")
            if not isinstance(models, list):
                contract_mismatches.append("component 3D model manifest models missing")
            else:
                expected_component_model_records = [
                    compact_component_model_record(model)
                    for model in sorted(models, key=lambda item: str(item.get("reference", "")))
                    if isinstance(model, dict)
                ]
                if (
                    candidate_models.get("component_model_record_manifest")
                    != expected_component_model_records
                ):
                    contract_mismatches.append("candidate component model record manifest stale")
                for index, model in enumerate(models):
                    if not isinstance(model, dict):
                        contract_mismatches.append(
                            f"component 3D model manifest model not mapping: {index}"
                        )
                        continue
                    reference = str(model.get("reference") or index)
                    component_manifest_models_by_reference[reference] = model
                    local_step = model.get("local_discrete_step_file")
                    local_step_path = ROOT / str(local_step or "")
                    if not local_step or not local_step_path.is_file():
                        contract_mismatches.append(
                            f"component 3D manifest local discrete STEP missing: {reference}"
                        )
                    elif model.get("local_discrete_step_sha256") != file_sha256(local_step_path):
                        contract_mismatches.append(
                            f"component 3D manifest local discrete STEP hash stale: {reference}"
                        )
                    elif model.get("local_discrete_step_bytes") != local_step_path.stat().st_size:
                        contract_mismatches.append(
                            f"component 3D manifest local discrete STEP size stale: {reference}"
                        )
                    if model.get("local_discrete_step_import_status") != "pass":
                        contract_mismatches.append(
                            f"component 3D manifest local discrete STEP import failed: {reference}"
                        )
                    if model.get("local_discrete_step_solid_type") != "Solid":
                        contract_mismatches.append(
                            f"component 3D manifest local discrete STEP not solid: {reference}"
                        )
                    if model.get("local_discrete_step_imported_as_solid") is not True:
                        contract_mismatches.append(
                            "component 3D manifest local discrete STEP imported-as-solid "
                            f"flag stale: {reference}"
                        )
                    if model.get("local_discrete_step_bbox_matches_envelope") is not True:
                        contract_mismatches.append(
                            f"component 3D manifest local discrete STEP bbox mismatch: {reference}"
                        )
        if routed_step_path.is_file() and component_model_dir.is_dir():
            routed_step_hash = file_sha256(routed_step_path)
            routed_step_bytes = routed_step_path.stat().st_size
            directory_manifest_path = component_model_dir / "release-manifest.yaml"
            if not directory_manifest_path.is_file():
                contract_mismatches.append("component model directory manifest missing")
            else:
                directory_manifest = load_yaml_mapping(directory_manifest_path)
                if directory_manifest.get("source_routed_step") != rel(routed_step_path):
                    contract_mismatches.append("component model directory source STEP stale")
                if directory_manifest.get("source_routed_step_sha256") != routed_step_hash:
                    contract_mismatches.append("component model directory source STEP hash stale")
                if directory_manifest.get("source_routed_step_bytes") != routed_step_bytes:
                    contract_mismatches.append("component model directory source STEP size stale")
                if directory_manifest.get("all_model_records_source_routed_step_bound") is not True:
                    contract_mismatches.append("component model records not source STEP bound")
                model_records = directory_manifest.get("model_records")
                if not isinstance(model_records, list):
                    contract_mismatches.append("component model directory records missing")
                else:
                    for index, row in enumerate(model_records):
                        if not isinstance(row, dict):
                            contract_mismatches.append(
                                f"component model directory record not mapping: {index}"
                            )
                            continue
                        reference = str(row.get("reference") or index)
                        metadata = row.get("metadata")
                        record_path = component_model_dir / str(metadata or "")
                        if not metadata or not record_path.is_file():
                            contract_mismatches.append(
                                f"component model local record missing: {reference}"
                            )
                            continue
                        if row.get("metadata_sha256") != file_sha256(record_path):
                            contract_mismatches.append(
                                f"component model local record metadata hash stale: {reference}"
                            )
                        if row.get("source_routed_step") != rel(routed_step_path):
                            contract_mismatches.append(
                                f"component model directory row source STEP stale: {reference}"
                            )
                        if row.get("source_routed_step_sha256") != routed_step_hash:
                            contract_mismatches.append(
                                f"component model directory row source STEP hash stale: {reference}"
                            )
                        if row.get("source_routed_step_bytes") != routed_step_bytes:
                            contract_mismatches.append(
                                f"component model directory row source STEP size stale: {reference}"
                            )
                        if not row.get("combined_step_assembly_name"):
                            contract_mismatches.append(
                                f"component model directory row missing STEP locator: {reference}"
                            )
                        if not row.get("expected_supplier_step_file"):
                            contract_mismatches.append(
                                f"component model directory row missing expected supplier STEP: {reference}"
                            )
                        supplier_lane = row.get("supplier_sourcing_lane")
                        if not supplier_lane:
                            contract_mismatches.append(
                                f"component model directory row missing supplier lane: {reference}"
                            )
                        expected_supplier_status = (
                            "not_applicable_board_level_support_pattern"
                            if supplier_lane == "board_support_passives_mechanicals"
                            else "present_local_surrogate_step_not_supplier_approved"
                        )
                        if row.get("supplier_step_intake_status") != expected_supplier_status:
                            contract_mismatches.append(
                                f"component model directory row supplier STEP intake status stale: {reference}"
                            )
                        if row.get("supplier_step_intake_release_credit") is not False:
                            contract_mismatches.append(
                                f"component model directory row supplier STEP grants release: {reference}"
                            )
                        supplier_step_file = row.get("supplier_step_intake_file")
                        if (
                            expected_supplier_status
                            == "present_local_surrogate_step_not_supplier_approved"
                        ):
                            supplier_step_path = ROOT / str(supplier_step_file or "")
                            if not supplier_step_file or not supplier_step_path.is_file():
                                contract_mismatches.append(
                                    f"component model supplier STEP intake missing: {reference}"
                                )
                            else:
                                if row.get("supplier_step_intake_sha256") != file_sha256(
                                    supplier_step_path
                                ):
                                    contract_mismatches.append(
                                        f"component model supplier STEP intake hash stale: {reference}"
                                    )
                                if (
                                    row.get("supplier_step_intake_bytes")
                                    != supplier_step_path.stat().st_size
                                ):
                                    contract_mismatches.append(
                                        f"component model supplier STEP intake size stale: {reference}"
                                    )
                        elif supplier_step_file:
                            contract_mismatches.append(
                                f"component model support record should not bind supplier STEP intake: {reference}"
                            )
                        local_step = row.get("local_discrete_step_file")
                        local_step_path = ROOT / str(local_step or "")
                        if not local_step or not local_step_path.is_file():
                            contract_mismatches.append(
                                f"component model local discrete STEP missing: {reference}"
                            )
                        elif row.get("local_discrete_step_sha256") != file_sha256(local_step_path):
                            contract_mismatches.append(
                                f"component model local discrete STEP hash stale: {reference}"
                            )
                        elif row.get("local_discrete_step_bytes") != local_step_path.stat().st_size:
                            contract_mismatches.append(
                                f"component model local discrete STEP size stale: {reference}"
                            )
                        if row.get("local_discrete_step_import_status") != "pass":
                            contract_mismatches.append(
                                f"component model local discrete STEP import failed: {reference}"
                            )
                        if row.get("local_discrete_step_solid_type") != "Solid":
                            contract_mismatches.append(
                                f"component model local discrete STEP not solid: {reference}"
                            )
                        if row.get("local_discrete_step_bbox_matches_envelope") is not True:
                            contract_mismatches.append(
                                f"component model local discrete STEP bbox mismatch: {reference}"
                            )
                        top_model = component_manifest_models_by_reference.get(reference)
                        if not top_model:
                            contract_mismatches.append(
                                f"component 3D manifest missing directory reference: {reference}"
                            )
                        else:
                            for field in [
                                "local_discrete_step_file",
                                "local_discrete_step_sha256",
                                "local_discrete_step_bytes",
                                "local_discrete_step_status",
                                "local_discrete_step_import_status",
                                "local_discrete_step_solid_type",
                                "local_discrete_step_imported_as_solid",
                                "local_discrete_step_bbox_mm",
                                "local_discrete_step_expected_bbox_mm",
                                "local_discrete_step_bbox_matches_envelope",
                            ]:
                                if top_model.get(field) != row.get(field):
                                    contract_mismatches.append(
                                        "component 3D manifest local STEP binding "
                                        f"diverges from directory: {reference}.{field}"
                                    )
                        record = json.loads(record_path.read_text(encoding="utf-8"))
                        if record.get("source_routed_step") != rel(routed_step_path):
                            contract_mismatches.append(
                                f"component model local record source STEP stale: {reference}"
                            )
                        if record.get("source_routed_step_sha256") != routed_step_hash:
                            contract_mismatches.append(
                                f"component model local record source STEP hash stale: {reference}"
                            )
                        if record.get("source_routed_step_bytes") != routed_step_bytes:
                            contract_mismatches.append(
                                f"component model local record source STEP size stale: {reference}"
                            )
                        if record.get("combined_step_assembly_name") != row.get(
                            "combined_step_assembly_name"
                        ):
                            contract_mismatches.append(
                                f"component model local record STEP locator stale: {reference}"
                            )
                        if record.get("expected_supplier_step_file") != row.get(
                            "expected_supplier_step_file"
                        ):
                            contract_mismatches.append(
                                f"component model local record supplier STEP path stale: {reference}"
                            )
                        for field in [
                            "supplier_sourcing_lane",
                            "supplier_step_intake_file",
                            "supplier_step_intake_status",
                            "supplier_step_intake_release_credit",
                            "supplier_step_intake_sha256",
                            "supplier_step_intake_bytes",
                        ]:
                            if record.get(field) != row.get(field):
                                contract_mismatches.append(
                                    f"component model local record supplier intake stale: {reference}.{field}"
                                )
                        if record.get("local_discrete_step_file") != row.get(
                            "local_discrete_step_file"
                        ):
                            contract_mismatches.append(
                                f"component model local record discrete STEP path stale: {reference}"
                            )
                        if record.get("local_discrete_step_sha256") != row.get(
                            "local_discrete_step_sha256"
                        ):
                            contract_mismatches.append(
                                f"component model local record discrete STEP hash stale: {reference}"
                            )
                        if record.get("local_discrete_step_bytes") != row.get(
                            "local_discrete_step_bytes"
                        ):
                            contract_mismatches.append(
                                f"component model local record discrete STEP size stale: {reference}"
                            )
                        if record.get("local_discrete_step_import_status") != row.get(
                            "local_discrete_step_import_status"
                        ):
                            contract_mismatches.append(
                                f"component model local record discrete STEP import status stale: {reference}"
                            )
                        if record.get("local_discrete_step_solid_type") != row.get(
                            "local_discrete_step_solid_type"
                        ):
                            contract_mismatches.append(
                                f"component model local record discrete STEP solid type stale: {reference}"
                            )
                        if record.get("local_discrete_step_imported_as_solid") != row.get(
                            "local_discrete_step_imported_as_solid"
                        ):
                            contract_mismatches.append(
                                "component model local record discrete STEP imported-as-solid "
                                f"flag stale: {reference}"
                            )
                        if record.get("local_discrete_step_bbox_mm") != row.get(
                            "local_discrete_step_bbox_mm"
                        ):
                            contract_mismatches.append(
                                f"component model local record discrete STEP bbox stale: {reference}"
                            )
                        if record.get("local_discrete_step_bbox_matches_envelope") != row.get(
                            "local_discrete_step_bbox_matches_envelope"
                        ):
                            contract_mismatches.append(
                                f"component model local record discrete STEP bbox flag stale: {reference}"
                            )
                        if record.get("release_credit") is not False:
                            contract_mismatches.append(
                                f"component model local record grants release credit: {reference}"
                            )
                        if record.get("release_allowed") is not False:
                            contract_mismatches.append(
                                f"component model local record grants release: {reference}"
                            )
                    if not COMPONENT_3D_BINDING_REPORT.is_file():
                        contract_mismatches.append("component 3D binding report missing")
                    if not COMPONENT_3D_BINDING_MATRIX.is_file():
                        contract_mismatches.append("component 3D binding matrix missing")
                    if (
                        COMPONENT_3D_BINDING_REPORT.is_file()
                        and COMPONENT_3D_BINDING_MATRIX.is_file()
                    ):
                        binding_report = load_yaml_mapping(COMPONENT_3D_BINDING_REPORT)
                        with COMPONENT_3D_BINDING_MATRIX.open(
                            newline="", encoding="utf-8"
                        ) as handle:
                            binding_rows = list(csv.DictReader(handle))
                        if binding_report.get("schema") != (
                            "eliza.e1_phone_component_3d_binding_gap_matrix.v1"
                        ):
                            contract_mismatches.append("component 3D binding schema stale")
                        if binding_report.get("row_count") != len(model_records):
                            contract_mismatches.append("component 3D binding row count stale")
                        if len(binding_rows) != len(model_records):
                            contract_mismatches.append("component 3D binding CSV row count stale")
                        if binding_report.get("csv_matrix") != rel(COMPONENT_3D_BINDING_MATRIX):
                            contract_mismatches.append("component 3D binding CSV path stale")
                        if binding_report.get("csv_matrix_sha256") != file_sha256(
                            COMPONENT_3D_BINDING_MATRIX
                        ):
                            contract_mismatches.append("component 3D binding CSV hash stale")
                        if (
                            binding_report.get("csv_matrix_bytes")
                            != COMPONENT_3D_BINDING_MATRIX.stat().st_size
                        ):
                            contract_mismatches.append("component 3D binding CSV size stale")
                        if (
                            binding_report.get("supplier_lane_counts")
                            != expected_supplier_lane_counts
                        ):
                            contract_mismatches.append(
                                "component 3D binding supplier lane counts stale"
                            )
                        expected_status_counts = {
                            "not_applicable_board_level_support_pattern": 42,
                            "present_local_surrogate_step_not_supplier_approved": 47,
                        }
                        if (
                            binding_report.get("supplier_step_intake_status_counts")
                            != expected_status_counts
                        ):
                            contract_mismatches.append(
                                "component 3D binding supplier intake status counts stale"
                            )
                        for field, expected in [
                            ("local_discrete_step_file_count", 89),
                            ("local_discrete_step_import_pass_count", 89),
                            ("local_discrete_step_imported_solid_count", 89),
                            ("local_discrete_step_bbox_match_count", 89),
                            ("supplier_step_intake_placeholder_count", 0),
                            ("supplier_step_intake_local_surrogate_count", 47),
                            ("supplier_step_intake_not_applicable_count", 42),
                            ("supplier_step_intake_release_candidate_count", 0),
                        ]:
                            if binding_report.get(field) != expected:
                                contract_mismatches.append(
                                    f"component 3D binding summary stale: {field}"
                                )
                        if binding_report.get("all_rows_release_credit_false") is not True:
                            contract_mismatches.append(
                                "component 3D binding row release credit flag stale"
                            )
                        if binding_report.get("all_rows_release_allowed_false") is not True:
                            contract_mismatches.append(
                                "component 3D binding row release allowed flag stale"
                            )
                        rows_by_ref = {
                            row.get("reference"): row
                            for row in binding_rows
                            if row.get("reference")
                        }
                        if len(rows_by_ref) != len(model_records):
                            contract_mismatches.append(
                                "component 3D binding CSV references not unique"
                            )
                        for row in model_records:
                            reference = str(row.get("reference") or "")
                            csv_row = rows_by_ref.get(reference)
                            if not csv_row:
                                contract_mismatches.append(
                                    f"component 3D binding row missing: {reference}"
                                )
                                continue
                            for field in [
                                "footprint",
                                "supplier_sourcing_lane",
                                "combined_step_assembly_name",
                                "local_discrete_step_file",
                                "local_discrete_step_sha256",
                                "local_discrete_step_import_status",
                                "expected_supplier_step_file",
                                "expected_supplier_brep_or_step_status",
                                "supplier_step_intake_file",
                                "supplier_step_intake_status",
                                "supplier_step_intake_sha256",
                            ]:
                                if str(row.get(field) or "") != str(csv_row.get(field) or ""):
                                    contract_mismatches.append(
                                        f"component 3D binding CSV field stale: {reference}.{field}"
                                    )
                            if str(
                                row.get("local_discrete_step_imported_as_solid") is True
                            ).lower() != str(
                                csv_row.get("local_discrete_step_imported_as_solid") or ""
                            ):
                                contract_mismatches.append(
                                    "component 3D binding CSV field stale: "
                                    f"{reference}.local_discrete_step_imported_as_solid"
                                )
                            for field in [
                                "local_discrete_step_bytes",
                                "supplier_step_intake_bytes",
                                "terminal_contract_count",
                            ]:
                                if str(int(row.get(field, 0) or 0)) != str(
                                    csv_row.get(field) or ""
                                ):
                                    contract_mismatches.append(
                                        f"component 3D binding CSV numeric field stale: {reference}.{field}"
                                    )
                            if csv_row.get("release_credit") != "false":
                                contract_mismatches.append(
                                    f"component 3D binding CSV grants release credit: {reference}"
                                )
                            if csv_row.get("release_allowed") != "false":
                                contract_mismatches.append(
                                    f"component 3D binding CSV grants release: {reference}"
                                )
        production_outputs = collect_required_outputs(
            matrix,
            include_present_validation_artifacts=False,
        )
        outputs = collect_required_outputs(matrix)
        inventory_mismatches: list[str] = list(contract_mismatches)
        if len(production_outputs) != summary.get("required_output_path_count"):
            inventory_mismatches.append(
                "required output inventory count mismatch: "
                f"collected={len(production_outputs)} summary={summary.get('required_output_path_count')}"
            )

        blocked: list[tuple[str, list[str]]] = []
        present = 0
        content_valid = 0
        candidate_manifest = load_candidate_manifest()
        attach_repo_generation_context(outputs, candidate_manifest)
        for path_text in sorted(outputs):
            if repo_path(path_text).exists():
                present += 1
            failures = content_failures(path_text)
            if failures:
                blocked.append((path_text, failures))
            else:
                content_valid += 1

        missing_categories = int(summary.get("missing_validation_evidence_category_count") or 0)
        missing_outputs = int(summary.get("missing_required_output_path_count") or 0)
        candidate_present_blocked_count = int(
            summary.get("candidate_present_blocked_required_output_path_count") or 0
        )
        truly_missing_count = int(summary.get("truly_missing_required_output_path_count") or 0)
        domains_missing_outputs = int(summary.get("domains_with_missing_production_outputs") or 0)
        domains_missing_nets = int(summary.get("domains_with_missing_exact_nets") or 0)
        coverage = candidate_coverage(outputs, blocked, candidate_manifest)
        routed_execution_packets = routed_execution_packet_inventory(outputs, blocked)
        blocker_categories = routed_output_blocker_categories(outputs, blocked)
        generation_summary = repo_generation_summary(outputs, blocked)
    except Exception as exc:  # noqa: BLE001 - fail-closed release gate error surface.
        write_report(blocked_contract_error_report(str(exc)), args.report)
        print(f"STATUS: BLOCKED E1 phone routed-output content contract: {exc}")
        return 2

    if (
        blocked
        or inventory_mismatches
        or missing_categories
        or missing_outputs
        or domains_missing_outputs
        or domains_missing_nets
    ):
        write_report(
            {
                "schema": "eliza.e1_phone_routed_output_content_report.v1",
                "status": "blocked",
                "release_credit": False,
                "summary": {
                    "release_ready": False,
                    "release_credit": False,
                    "required_paths": len(outputs),
                    "present": present,
                    "content_valid": content_valid,
                    "blocked": len(blocked),
                    "inventory_mismatches": len(inventory_mismatches),
                    "missing_outputs": missing_outputs,
                    "candidate_present_blocked_count": candidate_present_blocked_count,
                    "truly_missing_count": truly_missing_count,
                    "true_missing_generated_output_count": blocker_categories["counts"][
                        "true_missing_generated_outputs"
                    ],
                    "missing_approval_metadata_count": blocker_categories["counts"][
                        "missing_approval_metadata"
                    ],
                    "candidate_present_but_blocked_count": blocker_categories["counts"][
                        "candidate_present_but_blocked"
                    ],
                    "release_credit_false_count": blocker_categories[
                        "release_credit_false_artifacts"
                    ]["count"],
                    "repo_generated_candidate_blocked_count": generation_summary[
                        "repo_generated_candidate_blocked_count"
                    ],
                    "repo_generatable_now_count": generation_summary["repo_generatable_now_count"],
                    "repo_generation_closes_release_blocker_count": generation_summary[
                        "repo_generation_closes_release_blocker_count"
                    ],
                    "external_release_evidence_required_count": generation_summary[
                        "external_release_evidence_required_count"
                    ],
                    "missing_validation_categories": missing_categories,
                    "domains_missing_outputs": domains_missing_outputs,
                    "domains_missing_exact_nets": domains_missing_nets,
                },
                "findings": [
                    {
                        "code": "routed_output_content_blocked",
                        "severity": "blocker",
                        "message": f"{path_text}: {', '.join(failures)}",
                        "evidence": path_text,
                    }
                    for path_text, failures in blocked
                ]
                + [
                    {
                        "code": "routed_output_inventory_count_mismatch",
                        "severity": "blocker",
                        "message": message,
                        "evidence": rel(MATRIX),
                    }
                    for message in inventory_mismatches
                ]
                + [
                    finding
                    for condition, finding in (
                        (
                            missing_outputs,
                            {
                                "code": "routed_output_paths_missing",
                                "severity": "blocker",
                                "message": f"{missing_outputs} required routed output paths are missing",
                                "evidence": rel(MATRIX),
                            },
                        ),
                        (
                            missing_categories,
                            {
                                "code": "routed_validation_categories_missing",
                                "severity": "blocker",
                                "message": f"{missing_categories} validation categories are missing",
                                "evidence": rel(MATRIX),
                            },
                        ),
                        (
                            domains_missing_outputs,
                            {
                                "code": "routed_domains_missing_outputs",
                                "severity": "blocker",
                                "message": f"{domains_missing_outputs} route domains are missing production outputs",
                                "evidence": rel(MATRIX),
                            },
                        ),
                        (
                            domains_missing_nets,
                            {
                                "code": "routed_domains_missing_exact_nets",
                                "severity": "blocker",
                                "message": f"{domains_missing_nets} route domains are missing exact nets",
                                "evidence": rel(MATRIX),
                            },
                        ),
                    )
                    if condition
                ],
                "blocked_evidence_inventory": [
                    unblock_action(path_text, outputs.get(path_text, {}), failures)
                    for path_text, failures in blocked
                ],
                "validation_commands": [VALIDATION_COMMAND],
                "blocker_diagnostics": blocker_diagnostics(outputs, blocked),
                "routed_output_blocker_categories": blocker_categories,
                "repo_generation_summary": generation_summary,
                "routed_execution_packet_inventory": routed_execution_packets,
                "candidate_manifest_coverage": coverage,
                "next_unblock_actions": [
                    unblock_action(path_text, outputs.get(path_text, {}), failures)
                    for path_text, failures in blocked[:20]
                ],
            },
            args.report,
        )
        print(
            "STATUS: BLOCKED E1 phone routed-output content "
            f"paths={len(outputs)} present={present} blocked={len(blocked)} "
            f"content_valid={content_valid} "
            f"inventory_mismatches={len(inventory_mismatches)} "
            f"missing_outputs={missing_outputs} missing_validation_categories={missing_categories} "
            f"candidate_present_blocked={candidate_present_blocked_count} "
            f"truly_missing={truly_missing_count} "
            "true_missing_generated_outputs="
            f"{blocker_categories['counts']['true_missing_generated_outputs']} "
            "missing_approval_metadata="
            f"{blocker_categories['counts']['missing_approval_metadata']} "
            "candidate_present_but_blocked="
            f"{blocker_categories['counts']['candidate_present_but_blocked']} "
            "release_credit_false="
            f"{blocker_categories['release_credit_false_artifacts']['count']} "
            f"candidate_manifest_artifacts={coverage['candidate_artifact_count']} "
            f"candidate_manifest_blocked={coverage['candidate_present_but_blocked_count']} "
            f"domains_missing_outputs={domains_missing_outputs} domains_missing_nets={domains_missing_nets}"
        )
        for path_text, failures in blocked[:10]:
            print(f"  - {path_text}: {', '.join(failures)}")
        if len(blocked) > 10:
            print(f"  - ... {len(blocked) - 10} more blocked routed outputs")
        return 2

    write_report(
        {
            "schema": "eliza.e1_phone_routed_output_content_report.v1",
            "status": "pass",
            "summary": {
                "release_ready": True,
                "required_paths": len(outputs),
                "present": present,
                "content_valid": content_valid,
                "blocked": 0,
                "inventory_mismatches": 0,
                "missing_outputs": 0,
                "candidate_present_blocked_count": 0,
                "truly_missing_count": 0,
                "missing_validation_categories": 0,
                "domains_missing_outputs": 0,
                "domains_missing_exact_nets": 0,
            },
            "findings": [],
        },
        args.report,
    )
    print(f"STATUS: PASS E1 phone routed-output content paths={len(outputs)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
