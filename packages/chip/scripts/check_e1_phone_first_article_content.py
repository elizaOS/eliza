#!/usr/bin/env python3
"""Fail-closed content gate for E1 phone first-article bench evidence."""

from __future__ import annotations

import csv
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

import yaml

import check_e1_phone_factory_output_content as factory_content


ROOT = Path(__file__).resolve().parents[1]
MATRIX = (
    ROOT / "board/kicad/e1-phone/production/test/readiness/"
    "e1-phone-first-article-bench-acceptance-matrix-2026-05-22.yaml"
)
REPORT = ROOT / "build/reports/e1_phone_first_article_content.json"
EXPECTED_SCHEMA = "eliza.e1_phone_first_article_bench_acceptance_matrix.v1"
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
FIRST_ARTICLE_FIELDS = {
    "board_serial",
    "supplier_lot_ids",
    "fixture_id",
    "fixture_calibration_id",
    "test_software_revision",
    "operator",
    "limits_file",
    "measured_results",
    "pass_fail_disposition",
    "waivers",
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
    "template_empty_not_executed",
}
VALIDATION_COMMAND = "python3 scripts/check_e1_phone_first_article_content.py"
FACTORY_VALIDATION_COMMAND = "python3 scripts/check_e1_phone_factory_output_content.py"
MATRIX_REGENERATION_COMMAND = (
    "python3 scripts/e1_phone_first_article_bench_acceptance_matrix.py"
)
ROUTED_HARDWARE_PREREQUISITES = [
    "approved routed KiCad PCB matching the serialized board",
    "released production BOM/AVL and supplier lot records",
    "fixture calibration record for the executed bench station",
    "signed first-article traveler with board serial and operator",
]


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
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def row_owner(row: dict[str, Any]) -> str:
    refs = row.get("source_refs")
    if isinstance(refs, list):
        owners = [
            str(ref.get("owner"))
            for ref in refs
            if isinstance(ref, dict) and ref.get("owner")
        ]
        if owners:
            return ",".join(dict.fromkeys(owners))
    return "manufacturing_validation"


def unblock_action(path_text: str, row: dict[str, Any], failures: list[str]) -> dict[str, Any]:
    missing = "artifact_missing" in failures
    template = "template_cannot_unlock_release" in failures
    if template:
        action = "Execute the first-article test on serialized routed hardware; templates cannot unlock release."
    elif missing:
        action = "Capture the required first-article artifact at this exact path, then rerun validation."
    else:
        action = "Replace the unvalidated candidate with executed first-article measurements, fixture calibration, traceability, operator, limits, and approval, then rerun validation."
    return {
        "path": path_text,
        "owner": row_owner(row),
        "evidence_kind": row.get("evidence_kind"),
        "template_only": row.get("template_only") is True,
        "missing_artifact": missing,
        "failures": failures,
        "repo_generation_plan": first_article_repo_generation_plan(
            path_text, row, failures
        ),
        "action": action,
        "validation_command": VALIDATION_COMMAND,
    }


def first_article_repo_generation_plan(
    path_text: str, row: dict[str, Any], failures: list[str]
) -> dict[str, Any]:
    template = "template_cannot_unlock_release" in failures or row.get("template_only") is True
    missing = "artifact_missing" in failures
    return {
        "path": path_text,
        "repo_generated_candidate": False,
        "generator_command": "",
        "matrix_regeneration_command": MATRIX_REGENERATION_COMMAND,
        "current_artifact_present": repo_path(path_text).exists(),
        "missing_generated_artifact": missing,
        "template_only": template,
        "external_execution_or_approval_required": True,
        "external_execution_or_approval_reason": (
            "template must be executed on serialized routed hardware"
            if template
            else "first-article release needs executed measurements, board serial, "
            "fixture calibration, operator, limits, pass/fail disposition, and approval"
        ),
        "claim_boundary": (
            "The matrix can be regenerated from repo manifests, but first-article "
            "evidence itself cannot be generated from repo state without serialized "
            "hardware execution and approval."
        ),
        "validation_command": VALIDATION_COMMAND,
        "release_credit": False,
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
            "record_type": "inline_structured_first_article_record",
            "primary_record_path": path_text,
            "accepted_record_paths": [path_text],
            "present_record_paths": [path_text] if path.is_file() else [],
        }
    if suffix == ".csv":
        return {
            "record_type": "measurement_csv_with_limit_result_columns",
            "primary_record_path": path_text,
            "accepted_record_paths": [path_text],
            "present_record_paths": [path_text] if path.is_file() else [],
        }
    return {
        "record_type": "artifact_with_embedded_or_companion_release_provenance",
        "primary_record_path": path_text,
        "accepted_record_paths": [path_text],
        "present_record_paths": [path_text] if path.exists() else [],
    }


def missing_packet_fields(failures: list[str]) -> list[str]:
    fields: set[str] = set()
    for failure in failures:
        if "_field:" in failure:
            fields.add(failure.split(":", 1)[1])
        elif failure == "csv_missing_measurement_limit_result_columns":
            fields.update({"measurement", "limit", "result"})
    return sorted(fields)


def row_has_any_prefix(failures: list[str], prefixes: tuple[str, ...]) -> bool:
    return any(failure.startswith(prefix) for failure in failures for prefix in prefixes)


def row_has_any_suffix(failures: list[str], suffixes: tuple[str, ...]) -> bool:
    return any(failure.endswith(suffix) for failure in failures for suffix in suffixes)


def row_requires_execution(failures: list[str]) -> bool:
    if any(
        failure
        in {
            "artifact_missing",
            "artifact_empty",
            "csv_empty",
            "csv_missing_measurement_limit_result_columns",
            "template_cannot_unlock_release",
        }
        for failure in failures
    ):
        return True
    return row_has_any_prefix(failures, ("missing_first_article_field:",))


def row_requires_approval(failures: list[str]) -> bool:
    if row_has_any_suffix(
        failures,
        (
            "disposition_not_approved",
            "placeholder_or_blocked_marker_present",
        ),
    ):
        return True
    return row_has_any_prefix(
        failures,
        (
            "missing_common_field:",
            "missing_external_metadata_field:",
            "missing_directory_manifest_field:",
        ),
    )


def blocker_category(path_text: str, row: dict[str, Any], failures: list[str]) -> str:
    path = repo_path(path_text)
    suffix = path.suffix.lower()
    if "artifact_missing" in failures:
        return "true_missing_artifacts"
    if "template_cannot_unlock_release" in failures:
        return "template_only_placeholders"
    if any(
        failure.startswith("directory_") or failure.startswith("missing_directory_")
        for failure in failures
    ):
        return "directory_manifest_approval_incomplete"
    if any(failure.startswith("external_") or failure.startswith("missing_external_") for failure in failures):
        return "signed_external_metadata_incomplete"
    if suffix == ".csv" or any(failure.startswith("csv_") for failure in failures):
        return "execution_log_schema_or_measurement_gaps"
    if row.get("evidence_kind") in {
        "executed_log",
        "limits",
        "probe_or_fixture",
        "rf_or_calibration_log",
        "traveler",
        "clearance_or_enclosure_evidence",
    }:
        return "structured_record_approval_incomplete"
    return "text_or_other_candidate_placeholder"


def factory_output_bridge_index() -> dict[str, Any]:
    try:
        inventory = factory_content.load_yaml_mapping(factory_content.INVENTORY)
        rows = inventory.get("required_output_presence")
        if not isinstance(rows, list):
            raise ValueError("required_output_presence must be a list")
        blocked: list[tuple[str, dict[str, Any], list[str]]] = []
        for row in rows:
            if not isinstance(row, dict) or not row.get("path"):
                continue
            path_text = str(row["path"])
            failures = factory_content.content_failures(path_text)
            if failures:
                blocked.append((path_text, row, failures))
        categories = factory_content.factory_output_blocker_categories(blocked)
        by_path = {
            path_text: {
                "path": path_text,
                "factory_blocker_category": data.get("category"),
                "missing_factory_output": data.get("missing_factory_output") is True,
                "missing_approval_metadata": data.get("missing_approval_metadata") is True,
                "candidate_present_but_blocked": data.get("candidate_present_but_blocked")
                is True,
                "failures": data.get("failures") or [],
                "release_credit": False,
                "validation_command": FACTORY_VALIDATION_COMMAND,
            }
            for path_text, data in (categories.get("by_path") or {}).items()
            if isinstance(data, dict)
        }
        return {
            "source_inventory": factory_content.rel(factory_content.INVENTORY),
            "source_report": factory_content.rel(factory_content.REPORT),
            "inventory_present": True,
            "blocked_factory_path_count": len(by_path),
            "factory_output_blocker_counts": categories.get("counts") or {},
            "by_path": dict(sorted(by_path.items())),
            "release_credit": False,
        }
    except Exception as exc:  # noqa: BLE001 - diagnostic surface for release gate.
        return {
            "source_inventory": factory_content.rel(factory_content.INVENTORY),
            "source_report": factory_content.rel(factory_content.REPORT),
            "inventory_present": factory_content.INVENTORY.is_file(),
            "blocked_factory_path_count": 0,
            "factory_output_blocker_counts": {},
            "by_path": {},
            "index_error": f"{type(exc).__name__}: {exc}",
            "release_credit": False,
        }


def first_article_bridge_causes(
    path_text: str,
    row: dict[str, Any],
    failures: list[str],
    factory_dependency: dict[str, Any] | None,
) -> list[str]:
    causes: list[str] = []
    factory_category = (
        factory_dependency.get("factory_blocker_category")
        if factory_dependency
        else None
    )
    if factory_category == "true_missing_factory_outputs":
        causes.append("factory_packet_missing")
    elif factory_category in {
        "missing_approval_metadata",
        "candidate_present_but_blocked",
        "present_unapproved_or_placeholder",
    }:
        causes.append("factory_packet_unapproved")
    if "template_cannot_unlock_release" in failures or row.get("template_only") is True:
        causes.append("first_article_template_not_executed")
    if row_requires_execution(failures):
        causes.append("first_article_execution_or_measurement_gap")
    if row_requires_approval(failures):
        causes.append("first_article_approval_gap")
    if not causes:
        causes.append("first_article_other_content_gap")
    return sorted(dict.fromkeys(causes))


def factory_first_article_bridge(
    blocked: list[tuple[str, dict[str, Any], list[str]]],
    factory_index: dict[str, Any],
) -> dict[str, Any]:
    factory_by_path = factory_index.get("by_path") or {}
    by_first_article_path: dict[str, Any] = {}
    by_factory_path: dict[str, list[dict[str, Any]]] = {}
    cause_counts: Counter[str] = Counter()
    factory_blocked_rows = 0
    factory_missing_rows = 0
    factory_unapproved_rows = 0
    for index, (path_text, row, failures) in enumerate(blocked, start=1):
        factory_dependency = factory_by_path.get(path_text)
        causes = first_article_bridge_causes(path_text, row, failures, factory_dependency)
        cause_counts.update(causes)
        if factory_dependency:
            factory_blocked_rows += 1
            if "factory_packet_missing" in causes:
                factory_missing_rows += 1
            if "factory_packet_unapproved" in causes:
                factory_unapproved_rows += 1
        bridge_row = {
            "id": f"first_article_execution_packet_{index:03d}",
            "first_article_path": path_text,
            "factory_path": path_text if factory_dependency else "",
            "factory_dependency_present": factory_dependency is not None,
            "factory_dependency": factory_dependency or {},
            "causes": causes,
            "primary_cause": causes[0],
            "first_article_blocker_category": blocker_category(path_text, row, failures),
            "first_article_failures": failures,
            "next_validation_commands": [FACTORY_VALIDATION_COMMAND, VALIDATION_COMMAND]
            if factory_dependency
            else [VALIDATION_COMMAND],
            "release_credit": False,
        }
        by_first_article_path[path_text] = bridge_row
        if factory_dependency:
            by_factory_path.setdefault(path_text, []).append(bridge_row)

    return {
        "release_credit": False,
        "source_factory_inventory": factory_index.get("source_inventory"),
        "source_factory_report": factory_index.get("source_report"),
        "source_first_article_report": rel(REPORT),
        "summary": {
            "blocked_first_article_rows": len(blocked),
            "first_article_rows_with_factory_packet_blocker": factory_blocked_rows,
            "first_article_rows_blocked_by_missing_factory_packet": factory_missing_rows,
            "first_article_rows_blocked_by_unapproved_factory_packet": factory_unapproved_rows,
            "first_article_rows_with_execution_or_measurement_gap": cause_counts.get(
                "first_article_execution_or_measurement_gap", 0
            ),
            "first_article_rows_with_approval_gap": cause_counts.get(
                "first_article_approval_gap", 0
            ),
            "first_article_template_only_rows": cause_counts.get(
                "first_article_template_not_executed", 0
            ),
            "cause_counts": dict(sorted(cause_counts.items())),
        },
        "factory_output_blocker_counts": factory_index.get(
            "factory_output_blocker_counts"
        )
        or {},
        "by_first_article_path": dict(sorted(by_first_article_path.items())),
        "by_factory_path": dict(sorted(by_factory_path.items())),
        "next_validation_commands": [FACTORY_VALIDATION_COMMAND, VALIDATION_COMMAND],
    }


def first_article_blocker_categories(
    blocked: list[tuple[str, dict[str, Any], list[str]]],
) -> dict[str, Any]:
    counts: Counter[str] = Counter()
    examples: dict[str, list[str]] = {}
    execution_required = 0
    approval_required = 0
    present_non_template = 0
    for path_text, row, failures in blocked:
        category = blocker_category(path_text, row, failures)
        counts[category] += 1
        examples.setdefault(category, [])
        if len(examples[category]) < 5:
            examples[category].append(path_text)
        if row_requires_execution(failures):
            execution_required += 1
        if row_requires_approval(failures):
            approval_required += 1
        if row.get("template_only") is not True and repo_path(path_text).exists():
            present_non_template += 1
    ordered_counts = {
        key: counts.get(key, 0)
        for key in [
            "true_missing_artifacts",
            "template_only_placeholders",
            "execution_log_schema_or_measurement_gaps",
            "signed_external_metadata_incomplete",
            "directory_manifest_approval_incomplete",
            "structured_record_approval_incomplete",
            "text_or_other_candidate_placeholder",
        ]
    }
    return {
        "release_credit": False,
        "counts": ordered_counts,
        "total_blocked_rows": sum(ordered_counts.values()),
        "present_non_template_blocked_rows": present_non_template,
        "execution_required_rows": execution_required,
        "approval_required_rows": approval_required,
        "examples": {key: examples.get(key, []) for key in ordered_counts},
        "validation_command": VALIDATION_COMMAND,
    }


def source_refs(row: dict[str, Any]) -> list[dict[str, Any]]:
    refs = row.get("source_refs")
    if not isinstance(refs, list):
        return []
    return [ref for ref in refs if isinstance(ref, dict)]


def first_article_execution_packet_inventory(
    blocked: list[tuple[str, dict[str, Any], list[str]]],
    bridge: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    packets: list[dict[str, Any]] = []
    bridge_by_path = (bridge.get("by_first_article_path") if bridge else {}) or {}
    for index, (path_text, row, failures) in enumerate(blocked, start=1):
        field_list = missing_packet_fields(failures)
        traceability_fields = sorted(set(field_list) & FIRST_ARTICLE_FIELDS)
        refs = source_refs(row)
        bridge_row = bridge_by_path.get(path_text, {})
        packets.append(
            {
                "id": f"first_article_execution_packet_{index:03d}",
                "path": path_text,
                "source_matrix": rel(MATRIX),
                "validation_report": rel(REPORT),
                "owner": row_owner(row),
                "evidence_kind": row.get("evidence_kind"),
                "source_refs": refs,
                "source_requirement_ids": sorted(
                    {
                        str(ref.get("source_requirement_id") or ref.get("source"))
                        for ref in refs
                        if ref.get("source_requirement_id") or ref.get("source")
                    }
                ),
                "template_only": row.get("template_only") is True
                or row.get("evidence_kind") == "template",
                "artifact_present": repo_path(path_text).exists(),
                "blocker_category": blocker_category(path_text, row, failures),
                "factory_first_article_bridge": bridge_row,
                "factory_dependency_present": bool(
                    bridge_row.get("factory_dependency_present")
                ),
                "bridge_causes": bridge_row.get("causes") or [],
                "execution_required": row_requires_execution(failures),
                "approval_required": row_requires_approval(failures),
                "metadata_record": metadata_record_targets(path_text),
                "repo_generation_plan": first_article_repo_generation_plan(
                    path_text, row, failures
                ),
                "missing_fields": field_list,
                "missing_first_article_traceability_fields": traceability_fields,
                "blocking_failures": failures,
                "required_field_groups": [
                    "common_release_metadata",
                    "first_article_traceability",
                    "approved_disposition",
                    "signed_review_or_external_metadata",
                ],
                "routed_hardware_prerequisites": ROUTED_HARDWARE_PREREQUISITES,
                "next_commands": [VALIDATION_COMMAND],
                "release_credit": False,
            }
        )
    return packets


def repo_generation_summary(
    blocked: list[tuple[str, dict[str, Any], list[str]]],
) -> dict[str, Any]:
    missing_paths = [
        path_text
        for path_text, _row, failures in blocked
        if "artifact_missing" in failures
    ]
    template_paths = [
        path_text
        for path_text, row, failures in blocked
        if "template_cannot_unlock_release" in failures or row.get("template_only") is True
    ]
    present_blocked_paths = [
        path_text
        for path_text, row, failures in blocked
        if "artifact_missing" not in failures
        and "template_cannot_unlock_release" not in failures
        and row.get("template_only") is not True
    ]
    return {
        "release_credit": False,
        "repo_generated_candidate_blocked_count": 0,
        "generator_command_available_count": 0,
        "matrix_regeneration_command": MATRIX_REGENERATION_COMMAND,
        "true_missing_generated_artifact_count": len(missing_paths),
        "true_missing_generated_artifact_paths": sorted(missing_paths),
        "template_only_execution_required_count": len(template_paths),
        "template_only_execution_required_paths": sorted(template_paths),
        "present_fail_closed_artifact_count": len(present_blocked_paths),
        "present_fail_closed_artifact_paths": sorted(present_blocked_paths),
        "external_execution_or_approval_required_count": len(blocked),
        "claim_boundary": (
            "First-article acceptance rows are not repo-generatable release evidence; "
            "they require serialized hardware execution, fixture calibration, measured "
            "results, traceability, and approval."
        ),
    }


def approval_metadata_unblock_summary(
    blocked: list[tuple[str, dict[str, Any], list[str]]],
) -> list[dict[str, Any]]:
    external_metadata_rows = 0
    directory_manifest_rows = 0
    incomplete_field_rows = 0
    missing_fields: Counter[str] = Counter()
    unapproved = 0
    placeholder = 0
    unapproved_or_placeholder_rows = 0
    templates = 0
    for _path_text, _row, failures in blocked:
        if any(
            failure.startswith("external_")
            or failure.startswith("missing_external_metadata_field:")
            or failure == "missing_external_signed_review_metadata"
            for failure in failures
        ):
            external_metadata_rows += 1
        if any(
            failure.startswith("directory_")
            or failure.startswith("missing_directory_manifest_field:")
            for failure in failures
        ):
            directory_manifest_rows += 1
        if "template_cannot_unlock_release" in failures:
            templates += 1
        if any(failure.endswith("disposition_not_approved") for failure in failures):
            unapproved += 1
        if any(failure.endswith("placeholder_or_blocked_marker_present") for failure in failures):
            placeholder += 1
        if any(
            failure.endswith("disposition_not_approved")
            or failure.endswith("placeholder_or_blocked_marker_present")
            for failure in failures
        ):
            unapproved_or_placeholder_rows += 1
        if row_has_any_prefix(
            failures,
            (
                "missing_common_field:",
                "missing_first_article_field:",
                "missing_external_metadata_field:",
                "missing_directory_manifest_field:",
            ),
        ):
            incomplete_field_rows += 1
        for failure in failures:
            if "_field:" in failure:
                missing_fields[failure.split(":", 1)[1]] += 1

    return [
        {
            "id": "execute_templates_on_serialized_hardware",
            "blocked_rows": templates,
            "required_action": (
                "replace first-article templates with executed traveler, bench logs, "
                "measurements, limits, serials, operator, fixture calibration, and pass/fail"
            ),
            "validation_command": VALIDATION_COMMAND,
            "release_credit": False,
        },
        {
            "id": "attach_first_article_external_review_metadata",
            "blocked_rows": external_metadata_rows,
            "required_action": (
                "add signed .metadata.yaml companions for binary first-article outputs "
                "with external review authority, approval record, artifact SHA-256, serial "
                "traceability, fixture calibration, limits, and measured results"
            ),
            "validation_command": VALIDATION_COMMAND,
            "release_credit": False,
        },
        {
            "id": "complete_first_article_directory_release_manifests",
            "blocked_rows": directory_manifest_rows,
            "required_action": (
                "replace directory placeholder manifests with approved release manifests "
                "that include board serial, supplier lots, fixture calibration, limits, "
                "measured results, operator, pass/fail disposition, and signoff"
            ),
            "validation_command": VALIDATION_COMMAND,
            "release_credit": False,
        },
        {
            "id": "complete_first_article_approval_metadata_fields",
            "blocked_rows": incomplete_field_rows,
            "top_missing_fields": dict(sorted(missing_fields.most_common(12))),
            "required_action": (
                "fill the highest-count first-article metadata fields first; every record "
                "still needs executed measurements, approved disposition, and signoff"
            ),
            "validation_command": VALIDATION_COMMAND,
            "release_credit": False,
        },
        {
            "id": "approve_and_deplaceholder_first_article_records",
            "blocked_rows": unapproved_or_placeholder_rows,
            "unapproved_rows": unapproved,
            "placeholder_rows": placeholder,
            "required_action": (
                "replace unvalidated first-article candidates with approved, signed, "
                "non-placeholder execution records from serialized routed hardware"
            ),
            "validation_command": VALIDATION_COMMAND,
            "release_credit": False,
        },
    ]


def blocker_diagnostics(
    blocked: list[tuple[str, dict[str, Any], list[str]]],
) -> dict[str, Any]:
    by_owner: Counter[str] = Counter()
    by_evidence_kind: Counter[str] = Counter()
    by_failure: Counter[str] = Counter()
    missing_paths: list[str] = []
    template_paths: list[str] = []
    present_blocked_paths: list[str] = []
    missing_fields_by_path: dict[str, list[str]] = {}
    for path_text, row, failures in blocked:
        owner = row_owner(row)
        by_owner[owner] += 1
        evidence_kind = str(row.get("evidence_kind") or "unknown")
        by_evidence_kind[evidence_kind] += 1
        for failure in failures:
            by_failure[failure] += 1
        if "artifact_missing" in failures:
            missing_paths.append(path_text)
        elif "template_cannot_unlock_release" in failures:
            template_paths.append(path_text)
        else:
            present_blocked_paths.append(path_text)
        missing_fields = [
            failure.split(":", 1)[1]
            for failure in failures
            if failure.startswith("missing_common_field:")
            or failure.startswith("missing_first_article_field:")
            or failure.startswith("missing_external_metadata_field:")
            or failure.startswith("missing_directory_manifest_field:")
        ]
        if missing_fields:
            missing_fields_by_path[path_text] = sorted(missing_fields)
    return {
        "blocked_by_owner": dict(sorted(by_owner.items())),
        "blocked_by_evidence_kind": dict(sorted(by_evidence_kind.items())),
        "blocked_by_failure": dict(sorted(by_failure.items())),
        "missing_paths": sorted(missing_paths),
        "template_paths": sorted(template_paths),
        "present_blocked_paths": sorted(present_blocked_paths),
        "missing_fields_by_path": dict(sorted(missing_fields_by_path.items())),
        "approval_metadata_unblock_summary": approval_metadata_unblock_summary(blocked),
        "first_article_blocker_categories": first_article_blocker_categories(blocked),
        "first_article_execution_packet_count": len(blocked),
        "first_article_execution_packet_required_field_groups": [
            "common_release_metadata",
            "first_article_traceability",
            "approved_disposition",
            "signed_review_or_external_metadata",
        ],
        "first_article_execution_packet_routed_hardware_prerequisites": (
            ROUTED_HARDWARE_PREREQUISITES
        ),
        "next_unblock_groups": [
            {
                "id": "execute_first_article_on_serialized_hardware",
                "owner": "manufacturing_validation",
                "blocked_rows": by_failure.get("artifact_missing", 0),
                "required_action": (
                    "capture executed first-article logs, traveler, fixture calibration, "
                    "limits, operator, measurements, serials, and pass/fail disposition"
                ),
            },
            {
                "id": "replace_first_article_templates",
                "owner": "manufacturing_validation",
                "blocked_rows": by_failure.get("template_cannot_unlock_release", 0),
                "required_action": "replace templates with executed evidence from routed hardware",
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
        parsed, COMMON_FIELDS | FIRST_ARTICLE_FIELDS, "directory_manifest"
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
    return approved_record_failures(
        parsed, METADATA_FIELDS | FIRST_ARTICLE_FIELDS, "external_metadata"
    )


def content_failures(path_text: str, evidence_kind: str) -> list[str]:
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
            f"missing_common_field:{field}" for field in missing_fields(parsed, COMMON_FIELDS)
        )
        failures.extend(
            f"missing_first_article_field:{field}"
            for field in missing_fields(parsed, FIRST_ARTICLE_FIELDS)
        )
    elif suffix == ".csv":
        if not isinstance(parsed, list) or not parsed:
            failures.append("csv_empty")
        else:
            headers = set(parsed[0])
            if not ({"measurement", "limit", "result"} <= headers):
                failures.append("csv_missing_measurement_limit_result_columns")
    elif suffix in {".zip", ".pdf", ".step", ".stp", ".tgz", ".ipc"}:
        failures.extend(companion_metadata_failures(path))

    if evidence_kind == "template":
        failures.append("template_cannot_unlock_release")
    if has_placeholder(parsed):
        failures.append("placeholder_or_blocked_marker_present")
    return sorted(dict.fromkeys(failures))


def main() -> int:
    try:
        matrix = load_yaml_mapping(MATRIX)
        if matrix.get("schema") != EXPECTED_SCHEMA:
            raise ValueError(f"unexpected schema: {matrix.get('schema')!r}")
        summary = matrix.get("summary")
        if not isinstance(summary, dict):
            raise ValueError("summary must be a mapping")
        rows = matrix.get("acceptance_matrix")
        if not isinstance(rows, list) or not rows:
            raise ValueError("acceptance_matrix must be a non-empty list")

        blocked: list[tuple[str, dict[str, Any], list[str]]] = []
        path_exists_count = 0
        content_valid_count = 0
        required = 0
        template_rows = 0
        for index, row in enumerate(rows):
            if not isinstance(row, dict):
                raise ValueError(f"acceptance_matrix[{index}] must be a mapping")
            path_text = row.get("path")
            evidence_kind = row.get("evidence_kind")
            if not isinstance(path_text, str) or not path_text:
                raise ValueError(f"acceptance_matrix[{index}] missing path")
            if not isinstance(evidence_kind, str) or not evidence_kind:
                raise ValueError(f"acceptance_matrix[{index}] missing evidence_kind")
            if row.get("template_only") is True or evidence_kind == "template":
                template_rows += 1
                blocked.append((path_text, row, ["template_cannot_unlock_release"]))
                continue
            required += 1
            if repo_path(path_text).exists():
                path_exists_count += 1
            failures = content_failures(path_text, evidence_kind)
            if failures:
                blocked.append((path_text, row, failures))
            else:
                content_valid_count += 1

        missing = int(summary.get("missing_required_non_template_row_count") or 0)
        blocked_present_count = sum(
            1
            for path_text, _row, _failures in blocked
            if _row.get("template_only") is not True and repo_path(path_text).exists()
        )
        blocked_template_present_count = sum(
            1
            for path_text, row, _failures in blocked
            if row.get("template_only") is True and repo_path(path_text).exists()
        )
        expected_required = int(summary.get("required_non_template_row_count") or 0)
        if required != expected_required:
            raise ValueError(
                f"required non-template count mismatch: rows={required} summary={expected_required}"
            )
        factory_index = factory_output_bridge_index()
        bridge = factory_first_article_bridge(blocked, factory_index)
        generation_summary = repo_generation_summary(blocked)
    except ValueError as exc:
        write_report(
            {
                "schema": "eliza.e1_phone_first_article_content_report.v1",
                "status": "fail",
                "release_credit": False,
                "summary": {"release_ready": False},
                "findings": [
                    {
                        "code": "first_article_content_contract_invalid",
                        "severity": "error",
                        "message": str(exc),
                        "evidence": rel(MATRIX),
                    }
                ],
            }
        )
        print(f"FAIL: E1 phone first-article content contract invalid: {exc}")
        return 1

    if blocked or missing or template_rows:
        write_report(
            {
                "schema": "eliza.e1_phone_first_article_content_report.v1",
                "status": "blocked",
                "release_credit": False,
                "summary": {
                    "release_ready": False,
                    "rows": len(rows),
                    "required": required,
                    "present": content_valid_count,
                    "path_exists_count": path_exists_count,
                    "content_valid_count": content_valid_count,
                    "blocked_present_count": blocked_present_count,
                    "blocked_required_present_count": blocked_present_count,
                    "blocked_template_present_count": blocked_template_present_count,
                    "blocked": len(blocked),
                    "missing": missing,
                    "missing_artifact_count": missing,
                    "templates": template_rows,
                    "release_credit": False,
                    "repo_generated_candidate_blocked_count": generation_summary[
                        "repo_generated_candidate_blocked_count"
                    ],
                    "external_execution_or_approval_required_count": generation_summary[
                        "external_execution_or_approval_required_count"
                    ],
                },
                "findings": [
                    {
                        "code": "first_article_content_blocked",
                        "severity": "blocker",
                        "message": f"{path_text}: {', '.join(failures)}",
                        "evidence": path_text,
                    }
                    for path_text, _row, failures in blocked
                ]
                + (
                    [
                        {
                            "code": "first_article_required_rows_missing",
                            "severity": "blocker",
                            "message": f"{missing} required first-article rows are missing",
                            "evidence": rel(MATRIX),
                        }
                    ]
                    if missing
                    else []
                ),
                "blocked_evidence_inventory": [
                    unblock_action(path_text, row, failures)
                    for path_text, row, failures in blocked
                ],
                "first_article_execution_packet_inventory": (
                    first_article_execution_packet_inventory(blocked, bridge)
                ),
                "blocker_diagnostics": blocker_diagnostics(blocked),
                "first_article_blocker_categories": first_article_blocker_categories(blocked),
                "repo_generation_summary": generation_summary,
                "factory_first_article_bridge": bridge,
                "next_unblock_actions": [
                    unblock_action(path_text, row, failures)
                    for path_text, row, failures in blocked[:20]
                ],
            }
        )
        print(
            "STATUS: BLOCKED E1 phone first-article content "
            f"rows={len(rows)} required={required} path_exists={path_exists_count} "
            f"content_valid={content_valid_count} blocked_present={blocked_present_count} "
            f"blocked={len(blocked)} missing={missing} templates={template_rows}"
        )
        for path_text, _row, failures in blocked[:10]:
            print(f"  - {path_text}: {', '.join(failures)}")
        if len(blocked) > 10:
            print(f"  - ... {len(blocked) - 10} more blocked first-article rows")
        return 2

    write_report(
        {
            "schema": "eliza.e1_phone_first_article_content_report.v1",
            "status": "pass",
            "release_credit": True,
            "summary": {
                "release_ready": True,
                "release_credit": True,
                "rows": len(rows),
                "required": required,
                "present": content_valid_count,
                "path_exists_count": path_exists_count,
                "content_valid_count": content_valid_count,
                "blocked_present_count": 0,
                "blocked": 0,
                "missing": 0,
                "missing_artifact_count": 0,
                "templates": template_rows,
            },
            "findings": [],
        }
    )
    print(f"STATUS: PASS E1 phone first-article content required={required}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
