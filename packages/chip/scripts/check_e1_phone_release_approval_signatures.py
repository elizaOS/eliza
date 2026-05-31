#!/usr/bin/env python3
"""Fail-closed approval/signature gate for E1 phone release evidence rows."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

import yaml

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = (
    ROOT / "board/kicad/e1-phone/production/readiness/"
    "release-evidence-content-contract-2026-05-22.yaml"
)
CANDIDATE_MANIFEST = (
    ROOT / "board/kicad/e1-phone/production/routed-output-candidate-manifest-2026-05-22.yaml"
)
EXPECTED_SCHEMA = "eliza.e1_phone_release_evidence_content_contract.v1"
ROW_SCHEMA = "eliza.e1_phone_release_evidence_artifact_content_requirement.v1"
REPORT = ROOT / "build/reports/e1_phone_release_approval_signatures.json"
READINESS_MATRIX = (
    ROOT / "board/kicad/e1-phone/production/readiness/"
    "release-approval-signature-blocker-matrix-2026-05-23.yaml"
)
REPORT_SCHEMA = "eliza.e1_phone_release_approval_signatures.v1"
READINESS_MATRIX_SCHEMA = "eliza.e1_phone_release_approval_signature_blocker_matrix.v1"
VALIDATION_COMMAND = "python3 scripts/check_e1_phone_release_approval_signatures.py"
CLAIM_BOUNDARY = "e1_phone_release_content_blocker_report_only_not_release_evidence"
MATRIX_CLAIM_BOUNDARY = (
    "Approval/signature blocker matrix only. This file does not grant "
    "fabrication, enclosure, factory, first-article, or release approval."
)
FALSE_CLAIM_FLAGS = {
    "release_claim_allowed": False,
    "release_approval_claim_allowed": False,
    "fabrication_release_claim_allowed": False,
    "enclosure_release_claim_allowed": False,
    "factory_release_claim_allowed": False,
    "first_article_release_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}
SUPPLIER_RETURN_VALIDATION_COMMAND = "python3 scripts/check_e1_phone_supplier_return_content.py"
FIRST_ARTICLE_VALIDATION_COMMAND = "python3 scripts/check_e1_phone_first_article_content.py"
ENCLOSURE_VALIDATION_COMMAND = "python3 scripts/check_e1_phone_enclosure_mechanical_content.py"
ROUTED_OUTPUT_VALIDATION_COMMAND = "python3 scripts/check_e1_phone_routed_output_content.py"
REQUIRED_SIGNED_METADATA_FIELDS = {
    "owner",
    "reviewer",
    "captured_at",
    "revision_or_lot",
    "sha256",
    "traceability_ids",
    "approval_status",
    "validated",
    "release_allowed",
}
FIELD_FAILURES = {
    "owner": "missing_owner",
    "reviewer": "missing_reviewer",
    "captured_at": "missing_captured_at",
    "revision_or_lot": "missing_revision_or_lot",
    "sha256": "missing_sha256",
    "traceability_ids": "missing_traceability_ids",
    "approval_status": "approval_status_not_approved",
    "validated": "row_not_validated",
    "release_allowed": "release_not_allowed",
}
FAILURE_BUCKETS: dict[str, dict[str, str]] = {
    "missing_owner": {
        "bucket": "missing_owner",
        "required_action": "assign the accountable artifact owner before approval",
    },
    "missing_reviewer": {
        "bucket": "missing_reviewer",
        "required_action": "assign an independent reviewer before approval",
    },
    "missing_captured_at": {
        "bucket": "missing_captured_at",
        "required_action": "record the approval capture timestamp after evidence is generated",
    },
    "invalid_captured_at": {
        "bucket": "stale_or_invalid_captured_at",
        "required_action": "replace stale or unparsable capture timestamps with reviewed ISO-8601 evidence timestamps",
    },
    "missing_revision_or_lot": {
        "bucket": "missing_revision_or_lot",
        "required_action": "bind approval to an artifact revision, supplier lot, unit serial, or tool revision",
    },
    "missing_sha256": {
        "bucket": "missing_sha256",
        "required_action": "hash the final approved artifact payload after content validation passes",
    },
    "missing_traceability_ids": {
        "bucket": "missing_traceability_ids",
        "required_action": "attach traceability IDs for the source requirement, lot, serial, ECO, fixture, or vendor return",
    },
    "approval_status_not_approved": {
        "bucket": "missing_or_rejected_approval_disposition",
        "required_action": "record an approved owner/reviewer disposition only after evidence gates pass",
    },
    "release_not_allowed": {
        "bucket": "release_disposition_not_unlocked",
        "required_action": "clear fabrication, enclosure, factory, first-article, and runtime gates before release",
    },
    "row_not_validated": {
        "bucket": "row_not_validated",
        "required_action": "run the content gate and record a validated row state before approval",
    },
    "template_only": {
        "bucket": "template_only",
        "required_action": "replace template-only artifacts with executed or supplier-returned evidence",
    },
    "presence_only": {
        "bucket": "presence_only",
        "required_action": "replace presence-only file checks with content-validated evidence",
    },
    "placeholder_or_blocked_marker_present": {
        "bucket": "placeholder_or_blocked_metadata",
        "required_action": "replace placeholder metadata in owner, reviewer, timestamp, revision, SHA, or traceability fields",
    },
    "invalid_row_schema": {
        "bucket": "invalid_row_schema",
        "required_action": "regenerate the content contract row with the expected schema",
    },
}
APPROVAL_TRACKS: dict[str, dict[str, str]] = {
    "template_only_rows": {
        "owner": "first-article-test-owner",
        "reviewer": "release-quality-reviewer",
        "action": (
            "execute the template on representative hardware, replace the template "
            "artifact with captured evidence, then collect signed approval metadata"
        ),
        "validation_command": FIRST_ARTICLE_VALIDATION_COMMAND,
    },
    "external_supplier_approvals": {
        "owner": "sourcing-owner",
        "reviewer": "supplier-quality-reviewer",
        "action": (
            "collect supplier return evidence, validate the supplier matrix row, "
            "then attach owner/reviewer approval metadata and final artifact hashes"
        ),
        "validation_command": SUPPLIER_RETURN_VALIDATION_COMMAND,
    },
    "repo_generated_evidence_approvals": {
        "owner": "release-engineering-owner",
        "reviewer": "hardware-release-reviewer",
        "action": (
            "regenerate or validate the repo evidence artifact, replace presence-only "
            "state with content validation, then sign the final hash-bound record"
        ),
        "validation_command": VALIDATION_COMMAND,
    },
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


def load_yaml_mapping(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise ValueError(f"missing content contract: {path.relative_to(ROOT)}")
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path.relative_to(ROOT)} must be a YAML mapping")
    return data


def load_optional_yaml_mapping(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    return load_yaml_mapping(path)


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


def approval_placeholder_scope(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "owner": row.get("owner"),
        "reviewer": row.get("reviewer"),
        "captured_at": row.get("captured_at"),
        "revision_or_lot": row.get("revision_or_lot"),
        "sha256": row.get("sha256"),
        "traceability_ids": row.get("traceability_ids"),
    }


def has_traceability_ids(row: dict[str, Any]) -> bool:
    traceability_ids = row.get("traceability_ids")
    if isinstance(traceability_ids, list):
        return any(str(item).strip() for item in traceability_ids)
    if isinstance(traceability_ids, str):
        return bool(traceability_ids.strip())
    return False


def has_valid_captured_at(row: dict[str, Any]) -> bool:
    captured_at = row.get("captured_at")
    if not isinstance(captured_at, str) or not captured_at.strip():
        return False
    normalized = captured_at.strip().replace("Z", "+00:00")
    try:
        datetime.fromisoformat(normalized)
    except ValueError:
        return False
    return True


def approval_signature_failures(row: dict[str, Any]) -> list[str]:
    failures: list[str] = []
    if row.get("schema") != ROW_SCHEMA:
        failures.append("invalid_row_schema")
    if row.get("approval_status") != "approved":
        failures.append("approval_status_not_approved")
    for field in ("owner", "reviewer"):
        if not row.get(field):
            failures.append(f"missing_{field}")
    if not row.get("captured_at"):
        failures.append("missing_captured_at")
    elif not has_valid_captured_at(row):
        failures.append("invalid_captured_at")
    if not row.get("revision_or_lot"):
        failures.append("missing_revision_or_lot")
    if not row.get("sha256"):
        failures.append("missing_sha256")
    if not has_traceability_ids(row):
        failures.append("missing_traceability_ids")
    if row.get("validated") is not True:
        failures.append("row_not_validated")
    if row.get("template_only") is True:
        failures.append("template_only")
    if row.get("presence_only") is True:
        failures.append("presence_only")
    if has_placeholder(approval_placeholder_scope(row)):
        failures.append("placeholder_or_blocked_marker_present")
    return failures


def release_failures(row: dict[str, Any]) -> list[str]:
    if row.get("release_allowed") is True:
        return []
    return ["release_not_allowed"]


def row_failures(row: dict[str, Any]) -> list[str]:
    return approval_signature_failures(row) + release_failures(row)


def evidence_category(evidence_id: str) -> str:
    if ":" in evidence_id:
        return evidence_id.split(":", 1)[0]
    if "/" in evidence_id:
        return evidence_id.split("/", 1)[0]
    return evidence_id


def approval_track_for_row(row: dict[str, Any]) -> str:
    if row.get("template_only") is True:
        return "template_only_rows"
    if row.get("category") == "supplier_return_evidence":
        return "external_supplier_approvals"
    path = str(row.get("path") or "")
    if "/production/sourcing/" in path:
        return "external_supplier_approvals"
    return "repo_generated_evidence_approvals"


def supplier_family_for_row(evidence_id: str, row: dict[str, Any]) -> str:
    if row.get("category") == "supplier_return_evidence" and ":" in evidence_id:
        return evidence_id.split(":", 1)[0]
    path = str(row.get("path") or "")
    if "/production/sourcing/" in path:
        after_sourcing = path.split("/production/sourcing/", 1)[1]
        return after_sourcing.split("/", 1)[0]
    return str(row.get("category") or evidence_category(evidence_id) or "release")


def approval_authority_for_row(evidence_id: str, row: dict[str, Any]) -> str:
    owner = row.get("owner")
    reviewer = row.get("reviewer")
    if owner and reviewer:
        return f"{owner}:{reviewer}"
    category = str(row.get("category") or evidence_category(evidence_id) or "release")
    if category == "supplier_return_evidence":
        return f"sourcing-approval:{supplier_family_for_row(evidence_id, row)}"
    if "enclosure" in category or "mechanical" in category:
        return "mechanical-release-approval"
    if "first_article" in category:
        return "test-release-approval"
    return f"release-approval:{category}"


def validation_commands_for_row(row: dict[str, Any]) -> list[str]:
    commands = [VALIDATION_COMMAND]
    track = approval_track_for_row(row)
    track_command = APPROVAL_TRACKS[track]["validation_command"]
    if track_command not in commands:
        commands.insert(0, track_command)
    category = str(row.get("category") or "")
    if category == "mechanical_enclosure_evidence":
        commands.insert(0, ENCLOSURE_VALIDATION_COMMAND)
    if category == "routed_board_release_evidence":
        commands.insert(0, ROUTED_OUTPUT_VALIDATION_COMMAND)
    if category == "first_article_bench_evidence":
        commands.insert(0, FIRST_ARTICLE_VALIDATION_COMMAND)
    return list(dict.fromkeys(commands))


def missing_signed_metadata_fields(failures: list[str]) -> list[str]:
    return sorted(field for field, failure in FIELD_FAILURES.items() if failure in failures)


def accepted_record_paths_for_row(row: dict[str, Any]) -> list[str]:
    paths = [
        CONTRACT.relative_to(ROOT).as_posix(),
    ]
    path = row.get("path")
    if isinstance(path, str) and path:
        paths.append(path)
    return list(dict.fromkeys(paths))


def approval_track_summary(
    blocked_rows: list[tuple[str, dict[str, Any], list[str]]],
) -> dict[str, Any]:
    grouped: dict[str, list[tuple[str, dict[str, Any], list[str]]]] = {
        track: [] for track in APPROVAL_TRACKS
    }
    for item in blocked_rows:
        _evidence_id, row, _failures = item
        grouped.setdefault(approval_track_for_row(row), []).append(item)

    tracks: dict[str, dict[str, Any]] = {}
    for track, items in sorted(grouped.items()):
        metadata = APPROVAL_TRACKS[track]
        field_counts = Counter(
            field
            for _evidence_id, _row, failures in items
            for field in missing_signed_metadata_fields(failures)
        )
        command_counts = Counter(
            command
            for _evidence_id, row, _failures in items
            for command in validation_commands_for_row(row)
        )
        tracks[track] = {
            "blocked_rows": len(items),
            "owner": metadata["owner"],
            "reviewer": metadata["reviewer"],
            "action": metadata["action"],
            "validation_commands": sorted(command_counts),
            "validation_command_counts": dict(sorted(command_counts.items())),
            "missing_signed_metadata_field_counts": dict(sorted(field_counts.items())),
            "examples": [evidence_id for evidence_id, _row, _failures in items[:5]],
            "release_credit": False,
        }

    return {
        "track_counts": {track: summary["blocked_rows"] for track, summary in tracks.items()},
        "tracks": tracks,
        "repo_generated_evidence_approval_count": tracks["repo_generated_evidence_approvals"][
            "blocked_rows"
        ],
        "external_supplier_approval_count": tracks["external_supplier_approvals"]["blocked_rows"],
        "template_only_row_count": tracks["template_only_rows"]["blocked_rows"],
    }


def signed_metadata_field_summary(
    blocked_rows: list[tuple[str, dict[str, Any], list[str]]],
) -> dict[str, Any]:
    field_counts = Counter(
        field
        for _evidence_id, _row, failures in blocked_rows
        for field in missing_signed_metadata_fields(failures)
    )
    field_examples: dict[str, list[str]] = {}
    for evidence_id, _row, failures in blocked_rows:
        for field in missing_signed_metadata_fields(failures):
            field_examples.setdefault(field, []).append(evidence_id)
    return {
        "field_counts": dict(sorted(field_counts.items())),
        "field_examples": {
            field: examples[:5] for field, examples in sorted(field_examples.items())
        },
        "validation_command": VALIDATION_COMMAND,
        "release_credit": False,
    }


def blocked_row_diagnostics(
    blocked_rows: list[tuple[str, dict[str, Any], list[str]]],
) -> dict[str, Any]:
    failure_counts = Counter(failure for _, _row, failures in blocked_rows for failure in failures)
    category_counts = Counter(
        evidence_category(evidence_id) for evidence_id, _row, _failures in blocked_rows
    )
    owner_counts = Counter(
        str(row.get("owner") or "unassigned") for _id, row, _failures in blocked_rows
    )
    bucket_counts = Counter(
        FAILURE_BUCKETS.get(failure, {"bucket": "uncategorized"})["bucket"]
        for _, _row, failures in blocked_rows
        for failure in failures
    )
    bucket_examples: dict[str, list[str]] = {}
    for evidence_id, _row, failures in blocked_rows:
        for failure in failures:
            bucket = FAILURE_BUCKETS.get(failure, {"bucket": "uncategorized"})["bucket"]
            bucket_examples.setdefault(bucket, []).append(evidence_id)
    first_examples: dict[str, list[str]] = {}
    for evidence_id, _row, failures in blocked_rows:
        for failure in failures:
            first_examples.setdefault(failure, []).append(evidence_id)
    next_unblock_groups = []
    for bucket, count in sorted(bucket_counts.items()):
        failures_for_bucket = sorted(
            failure for failure, metadata in FAILURE_BUCKETS.items() if metadata["bucket"] == bucket
        )
        action = next(
            (
                FAILURE_BUCKETS[failure]["required_action"]
                for failure in failures_for_bucket
                if failure in failure_counts
            ),
            "resolve uncategorized release approval blocker",
        )
        next_unblock_groups.append(
            {
                "id": bucket,
                "blocked_rows": count,
                "failure_codes": failures_for_bucket,
                "examples": bucket_examples.get(bucket, [])[:5],
                "approval_authority": "release-approval:artifact-owner-and-reviewer",
                "required_signed_metadata_fields": sorted(REQUIRED_SIGNED_METADATA_FIELDS),
                "required_action": action,
                "validation_command": VALIDATION_COMMAND,
                "release_credit": False,
            }
        )
    approval_blocker_categories = {
        group["id"]: {
            "blocked_rows": group["blocked_rows"],
            "failure_codes": group["failure_codes"],
            "required_action": group["required_action"],
            "required_signed_metadata_fields": group["required_signed_metadata_fields"],
            "examples": group["examples"],
            "release_credit": False,
        }
        for group in next_unblock_groups
    }
    track_summary = approval_track_summary(blocked_rows)
    metadata_summary = signed_metadata_field_summary(blocked_rows)
    return {
        "failure_counts": dict(sorted(failure_counts.items())),
        "blocker_bucket_counts": dict(sorted(bucket_counts.items())),
        "approval_blocker_categories": approval_blocker_categories,
        "approval_track_counts": track_summary["track_counts"],
        "approval_track_summaries": track_summary["tracks"],
        "repo_generated_evidence_approval_count": track_summary[
            "repo_generated_evidence_approval_count"
        ],
        "external_supplier_approval_count": track_summary["external_supplier_approval_count"],
        "template_only_row_count": track_summary["template_only_row_count"],
        "signed_metadata_field_summary": metadata_summary,
        "blocked_category_counts": dict(sorted(category_counts.items())),
        "blocked_owner_counts": dict(sorted(owner_counts.items())),
        "top_failure_examples": {
            failure: examples[:5] for failure, examples in sorted(first_examples.items())
        },
        "next_unblock_groups": next_unblock_groups,
    }


def blocked_row_inventory(
    blocked_rows: list[tuple[str, dict[str, Any], list[str]]],
) -> list[dict[str, Any]]:
    inventory: list[dict[str, Any]] = []
    for evidence_id, row, failures in blocked_rows:
        missing_fields = sorted(
            failure.removeprefix("missing_")
            for failure in failures
            if failure.startswith("missing_")
        )
        inventory.append(
            {
                "evidence_id": evidence_id,
                "category": evidence_category(evidence_id),
                "approval_track": approval_track_for_row(row),
                "supplier_family": supplier_family_for_row(evidence_id, row),
                "path": row.get("path"),
                "accepted_record_paths": accepted_record_paths_for_row(row),
                "owner": row.get("owner") or "unassigned",
                "reviewer": row.get("reviewer") or "unassigned",
                "approval_authority": approval_authority_for_row(evidence_id, row),
                "approval_status": row.get("approval_status"),
                "traceability_ids": row.get("traceability_ids") or [],
                "release_allowed": row.get("release_allowed") is True,
                "validated": row.get("validated") is True,
                "template_only": row.get("template_only") is True,
                "presence_only": row.get("presence_only") is True,
                "required_signed_metadata_fields": sorted(REQUIRED_SIGNED_METADATA_FIELDS),
                "missing_fields": missing_fields,
                "missing_signed_metadata_fields": missing_signed_metadata_fields(failures),
                "failures": failures,
                "action": (
                    "Capture validated release evidence with owner, reviewer, timestamp, "
                    "revision or lot, SHA-256, approval, and top-level release gate clearance."
                ),
                "owner_action_summary": APPROVAL_TRACKS[approval_track_for_row(row)]["action"],
                "validation_command": VALIDATION_COMMAND,
                "validation_commands": validation_commands_for_row(row),
                "release_credit": False,
            }
        )
    return inventory


def candidate_manifest_paths(candidate_manifest: dict[str, Any]) -> set[str]:
    paths: set[str] = set()
    for artifact in candidate_manifest.get("artifacts", []):
        if not isinstance(artifact, dict):
            continue
        path = artifact.get("path")
        if isinstance(path, str) and path:
            paths.add(path)
        metadata = artifact.get("metadata")
        if isinstance(metadata, str) and metadata:
            paths.add(metadata)
    return paths


def candidate_path_violations(
    rows: list[dict[str, Any]],
    candidate_manifest: dict[str, Any],
) -> list[str]:
    candidate_paths = candidate_manifest_paths(candidate_manifest)
    return sorted(
        str(row.get("path"))
        for row in rows
        if isinstance(row, dict)
        and isinstance(row.get("path"), str)
        and row["path"] in candidate_paths
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fail-closed approval/signature gate for E1 phone release evidence rows."
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=REPORT,
        help="JSON report path to write.",
    )
    return parser.parse_args()


def write_report(
    status: str,
    *,
    report_path: Path,
    rows: int,
    approval_valid_rows: int,
    approval_invalid_rows: int,
    release_allowed_rows: int,
    release_blocked_rows: int,
    blocked_rows: int,
    diagnostics: dict[str, Any] | None = None,
    blocked_inventory: list[dict[str, Any]] | None = None,
    finding: str | None = None,
) -> None:
    findings = []
    if finding:
        findings.append(
            {
                "code": "e1_phone_release_approvals_missing",
                "evidence": CONTRACT.relative_to(ROOT).as_posix(),
                "message": finding,
                "next_step": "make e1-phone-release-approval-signature-check",
                "severity": "blocker" if status == "blocked" else "info",
            }
        )
    report = {
        "schema": REPORT_SCHEMA,
        "status": status,
        "generated_utc": datetime.now(UTC).isoformat(),
        "release_credit": False,
        "claim_boundary": CLAIM_BOUNDARY,
        **FALSE_CLAIM_FLAGS,
        "approval_contract": {
            "content_contract": CONTRACT.relative_to(ROOT).as_posix(),
            "required_signed_metadata_fields": sorted(REQUIRED_SIGNED_METADATA_FIELDS),
            "validation_command": VALIDATION_COMMAND,
        },
        "summary": {
            "release_ready": status == "pass",
            "rows": rows,
            "approval_valid": approval_valid_rows,
            "approval_invalid": approval_invalid_rows,
            "release_allowed": release_allowed_rows,
            "release_blocked": release_blocked_rows,
            "blocked": blocked_rows,
            "blockers": len(findings),
            **(diagnostics or {}),
        },
        "findings": findings,
        "blocked_evidence_inventory": blocked_inventory or [],
        "blocker_dependency_counts": {
            "repo_artifact_generation": 0,
            "live_device_validation": 0,
            "actionable_external_dependency": blocked_rows,
        },
        "next_command_by_dependency": {
            "actionable_external_dependency": [VALIDATION_COMMAND],
        },
        "validation_commands": [
            VALIDATION_COMMAND,
            SUPPLIER_RETURN_VALIDATION_COMMAND,
            FIRST_ARTICLE_VALIDATION_COMMAND,
            ENCLOSURE_VALIDATION_COMMAND,
            ROUTED_OUTPUT_VALIDATION_COMMAND,
        ],
        "primary_blocker": {
            "dependency": "actionable_external_dependency",
            "blocked_rows": blocked_rows,
            "required_action": (
                "Validate each underlying supplier, routed, enclosure, or first-article "
                "evidence row, then attach approved owner/reviewer metadata and final hashes."
            ),
            "validation_command": VALIDATION_COMMAND,
            "release_credit": False,
        },
        "next_unblock_actions": (blocked_inventory or [])[:20],
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    if report_path.resolve() != REPORT.resolve():
        return
    matrix = {
        "schema": READINESS_MATRIX_SCHEMA,
        "status": status,
        "date": "2026-05-23",
        "claim_boundary": MATRIX_CLAIM_BOUNDARY,
        **FALSE_CLAIM_FLAGS,
        "inputs": {
            "content_contract": CONTRACT.relative_to(ROOT).as_posix(),
            "json_report": REPORT.relative_to(ROOT).as_posix(),
            "validation_command": VALIDATION_COMMAND,
        },
        "summary": {
            **cast("dict[str, Any]", report["summary"]),
            "release_credit": False,
        },
        "blocker_buckets": (diagnostics or {}).get("next_unblock_groups", []),
        "approval_tracks": (diagnostics or {}).get("approval_track_summaries", {}),
        "signed_metadata_field_summary": (diagnostics or {}).get(
            "signed_metadata_field_summary", {}
        ),
        "blocked_evidence_inventory": blocked_inventory or [],
    }
    READINESS_MATRIX.write_text(
        yaml.safe_dump(matrix, sort_keys=False),
        encoding="utf-8",
    )


def main() -> int:
    args = parse_args()
    try:
        contract = load_yaml_mapping(CONTRACT)
        if contract.get("schema") != EXPECTED_SCHEMA:
            raise ValueError(f"unexpected schema: {contract.get('schema')!r}")
        rows = contract.get("artifact_content_requirements")
        if not isinstance(rows, list) or not rows:
            raise ValueError("artifact_content_requirements must be a non-empty list")
        candidate_manifest = load_optional_yaml_mapping(CANDIDATE_MANIFEST)
        candidate_violations = candidate_path_violations(rows, candidate_manifest)
        if candidate_violations:
            raise ValueError(
                "local generated candidate paths are approval/signature ineligible: "
                + ", ".join(candidate_violations[:10])
            )

        blocked_rows: list[tuple[str, dict[str, Any], list[str]]] = []
        approval_valid_rows = 0
        approval_invalid_rows = 0
        release_allowed_rows = 0
        release_blocked_rows = 0
        for index, row in enumerate(rows):
            if not isinstance(row, dict):
                raise ValueError(f"row {index}: expected mapping")
            approval_failures = approval_signature_failures(row)
            row_release_failures = release_failures(row)
            if approval_failures:
                approval_invalid_rows += 1
            else:
                approval_valid_rows += 1
            if row_release_failures:
                release_blocked_rows += 1
            else:
                release_allowed_rows += 1
            combined_failures = approval_failures + row_release_failures
            if combined_failures:
                evidence_id = str(row.get("evidence_id") or f"row_{index}")
                blocked_rows.append((evidence_id, row, combined_failures))
    except ValueError as exc:
        write_report(
            "fail",
            report_path=args.report,
            rows=0,
            approval_valid_rows=0,
            approval_invalid_rows=0,
            release_allowed_rows=0,
            release_blocked_rows=0,
            blocked_rows=1,
            diagnostics={},
            blocked_inventory=[],
            finding=f"E1 phone release approval signature contract invalid: {exc}",
        )
        print(f"FAIL: E1 phone release approval signature contract invalid: {exc}")
        return 1

    if blocked_rows:
        write_report(
            "blocked",
            report_path=args.report,
            rows=len(rows),
            approval_valid_rows=approval_valid_rows,
            approval_invalid_rows=approval_invalid_rows,
            release_allowed_rows=release_allowed_rows,
            release_blocked_rows=release_blocked_rows,
            blocked_rows=len(blocked_rows),
            diagnostics=blocked_row_diagnostics(blocked_rows),
            blocked_inventory=blocked_row_inventory(blocked_rows),
            finding=(
                "E1 phone release approval signatures are blocked; "
                "no rows have approved release evidence."
            ),
        )
        print(
            "STATUS: BLOCKED E1 phone release approval signatures "
            f"rows={len(rows)} approval_valid={approval_valid_rows} "
            f"approval_invalid={approval_invalid_rows} release_allowed={release_allowed_rows} "
            f"release_blocked={release_blocked_rows} blocked={len(blocked_rows)}"
        )
        for evidence_id, _row, failures in blocked_rows[:10]:
            print(f"  - {evidence_id}: {', '.join(failures)}")
        if len(blocked_rows) > 10:
            print(f"  - ... {len(blocked_rows) - 10} more blocked rows")
        return 2

    write_report(
        "pass",
        report_path=args.report,
        rows=len(rows),
        approval_valid_rows=approval_valid_rows,
        approval_invalid_rows=approval_invalid_rows,
        release_allowed_rows=release_allowed_rows,
        release_blocked_rows=release_blocked_rows,
        blocked_rows=0,
        diagnostics=blocked_row_diagnostics([]),
        blocked_inventory=[],
    )
    print(
        "STATUS: PASS E1 phone release approval signatures "
        f"rows={len(rows)} approval_valid={approval_valid_rows} "
        f"release_allowed={release_allowed_rows}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
