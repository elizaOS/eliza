#!/usr/bin/env python3
"""Fail-closed content gate for E1 phone production/factory outputs."""

from __future__ import annotations

import csv
import json
from collections import Counter
from pathlib import Path
from typing import Any, cast

import yaml

ROOT = Path(__file__).resolve().parents[1]
INVENTORY = (
    ROOT / "board/kicad/e1-phone/production/readiness/"
    "production-factory-required-output-presence-inventory-2026-05-22.yaml"
)
CANDIDATE_MANIFEST = (
    ROOT / "board/kicad/e1-phone/production/factory-output-candidate-manifest-2026-05-22.yaml"
)
REPORT = ROOT / "build/reports/e1_phone_factory_output_content.json"
FIRST_ARTICLE_MATRIX = (
    ROOT / "board/kicad/e1-phone/production/test/readiness/"
    "e1-phone-first-article-bench-acceptance-matrix-2026-05-22.yaml"
)
EXPECTED_SCHEMA = "eliza.e1_phone_production_factory_required_output_presence_inventory.v1"
CLAIM_BOUNDARY = (
    "factory_output_content_validation_only_not_factory_or_production_release_evidence"
)
FALSE_CLAIM_FLAGS = {
    "release_claim_allowed": False,
    "factory_release_claim_allowed": False,
    "factory_output_claim_allowed": False,
    "first_article_claim_allowed": False,
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
FACTORY_FIELDS = {
    "release_package_revision",
    "fab_vendor_or_assembler",
    "program_or_fixture_revision",
    "limits_revision",
    "calibration_state",
    "lot_or_serial_traceability",
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
PLACEHOLDER_MARKERS = {
    "tbd",
    "todo",
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
VALIDATION_COMMAND = "python3 scripts/check_e1_phone_factory_output_content.py"
FIRST_ARTICLE_VALIDATION_COMMAND = "python3 scripts/check_e1_phone_first_article_content.py"
LOCAL_CANDIDATE_GENERATOR_COMMAND = "python3 scripts/generate_e1_phone_factory_output_candidates.py"


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


def load_yaml_mapping(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise ValueError(f"missing file: {rel(path)}")
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)} must be a YAML mapping")
    return data


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
    rows: list[dict[str, Any]], candidate_manifest: dict[str, Any]
) -> None:
    candidate_paths = set(candidate_manifest.get("artifact_paths") or [])
    for row in rows:
        path_text = str(row.get("path") or "")
        if path_text not in candidate_paths:
            row["repo_generation"] = {
                "repo_generated_candidate": False,
                "generator_command": "",
                "generator_manifest": candidate_manifest.get("path") or "",
                "current_artifact_present": repo_path(path_text).exists(),
                "release_credit": False,
                "classification": "not_managed_by_local_candidate_generator",
            }
            continue
        row["repo_generation"] = {
            "repo_generated_candidate": True,
            "generator_command": LOCAL_CANDIDATE_GENERATOR_COMMAND,
            "generator_manifest": candidate_manifest.get("path") or "",
            "current_artifact_present": repo_path(path_text).exists(),
            "release_credit": False,
            "classification": "local_candidate_generated_from_repo_sources",
            "claim_boundary": (
                "Local candidate generation can recreate this repo artifact, but cannot "
                "supply supplier, factory, first-article execution, lot traceability, "
                "or approval evidence."
            ),
        }


def repo_generation_plan(
    path_text: str, row: dict[str, Any], failures: list[str]
) -> dict[str, Any]:
    context = row.get("repo_generation")
    if not isinstance(context, dict):
        context = {
            "repo_generated_candidate": False,
            "generator_command": "",
            "generator_manifest": "",
            "current_artifact_present": repo_path(path_text).exists(),
            "release_credit": False,
            "classification": "not_managed_by_local_candidate_generator",
        }
    return {
        **context,
        "path": path_text,
        "missing_generated_artifact": "artifact_missing" in failures,
        "external_release_evidence_required": "artifact_missing" not in failures,
        "external_release_evidence_reason": (
            "present artifact still has fail-closed candidate, placeholder, "
            "traceability, or approval blockers"
            if "artifact_missing" not in failures
            else "repo artifact is absent at the required path"
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
    if suffix in {".txt", ".rpt", ".pos", ".bom", ".kicad_pcb"}:
        return path.read_text(encoding="utf-8")
    if suffix in {".zip", ".pdf", ".step", ".stp", ".tgz", ".ipc"}:
        return {"binary_or_cad_artifact": True}
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


def write_report(payload: dict[str, Any]) -> None:
    payload.setdefault("claim_boundary", CLAIM_BOUNDARY)
    for key, expected in FALSE_CLAIM_FLAGS.items():
        payload.setdefault(key, expected)
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def required_production_artifact_class(path_text: str, row: dict[str, Any]) -> str:
    if row.get("production_artifact_class"):
        return str(row["production_artifact_class"])
    path = repo_path(path_text)
    suffix = path.suffix.lower()
    if path.is_dir() or row.get("artifact_kind") == "directory":
        return "factory_release_directory_manifest"
    if suffix == ".kicad_pcb":
        return "fabrication_routed_pcb_source"
    if suffix in {".zip", ".tgz", ".ipc"}:
        return "fabrication_or_assembly_output_archive"
    if suffix in {".step", ".stp"}:
        return "factory_mechanical_cad_model"
    if suffix == ".pdf":
        return "signed_factory_review_report"
    if suffix == ".csv":
        return "factory_measurement_or_limit_table"
    if suffix in {".yaml", ".yml", ".json"}:
        return "structured_factory_release_record"
    if suffix == ".pos":
        return "pick_and_place_output"
    if suffix == ".bom":
        return "bill_of_materials_output"
    if suffix in {".txt", ".rpt"}:
        return "factory_release_text_report"
    return "factory_production_output"


def source_manifest_refs(row: dict[str, Any]) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = [
        {
            "manifest": rel(INVENTORY),
            "selectors": [str(pointer) for pointer in row.get("source_pointers") or []],
        }
    ]
    candidate_manifest = row.get("candidate_manifest")
    if candidate_manifest:
        refs.append(
            {
                "manifest": str(candidate_manifest).removeprefix("packages/chip/"),
                "selectors": [str(row.get("path") or "")],
            }
        )
    return refs


def unblock_action(path_text: str, row: dict[str, Any], failures: list[str]) -> dict[str, Any]:
    missing = "artifact_missing" in failures
    owner = ",".join(row.get("source_ids") or []) or "manufacturing"
    action = (
        "Stage the required factory output at this exact path from the fabricator or assembler, then rerun validation."
        if missing
        else "Replace the local candidate with approved factory release metadata, lot traceability, fixture/program revision, and signoff, then rerun validation."
    )
    return {
        "path": path_text,
        "current_path": path_text,
        "candidate_path": path_text if row.get("candidate_present_blocked") is True else "",
        "required_production_artifact_class": required_production_artifact_class(path_text, row),
        "metadata_record": metadata_record_targets(path_text),
        "owner": owner,
        "source_ids": row.get("source_ids") or [],
        "source_pointers": row.get("source_pointers") or [],
        "source_manifest_refs": source_manifest_refs({**row, "path": path_text}),
        "candidate_present_blocked": row.get("candidate_present_blocked") is True,
        "candidate_manifest": row.get("candidate_manifest") or "",
        "repo_generation_plan": repo_generation_plan(path_text, row, failures),
        "missing_artifact": missing,
        "failures": failures,
        "action": action,
        "validation_command": VALIDATION_COMMAND,
        "next_validation_commands": [VALIDATION_COMMAND],
        "release_credit": False,
    }


def repo_generation_summary(
    blocked: list[tuple[str, dict[str, Any], list[str]]],
) -> dict[str, Any]:
    generator_paths = [
        path_text
        for path_text, row, _failures in blocked
        if (row.get("repo_generation") or {}).get("repo_generated_candidate") is True
    ]
    missing_paths = [
        path_text for path_text, _row, failures in blocked if "artifact_missing" in failures
    ]
    present_blocked_paths = [
        path_text for path_text, _row, failures in blocked if "artifact_missing" not in failures
    ]
    return {
        "release_credit": False,
        "generator_command": LOCAL_CANDIDATE_GENERATOR_COMMAND,
        "generator_manifest": rel(CANDIDATE_MANIFEST),
        "generator_command_available_count": len(generator_paths),
        "repo_generated_candidate_blocked_count": len(generator_paths),
        "repo_generated_candidate_blocked_paths": sorted(generator_paths),
        "not_managed_by_local_generator_blocked_count": len(blocked) - len(generator_paths),
        "true_missing_generated_artifact_count": len(missing_paths),
        "true_missing_generated_artifact_paths": sorted(missing_paths),
        "present_fail_closed_artifact_count": len(present_blocked_paths),
        "present_fail_closed_artifact_paths": sorted(present_blocked_paths),
        "external_release_evidence_required_count": len(present_blocked_paths),
        "claim_boundary": (
            "These commands only regenerate local fail-closed candidate files; they do "
            "not create approved factory outputs, supplier returns, lot traceability, "
            "or executed first-article evidence."
        ),
    }


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
    if suffix in {".zip", ".pdf", ".step", ".stp", ".tgz", ".ipc"}:
        metadata = path.with_suffix(path.suffix + ".metadata.yaml")
        return {
            "record_type": "external_signed_review_metadata",
            "primary_record_path": report_path(metadata),
            "accepted_record_paths": [report_path(metadata)],
            "present_record_paths": [report_path(metadata)] if metadata.is_file() else [],
        }
    if suffix in {".yaml", ".yml", ".json"}:
        return {
            "record_type": "inline_structured_factory_record",
            "primary_record_path": path_text,
            "accepted_record_paths": [path_text],
            "present_record_paths": [path_text] if path.is_file() else [],
        }
    if suffix == ".csv":
        return {
            "record_type": "factory_measurement_csv",
            "primary_record_path": path_text,
            "accepted_record_paths": [path_text],
            "present_record_paths": [path_text] if path.is_file() else [],
        }
    return {
        "record_type": "unsupported_or_text_factory_record",
        "primary_record_path": path_text,
        "accepted_record_paths": [path_text],
        "present_record_paths": [path_text] if path.is_file() else [],
    }


def missing_field_group(failures: list[str], prefix: str) -> list[str]:
    marker = f"missing_{prefix}_field:"
    return sorted(failure.split(":", 1)[1] for failure in failures if failure.startswith(marker))


def first_article_dependency_index() -> dict[str, Any]:
    if not FIRST_ARTICLE_MATRIX.is_file():
        return {
            "source_matrix": rel(FIRST_ARTICLE_MATRIX),
            "matrix_present": False,
            "by_factory_path": {},
            "first_article_packet_count": 0,
            "paths_with_first_article_consumers": 0,
            "release_credit": False,
        }

    matrix = load_yaml_mapping(FIRST_ARTICLE_MATRIX)
    rows = matrix.get("acceptance_matrix")
    if not isinstance(rows, list):
        return {
            "source_matrix": rel(FIRST_ARTICLE_MATRIX),
            "matrix_present": True,
            "matrix_valid": False,
            "by_factory_path": {},
            "first_article_packet_count": 0,
            "paths_with_first_article_consumers": 0,
            "release_credit": False,
        }

    by_path: dict[str, list[dict[str, Any]]] = {}
    for index, row in enumerate(rows, start=1):
        if not isinstance(row, dict) or not row.get("path"):
            continue
        path_text = str(row["path"])
        by_path.setdefault(path_text, []).append(
            {
                "id": f"first_article_execution_packet_{index:03d}",
                "path": path_text,
                "evidence_kind": row.get("evidence_kind"),
                "template_only": row.get("template_only") is True
                or row.get("evidence_kind") == "template",
                "release_evidence": row.get("release_evidence") is True,
                "acceptance_state": row.get("acceptance_state"),
                "source_refs": row.get("source_refs") or [],
                "validation_command": FIRST_ARTICLE_VALIDATION_COMMAND,
                "release_credit": False,
            }
        )

    return {
        "source_matrix": rel(FIRST_ARTICLE_MATRIX),
        "matrix_present": True,
        "matrix_valid": True,
        "by_factory_path": dict(sorted(by_path.items())),
        "first_article_packet_count": sum(len(rows) for rows in by_path.values()),
        "paths_with_first_article_consumers": len(by_path),
        "release_credit": False,
    }


def factory_first_article_bridge(
    blocked: list[tuple[str, dict[str, Any], list[str]]],
    blocker_categories: dict[str, Any],
    first_article_index: dict[str, Any],
) -> dict[str, Any]:
    first_article_by_path = first_article_index.get("by_factory_path") or {}
    category_by_path = {
        path_text: data.get("category")
        for path_text, data in (blocker_categories.get("by_path") or {}).items()
        if isinstance(data, dict)
    }
    blocked_paths = {path_text for path_text, _row, _failures in blocked}
    bridged: dict[str, Any] = {}
    counts: Counter[str] = Counter()
    bridged_consumer_rows = 0
    for path_text in sorted(set(first_article_by_path) & blocked_paths):
        consumers = first_article_by_path[path_text]
        category = cast(str, category_by_path.get(path_text, "unknown_factory_blocker"))
        counts[category] += len(consumers)
        bridged_consumer_rows += len(consumers)
        bridged[path_text] = {
            "factory_path": path_text,
            "factory_blocker_category": category,
            "first_article_consumers": consumers,
            "first_article_consumer_count": len(consumers),
            "release_credit": False,
            "required_action": (
                "Clear the factory output blocker first, then execute or approve the "
                "linked first-article packet with serialized hardware traceability."
            ),
            "next_validation_commands": [
                VALIDATION_COMMAND,
                FIRST_ARTICLE_VALIDATION_COMMAND,
            ],
        }

    return {
        "release_credit": False,
        "source_factory_report": rel(REPORT),
        "source_first_article_matrix": first_article_index.get("source_matrix"),
        "factory_blocked_paths_with_first_article_consumers": len(bridged),
        "blocked_first_article_consumer_rows": bridged_consumer_rows,
        "consumer_rows_by_factory_blocker_category": dict(sorted(counts.items())),
        "by_factory_path": bridged,
        "next_validation_commands": [VALIDATION_COMMAND, FIRST_ARTICLE_VALIDATION_COMMAND],
    }


def factory_execution_packet_inventory(
    blocked: list[tuple[str, dict[str, Any], list[str]]],
    first_article_index: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    packets: list[dict[str, Any]] = []
    first_article_by_path = (
        first_article_index.get("by_factory_path") if first_article_index else {}
    ) or {}
    for path_text, row, failures in blocked:
        source_ids = row.get("source_ids") or []
        packet_id = ",".join(source_ids) if source_ids else "manufacturing"
        first_article_consumers = first_article_by_path.get(path_text, [])
        packets.append(
            {
                "path": path_text,
                "current_path": path_text,
                "candidate_path": path_text if row.get("candidate_present_blocked") is True else "",
                "packet_id": packet_id,
                "owner": packet_id,
                "artifact_kind": row.get("artifact_kind"),
                "required_production_artifact_class": required_production_artifact_class(
                    path_text, row
                ),
                "candidate_present_blocked": row.get("candidate_present_blocked") is True,
                "candidate_manifest": row.get("candidate_manifest") or "",
                "candidate_release_credit": row.get("candidate_release_credit") is True,
                "repo_generation_plan": repo_generation_plan(path_text, row, failures),
                "metadata_record": metadata_record_targets(path_text),
                "required_field_groups": {
                    "common_release_record": sorted(COMMON_FIELDS),
                    "factory_traceability": sorted(FACTORY_FIELDS),
                    "external_review_metadata": sorted(METADATA_FIELDS | FACTORY_FIELDS),
                },
                "missing_common_release_record_fields": missing_field_group(failures, "common"),
                "missing_factory_traceability_fields": missing_field_group(failures, "factory"),
                "missing_external_review_metadata_fields": missing_field_group(
                    failures, "external_metadata"
                ),
                "missing_directory_manifest_fields": missing_field_group(
                    failures, "directory_manifest"
                ),
                "failures": failures,
                "source_pointers": row.get("source_pointers") or [],
                "source_manifest_refs": source_manifest_refs({**row, "path": path_text}),
                "first_article_consumers": first_article_consumers,
                "first_article_consumer_count": len(first_article_consumers),
                "bridges_first_article_execution": bool(first_article_consumers),
                "validation_command": VALIDATION_COMMAND,
                "next_validation_commands": [VALIDATION_COMMAND]
                + ([FIRST_ARTICLE_VALIDATION_COMMAND] if first_article_consumers else []),
                "release_credit": False,
                "required_action": (
                    "Attach the exact approved factory release record, lot/serial traceability, "
                    "fixture or program revision, calibration state, vendor identity, artifact "
                    "hash, and signed review metadata for this production output."
                ),
            }
        )
    return packets


def candidate_coverage(
    rows: list[dict[str, Any]],
    blocked: list[tuple[str, dict[str, Any], list[str]]],
    candidate_manifest: dict[str, Any],
) -> dict[str, Any]:
    candidate_paths = set(candidate_manifest.get("artifact_paths") or [])
    required_paths = [
        str(row.get("path")) for row in rows if isinstance(row, dict) and row.get("path")
    ]
    blocked_candidate_paths = sorted(
        path_text
        for path_text, _row, failures in blocked
        if path_text in candidate_paths and "artifact_missing" not in failures
    )
    missing_candidate_paths = sorted(
        path_text
        for path_text, _row, failures in blocked
        if path_text in candidate_paths and "artifact_missing" in failures
    )
    missing_non_candidate_paths = sorted(
        path_text
        for path_text, _row, failures in blocked
        if path_text not in candidate_paths and "artifact_missing" in failures
    )
    candidate_paths_not_required = sorted(candidate_paths.difference(required_paths))
    return {
        "candidate_manifest": candidate_manifest.get("path"),
        "candidate_manifest_present": candidate_manifest.get("present") is True,
        "candidate_manifest_status": candidate_manifest.get("status"),
        "candidate_release_credit": candidate_manifest.get("release_credit") is True,
        "candidate_artifact_count": int(candidate_manifest.get("artifact_count") or 0),
        "required_paths_covered_by_candidate_manifest": len(
            [path for path in required_paths if path in candidate_paths]
        ),
        "candidate_present_but_blocked_paths": blocked_candidate_paths,
        "candidate_present_but_blocked_count": len(blocked_candidate_paths),
        "candidate_paths_missing_from_repo": missing_candidate_paths,
        "candidate_paths_missing_from_repo_count": len(missing_candidate_paths),
        "missing_required_paths_not_in_candidate_manifest": missing_non_candidate_paths,
        "missing_required_paths_not_in_candidate_manifest_count": len(missing_non_candidate_paths),
        "candidate_paths_not_required_by_inventory": candidate_paths_not_required,
        "candidate_paths_not_required_by_inventory_count": len(candidate_paths_not_required),
        "intentionally_not_generated": candidate_manifest.get("intentionally_not_generated") or [],
    }


def approval_metadata_unblock_summary(
    blocked: list[tuple[str, dict[str, Any], list[str]]],
) -> list[dict[str, Any]]:
    missing_review_metadata = 0
    missing_fields: Counter[str] = Counter()
    unapproved = 0
    placeholder = 0
    for _path_text, _row, failures in blocked:
        if "missing_external_signed_review_metadata" in failures:
            missing_review_metadata += 1
        if any(failure.endswith("disposition_not_approved") for failure in failures):
            unapproved += 1
        if any(failure.endswith("placeholder_or_blocked_marker_present") for failure in failures):
            placeholder += 1
        for failure in failures:
            if "_field:" in failure:
                missing_fields[failure.split(":", 1)[1]] += 1

    return [
        {
            "id": "attach_factory_external_review_metadata",
            "blocked_rows": missing_review_metadata,
            "required_action": (
                "add signed .metadata.yaml companions for binary factory outputs with "
                "external review authority, approval record, artifact SHA-256, lot/serial "
                "traceability, fixture/program revision, calibration, and vendor identity"
            ),
            "validation_command": VALIDATION_COMMAND,
            "release_credit": False,
        },
        {
            "id": "complete_factory_approval_metadata_fields",
            "blocked_rows": sum(missing_fields.values()),
            "top_missing_fields": dict(sorted(missing_fields.most_common(12))),
            "required_action": (
                "fill the highest-count factory release metadata fields first; every "
                "candidate still needs approved disposition, traceability, and signoff"
            ),
            "validation_command": VALIDATION_COMMAND,
            "release_credit": False,
        },
        {
            "id": "approve_and_deplaceholder_factory_records",
            "blocked_rows": unapproved + placeholder,
            "unapproved_rows": unapproved,
            "placeholder_rows": placeholder,
            "required_action": (
                "replace local factory candidates with approved, signed, non-placeholder "
                "fabricator or assembler release records"
            ),
            "validation_command": VALIDATION_COMMAND,
            "release_credit": False,
        },
    ]


MISSING_APPROVAL_METADATA_FAILURES = {
    "missing_external_signed_review_metadata",
    "missing_text_release_metadata_or_provenance",
    "directory_missing_release_manifest",
}


def factory_output_blocker_categories(
    blocked: list[tuple[str, dict[str, Any], list[str]]],
) -> dict[str, Any]:
    categories: dict[str, dict[str, Any]] = {
        "true_missing_factory_outputs": {
            "count": 0,
            "paths": [],
            "required_action": (
                "stage the missing production/factory output files at the exact "
                "inventory paths from the fabricator, assembler, test fixture, or "
                "first-article flow"
            ),
            "release_credit": False,
        },
        "missing_approval_metadata": {
            "count": 0,
            "paths": [],
            "required_action": (
                "attach signed approval metadata or release manifests for factory "
                "outputs that already exist on disk"
            ),
            "release_credit": False,
        },
        "candidate_present_but_blocked": {
            "count": 0,
            "paths": [],
            "required_action": (
                "promote local factory-output candidates to approved production "
                "release records with non-placeholder disposition, lot/serial "
                "traceability, fixture/program revision, hashes, and signoff"
            ),
            "release_credit": False,
        },
        "present_unapproved_or_placeholder": {
            "count": 0,
            "paths": [],
            "required_action": (
                "replace present factory-output records that are outside the "
                "candidate manifest but still unapproved, placeholder, or blocked"
            ),
            "release_credit": False,
        },
    }
    by_path: dict[str, dict[str, Any]] = {}
    for path_text, row, failures in blocked:
        failure_set = set(failures)
        if "artifact_missing" in failure_set:
            category_id = "true_missing_factory_outputs"
        elif failure_set & MISSING_APPROVAL_METADATA_FAILURES:
            category_id = "missing_approval_metadata"
        elif row.get("candidate_present_blocked") is True:
            category_id = "candidate_present_but_blocked"
        else:
            category_id = "present_unapproved_or_placeholder"

        categories[category_id]["count"] += 1
        categories[category_id]["paths"].append(path_text)
        by_path[path_text] = {
            "category": category_id,
            "missing_factory_output": category_id == "true_missing_factory_outputs",
            "missing_approval_metadata": category_id == "missing_approval_metadata",
            "candidate_present_but_blocked": category_id == "candidate_present_but_blocked",
            "failures": failures,
            "release_credit": False,
        }

    for category in categories.values():
        category["paths"] = sorted(category["paths"])
        category["validation_command"] = VALIDATION_COMMAND

    return {
        "categories": categories,
        "by_path": dict(sorted(by_path.items())),
        "counts": {category_id: category["count"] for category_id, category in categories.items()},
        "release_credit": False,
    }


def blocker_diagnostics(
    blocked: list[tuple[str, dict[str, Any], list[str]]],
) -> dict[str, Any]:
    by_owner: Counter[str] = Counter()
    by_source_id: Counter[str] = Counter()
    by_failure: Counter[str] = Counter()
    missing_paths: list[str] = []
    present_blocked_paths: list[str] = []
    missing_fields_by_path: dict[str, list[str]] = {}
    for path_text, row, failures in blocked:
        owner = ",".join(row.get("source_ids") or []) or "manufacturing"
        by_owner[owner] += 1
        for source_id in row.get("source_ids") or ["manufacturing"]:
            by_source_id[str(source_id)] += 1
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
            or failure.startswith("missing_factory_field:")
            or failure.startswith("missing_external_metadata_field:")
            or failure.startswith("missing_directory_manifest_field:")
        ]
        if missing_fields:
            missing_fields_by_path[path_text] = sorted(missing_fields)
    return {
        "blocked_by_owner": dict(sorted(by_owner.items())),
        "blocked_by_source_id": dict(sorted(by_source_id.items())),
        "blocked_by_failure": dict(sorted(by_failure.items())),
        "missing_paths": sorted(missing_paths),
        "present_blocked_paths": sorted(present_blocked_paths),
        "missing_fields_by_path": dict(sorted(missing_fields_by_path.items())),
        "approval_metadata_unblock_summary": approval_metadata_unblock_summary(blocked),
        "next_unblock_groups": [
            {
                "id": "stage_factory_release_outputs",
                "owner": "manufacturing",
                "blocked_rows": by_failure.get("artifact_missing", 0),
                "required_action": (
                    "stage missing fab, assembly, probe, fixture, limits, calibration, "
                    "traceability, and signed package outputs from real production flow"
                ),
            },
            {
                "id": "replace_local_factory_candidates",
                "owner": "manufacturing",
                "blocked_rows": len(present_blocked_paths),
                "required_action": (
                    "replace local candidates with approved factory release metadata, lot "
                    "traceability, fixture/program revision, and signoff"
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
    failures = approved_record_failures(
        parsed, COMMON_FIELDS | FACTORY_FIELDS, "directory_manifest"
    )
    children = [
        child
        for child in path.rglob("*")
        if child.is_file() and child != manifest and child.stat().st_size > 0
    ]
    if not children:
        failures.append("directory_missing_release_children")
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
    return approved_record_failures(parsed, METADATA_FIELDS | FACTORY_FIELDS, "external_metadata")


def content_failures(path_text: str) -> list[str]:
    path = repo_path(path_text)
    if not path.exists():
        return ["artifact_missing"]
    if path.is_dir():
        return directory_failures(path)
    if path.stat().st_size == 0:
        return ["artifact_empty"]

    try:
        parsed = parse_file(path)
    except Exception as exc:  # noqa: BLE001 - release gate error surface.
        return [f"artifact_parse_failed:{type(exc).__name__}"]

    failures: list[str] = []
    suffix = path.suffix.lower()
    if suffix in {".yaml", ".yml", ".json"}:
        failures.extend(approved_record_failures(parsed, COMMON_FIELDS, "common"))
        failures.extend(
            f"missing_factory_field:{field}" for field in missing_fields(parsed, FACTORY_FIELDS)
        )
        failures.extend(
            f"missing_common_field:{field}" for field in missing_fields(parsed, COMMON_FIELDS)
        )
        if isinstance(parsed, dict) and parsed.get("disposition") != "approved":
            failures.append("disposition_not_approved")
    elif suffix == ".csv":
        if not isinstance(parsed, list) or not parsed:
            failures.append("csv_empty")
        else:
            headers = set(parsed[0])
            if not ({"fixture_revision", "limit", "result"} <= headers):
                failures.append("csv_missing_fixture_limit_result_columns")
    elif suffix in {".zip", ".pdf", ".step", ".stp", ".tgz", ".ipc"}:
        failures.extend(companion_metadata_failures(path))

    if has_placeholder(parsed):
        failures.append("placeholder_or_blocked_marker_present")
    return sorted(dict.fromkeys(failures))


def main() -> int:
    try:
        inventory = load_yaml_mapping(INVENTORY)
        if inventory.get("schema") != EXPECTED_SCHEMA:
            raise ValueError(f"unexpected schema: {inventory.get('schema')!r}")
        summary = inventory.get("summary")
        if not isinstance(summary, dict):
            raise ValueError("summary must be a mapping")
        rows = inventory.get("required_output_presence")
        if not isinstance(rows, list) or not rows:
            raise ValueError("required_output_presence must be a non-empty list")
        expected_count = summary.get("required_output_path_count")
        if len(rows) != expected_count:
            raise ValueError(
                f"required output count mismatch: rows={len(rows)} summary={expected_count}"
            )

        blocked: list[tuple[str, dict[str, Any], list[str]]] = []
        path_exists_count = 0
        content_valid_count = 0
        source_refs = 0
        candidate_manifest = load_candidate_manifest()
        attach_repo_generation_context(rows, candidate_manifest)
        for index, row in enumerate(rows):
            if not isinstance(row, dict):
                raise ValueError(f"required_output_presence[{index}] must be a mapping")
            path_text = row.get("path")
            if not isinstance(path_text, str) or not path_text:
                raise ValueError(f"required_output_presence[{index}] missing path")
            source_refs += len(row.get("source_pointers") or [])
            if repo_path(path_text).exists():
                path_exists_count += 1
            failures = content_failures(path_text)
            if failures:
                blocked.append((path_text, row, failures))
            else:
                content_valid_count += 1
        missing = int(summary.get("missing_required_output_path_count") or 0)
        blocked_present_count = sum(
            1 for path_text, _row, _failures in blocked if repo_path(path_text).exists()
        )
        coverage = candidate_coverage(rows, blocked, candidate_manifest)
        candidate_extra_blocked: list[dict[str, Any]] = []
        for path_text in coverage["candidate_paths_not_required_by_inventory"]:
            failures = content_failures(path_text)
            candidate_extra_blocked.append(
                {
                    "path": path_text,
                    "present": repo_path(path_text).exists(),
                    "failures": failures,
                    "release_credit": False,
                    "action": (
                        "Either add this candidate to the generated factory required-output "
                        "inventory with an owner/source requirement, or remove it from the "
                        "candidate manifest. It remains non-release evidence until approved "
                        "factory metadata and signoff exist."
                    ),
                }
            )
        coverage["candidate_paths_not_required_by_inventory_blocked"] = candidate_extra_blocked
        coverage["candidate_paths_not_required_by_inventory_blocked_count"] = sum(
            1 for item in candidate_extra_blocked if item["failures"]
        )
        blocker_categories = factory_output_blocker_categories(blocked)
        generation_summary = repo_generation_summary(blocked)
        first_article_index = first_article_dependency_index()
        factory_execution_packets = factory_execution_packet_inventory(blocked, first_article_index)
        bridge = factory_first_article_bridge(blocked, blocker_categories, first_article_index)
        diagnostics = blocker_diagnostics(blocked)
    except ValueError as exc:
        write_report(
            {
                "schema": "eliza.e1_phone_factory_output_content_report.v1",
                "status": "blocked",
                "release_credit": False,
                "summary": {
                    "release_ready": False,
                    "release_credit": False,
                    "blocked": 1,
                    "contract_error_count": 1,
                },
                "findings": [
                    {
                        "code": "factory_output_contract_invalid",
                        "severity": "blocker",
                        "message": str(exc),
                        "evidence": rel(INVENTORY),
                        "release_credit": False,
                    }
                ],
                "blocked_evidence_inventory": [],
                "factory_execution_packet_inventory": [],
                "factory_output_blocker_categories": {
                    "release_credit": False,
                    "counts": {
                        "contract_error": 1,
                        "true_missing_factory_outputs": 0,
                        "missing_approval_metadata": 0,
                        "candidate_present_but_blocked": 0,
                        "present_unapproved_or_placeholder": 0,
                    },
                },
            }
        )
        print(f"STATUS: BLOCKED E1 phone factory-output content contract invalid: {exc}")
        return 2

    if blocked or missing:
        write_report(
            {
                "schema": "eliza.e1_phone_factory_output_content_report.v1",
                "status": "blocked",
                "release_credit": False,
                "summary": {
                    "release_ready": False,
                    "release_credit": False,
                    "required_paths": len(rows),
                    "present": path_exists_count,
                    "path_exists_count": path_exists_count,
                    "content_valid_count": content_valid_count,
                    "blocked_present_count": blocked_present_count,
                    "blocked": len(blocked),
                    "missing": missing,
                    "missing_artifact_count": missing,
                    "source_refs": source_refs,
                    "candidate_paths_not_required_by_inventory": coverage[
                        "candidate_paths_not_required_by_inventory_count"
                    ],
                    "true_missing_factory_output_count": blocker_categories["counts"][
                        "true_missing_factory_outputs"
                    ],
                    "missing_approval_metadata_count": blocker_categories["counts"][
                        "missing_approval_metadata"
                    ],
                    "candidate_present_but_blocked_count": blocker_categories["counts"][
                        "candidate_present_but_blocked"
                    ],
                    "present_unapproved_or_placeholder_count": blocker_categories["counts"][
                        "present_unapproved_or_placeholder"
                    ],
                    "repo_generated_candidate_blocked_count": generation_summary[
                        "repo_generated_candidate_blocked_count"
                    ],
                    "external_release_evidence_required_count": generation_summary[
                        "external_release_evidence_required_count"
                    ],
                },
                "findings": [
                    {
                        "code": "factory_output_content_blocked",
                        "severity": "blocker",
                        "message": f"{path_text}: {', '.join(failures)}",
                        "evidence": path_text,
                    }
                    for path_text, _row, failures in blocked
                ]
                + (
                    [
                        {
                            "code": "factory_output_paths_missing",
                            "severity": "blocker",
                            "message": f"{missing} required factory output paths are missing",
                            "evidence": rel(INVENTORY),
                        }
                    ]
                    if missing
                    else []
                ),
                "blocked_evidence_inventory": [
                    unblock_action(path_text, row, failures) for path_text, row, failures in blocked
                ],
                "blocker_dependency_counts": {
                    "repo_artifact_generation": blocker_categories["counts"][
                        "true_missing_factory_outputs"
                    ],
                    "live_device_validation": 0,
                    "actionable_external_dependency": max(
                        0,
                        len(blocked)
                        + missing
                        - blocker_categories["counts"]["true_missing_factory_outputs"],
                    ),
                },
                "next_command_by_dependency": {
                    "actionable_external_dependency": [VALIDATION_COMMAND],
                    **(
                        {"repo_artifact_generation": [VALIDATION_COMMAND]}
                        if blocker_categories["counts"]["true_missing_factory_outputs"] > 0
                        else {}
                    ),
                },
                "validation_commands": [VALIDATION_COMMAND, FIRST_ARTICLE_VALIDATION_COMMAND],
                "primary_blocker": {
                    "dependency": "actionable_external_dependency"
                    if generation_summary["external_release_evidence_required_count"] > 0
                    else "repo_artifact_generation",
                    "blocked_rows": len(blocked),
                    "required_action": (
                        "Replace present candidate or placeholder factory outputs with approved "
                        "hash-bound release evidence; local generation alone does not grant "
                        "factory release credit."
                    ),
                    "validation_command": VALIDATION_COMMAND,
                    "release_credit": False,
                },
                "blocker_diagnostics": diagnostics,
                "factory_output_blocker_categories": blocker_categories,
                "repo_generation_summary": generation_summary,
                "factory_execution_packet_inventory": factory_execution_packets,
                "factory_first_article_bridge": bridge,
                "candidate_manifest_coverage": coverage,
                "next_unblock_actions": [
                    unblock_action(path_text, row, failures)
                    for path_text, row, failures in blocked[:20]
                ],
            }
        )
        print(
            "STATUS: BLOCKED E1 phone factory-output content "
            f"paths={len(rows)} path_exists={path_exists_count} "
            f"content_valid={content_valid_count} blocked_present={blocked_present_count} "
            f"blocked={len(blocked)} "
            f"missing={missing} source_refs={source_refs} "
            f"candidate_manifest_artifacts={coverage['candidate_artifact_count']} "
            f"candidate_manifest_blocked={coverage['candidate_present_but_blocked_count']} "
            f"candidate_manifest_extra={coverage['candidate_paths_not_required_by_inventory_count']} "
            "true_missing_factory_outputs="
            f"{blocker_categories['counts']['true_missing_factory_outputs']} "
            "missing_approval_metadata="
            f"{blocker_categories['counts']['missing_approval_metadata']} "
            "candidate_present_but_blocked="
            f"{blocker_categories['counts']['candidate_present_but_blocked']} "
            "present_unapproved_or_placeholder="
            f"{blocker_categories['counts']['present_unapproved_or_placeholder']}"
        )
        for path_text, _row, failures in blocked[:10]:
            print(f"  - {path_text}: {', '.join(failures)}")
        if len(blocked) > 10:
            print(f"  - ... {len(blocked) - 10} more blocked factory outputs")
        return 2

    write_report(
        {
            "schema": "eliza.e1_phone_factory_output_content_report.v1",
            "status": "pass",
            "release_credit": True,
            "summary": {
                "release_ready": True,
                "release_credit": True,
                "required_paths": len(rows),
                "present": path_exists_count,
                "path_exists_count": path_exists_count,
                "content_valid_count": content_valid_count,
                "blocked_present_count": 0,
                "blocked": 0,
                "missing": 0,
                "missing_artifact_count": 0,
                "source_refs": source_refs,
            },
            "findings": [],
        }
    )
    print(f"STATUS: PASS E1 phone factory-output content paths={len(rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
