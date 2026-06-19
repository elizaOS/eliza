#!/usr/bin/env python3
"""Fail-closed content gate for E1 phone supplier-return evidence."""

from __future__ import annotations

import csv
import json
from collections import Counter
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
MATRIX = (
    ROOT / "board/kicad/e1-phone/production/sourcing/readiness/"
    "supplier-return-evidence-acceptance-matrix-2026-05-22.yaml"
)
REPORT = ROOT / "build/reports/e1_phone_supplier_return_content.json"
EXPECTED_SCHEMA = "eliza.e1_phone_supplier_return_evidence_acceptance_matrix.v1"
SUPPLIER_METADATA_FIELDS = {
    "supplier_name",
    "supplier_part_number",
    "manufacturer_part_number",
    "drawing_revision",
    "sample_lot_or_quote_id",
    "signed_supplier_response",
    "pinout_or_land_pattern_source",
    "mechanical_model_source",
}
COMMON_RELEASE_FIELDS = {
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
VALIDATION_COMMAND = "python3 scripts/check_e1_phone_supplier_return_content.py"
APPROVAL_AUTHORITY_PREFIX = "sourcing-approval"
FALSE_CLAIM_FLAGS = {
    "claim_allowed": False,
    "release_claim_allowed": False,
    "supplier_return_claim_allowed": False,
    "fabrication_claim_allowed": False,
    "production_claim_allowed": False,
}
SUPPLIER_RETURN_EVIDENCE_CLASSES = {
    "rfq_response_pack",
    "signed_2d_drawing",
    "pinout_or_pad_map",
    "recommended_land_pattern",
    "step_or_brep_model",
    "sample_lot_tracking",
    "incoming_inspection",
    "lifecycle_stock_quote",
    "compliance_pack_index",
}
DOWNSTREAM_RELEASE_EVIDENCE_CLASSES = {
    "pinout_review_signoff",
    "symbol_review",
    "footprint_review",
    "footprint_3d_binding",
    "production_schematic_capture",
    "erc_after_capture",
    "drc_after_footprint_replacement",
    "routed_clearance_or_functional_release",
}
MISSING_APPROVAL_FAILURE_PREFIXES = (
    "missing_common_field:",
    "missing_supplier_field:",
    "missing_external_metadata_field:",
    "missing_external_metadata_supplier_field:",
    "missing_downstream_release_field:",
    "missing_downstream_release_supplier_field:",
    "missing_csv_column:",
)
MISSING_APPROVAL_FAILURES = {
    "missing_external_signed_review_metadata",
    "external_signed_review_metadata_empty",
}


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def repo_path(path_text: str) -> Path:
    path = Path(path_text)
    if path.is_absolute():
        return path
    if path_text.startswith("packages/chip/"):
        return (ROOT.parents[1] if len(ROOT.parents) > 1 else ROOT) / path
    return ROOT / path


def report_path(path: Path) -> str:
    try:
        return rel(path)
    except ValueError:
        return path.as_posix()


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
    if suffix in {".pdf", ".step", ".stp", ".brep"}:
        return {"binary_or_cad_artifact": True}
    return path.read_text(encoding="utf-8")


def parse_release_record_candidate(path: Path) -> Any:
    if path.suffix.lower() not in {".yaml", ".yml", ".json", ".csv"}:
        try:
            return yaml.safe_load(path.read_text(encoding="utf-8"))
        except Exception:
            return path.read_text(encoding="utf-8", errors="replace")
    try:
        return parse_file(path)
    except Exception:
        try:
            return yaml.safe_load(path.read_text(encoding="utf-8"))
        except Exception:
            return path.read_text(encoding="utf-8", errors="replace")


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


def raw_text_or_empty(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return ""


def release_credit_false(value: Any) -> bool:
    if isinstance(value, dict):
        if value.get("release_credit") is False:
            return True
        return any(release_credit_false(item) for item in value.values())
    if isinstance(value, list):
        return any(release_credit_false(item) for item in value)
    if isinstance(value, str):
        return value.strip().lower() in {"false", "no", "0"}
    return False


def explicit_fail_closed_candidate(path: Path) -> bool:
    if not path.is_file():
        return False
    parsed: Any
    try:
        parsed = parse_release_record_candidate(path)
    except Exception:
        parsed = None
    if release_credit_false(parsed):
        return True
    text = raw_text_or_empty(path).lower()
    return "release_credit: false" in text or "blocked_pending_" in text


def template_only_candidate(path: Path) -> bool:
    if not path.is_file():
        return False
    if "template" in path.name.lower():
        return True
    try:
        parsed = parse_release_record_candidate(path)
    except Exception:
        parsed = raw_text_or_empty(path)
    haystack = " ".join(scalar_text(parsed)).lower()
    return (
        "intake_template" in haystack
        or "outbound_template" in haystack
        or "outbound_template_not_supplier_evidence" in haystack
    )


def write_report(payload: dict[str, Any]) -> None:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def accepted_record_targets(expected_path: str) -> dict[str, Any]:
    path = repo_path(expected_path)
    suffix = path.suffix.lower()
    if suffix in {".pdf", ".step", ".stp", ".brep", ".csv"}:
        metadata = path.with_suffix(path.suffix + ".metadata.yaml")
        return {
            "record_type": "external_supplier_return_with_signed_metadata",
            "primary_record_path": report_path(metadata),
            "accepted_record_paths": [report_path(path), report_path(metadata)],
            "present_record_paths": [
                report_path(candidate) for candidate in (path, metadata) if candidate.is_file()
            ],
        }
    return {
        "record_type": "inline_supplier_release_record",
        "primary_record_path": expected_path,
        "accepted_record_paths": [expected_path],
        "present_record_paths": [expected_path] if path.is_file() else [],
    }


def evidence_group(evidence_class: str) -> str:
    if evidence_class in SUPPLIER_RETURN_EVIDENCE_CLASSES:
        return "supplier_return"
    if evidence_class in DOWNSTREAM_RELEASE_EVIDENCE_CLASSES:
        return "downstream_release_evidence"
    return "unknown"


def unblock_action(
    lane: str,
    evidence_class: str,
    expected_path: str,
    failures: list[str],
) -> dict[str, Any]:
    missing = "artifact_missing" in failures
    group = evidence_group(evidence_class)
    action = (
        "Collect the signed supplier return artifact at the expected intake path, then rerun validation."
        if missing
        else (
            "Replace the downstream placeholder with the executed KiCad/release review "
            "record that is traceable to approved supplier returns, then rerun validation."
            if group == "downstream_release_evidence"
            else "Replace the placeholder/unapproved intake with reviewed supplier metadata and approvals, then rerun validation."
        )
    )
    return {
        "lane": lane,
        "supplier_family": lane,
        "evidence_group": group,
        "evidence_class": evidence_class,
        "expected_path": expected_path,
        "owner": f"sourcing:{lane}",
        "approval_authority": f"{APPROVAL_AUTHORITY_PREFIX}:{lane}",
        "accepted_record_targets": accepted_record_targets(expected_path),
        "required_signed_metadata_fields": {
            "common_release_record": sorted(COMMON_RELEASE_FIELDS),
            "supplier_traceability": sorted(SUPPLIER_METADATA_FIELDS),
            "external_signed_review_metadata": sorted(
                COMMON_RELEASE_FIELDS | SUPPLIER_METADATA_FIELDS
            ),
        },
        "missing_artifact": missing,
        "failures": failures,
        "action": action,
        "validation_command": VALIDATION_COMMAND,
        "release_credit": False,
    }


def approval_metadata_unblock_summary(
    blocked: list[tuple[str, str, str, list[str]]],
) -> list[dict[str, Any]]:
    missing_review_metadata = 0
    missing_fields: Counter[str] = Counter()
    unapproved = 0
    placeholder = 0
    for _lane, _evidence_class, _expected_path, failures in blocked:
        if "missing_external_signed_review_metadata" in failures:
            missing_review_metadata += 1
        if any(failure.endswith("disposition_not_approved") for failure in failures):
            unapproved += 1
        if any(failure.endswith("placeholder_or_blocked_marker_present") for failure in failures):
            placeholder += 1
        for failure in failures:
            if "_field:" in failure or failure.startswith("missing_csv_column:"):
                missing_fields[failure.split(":", 1)[1]] += 1

    return [
        {
            "id": "attach_external_signed_review_metadata",
            "blocked_rows": missing_review_metadata,
            "approval_authority": f"{APPROVAL_AUTHORITY_PREFIX}:supplier-family-owner",
            "required_signed_metadata_fields": sorted(
                COMMON_RELEASE_FIELDS | SUPPLIER_METADATA_FIELDS
            ),
            "required_action": (
                "add .metadata.yaml companions for CSV/PDF/STEP/B-rep supplier returns "
                "with supplier identity, drawing/sample traceability, reviewer, reviewed_at, "
                "approved disposition, and signature records"
            ),
            "validation_command": VALIDATION_COMMAND,
            "release_credit": False,
        },
        {
            "id": "complete_supplier_approval_metadata_fields",
            "blocked_rows": sum(missing_fields.values()),
            "top_missing_fields": dict(sorted(missing_fields.most_common(12))),
            "approval_authority": f"{APPROVAL_AUTHORITY_PREFIX}:supplier-family-owner",
            "required_signed_metadata_fields": sorted(
                COMMON_RELEASE_FIELDS | SUPPLIER_METADATA_FIELDS
            ),
            "required_action": (
                "fill the highest-count missing supplier metadata fields first; every "
                "record still needs approved disposition and non-placeholder source data"
            ),
            "validation_command": VALIDATION_COMMAND,
            "release_credit": False,
        },
        {
            "id": "approve_and_deplaceholder_supplier_records",
            "blocked_rows": unapproved + placeholder,
            "unapproved_rows": unapproved,
            "placeholder_rows": placeholder,
            "approval_authority": f"{APPROVAL_AUTHORITY_PREFIX}:supplier-family-owner",
            "required_signed_metadata_fields": sorted(
                COMMON_RELEASE_FIELDS | SUPPLIER_METADATA_FIELDS
            ),
            "required_action": (
                "replace draft/blocked/placeholder supplier intake with reviewed, signed, "
                "approved supplier returns"
            ),
            "validation_command": VALIDATION_COMMAND,
            "release_credit": False,
        },
    ]


def has_missing_approval_metadata(failures: list[str]) -> bool:
    return any(
        failure in MISSING_APPROVAL_FAILURES
        or failure.startswith(MISSING_APPROVAL_FAILURE_PREFIXES)
        or failure.startswith("external_signed_review_metadata_parse_failed:")
        for failure in failures
    )


def has_unapproved_or_placeholder(failures: list[str]) -> bool:
    return any(
        failure.endswith("disposition_not_approved")
        or failure.endswith("placeholder_or_blocked_marker_present")
        or failure == "unsupported_supplier_artifact_type"
        for failure in failures
    )


def blocker_category_flags(expected_path: str, failures: list[str]) -> set[str]:
    path = repo_path(expected_path)
    flags: set[str] = set()
    if "artifact_missing" in failures:
        return {"true_missing_supplier_return_artifacts"}
    if template_only_candidate(path):
        flags.add("template_only_rows")
    if has_missing_approval_metadata(failures):
        flags.add("missing_approval_metadata")
    if explicit_fail_closed_candidate(path):
        flags.add("candidate_present_but_blocked")
    elif path.is_file():
        flags.add("present_without_explicit_fail_closed_metadata")
    if has_unapproved_or_placeholder(failures):
        flags.add("present_unapproved_or_placeholder")
    if any(failure.endswith("release_credit_not_explicitly_false") for failure in failures):
        flags.add("release_credit_not_explicitly_false")
    return flags or {"present_blocked_uncategorized"}


def primary_blocker_category(expected_path: str, failures: list[str]) -> str:
    flags = blocker_category_flags(expected_path, failures)
    for category in (
        "true_missing_supplier_return_artifacts",
        "template_only_rows",
        "missing_approval_metadata",
        "candidate_present_but_blocked",
        "present_unapproved_or_placeholder",
        "present_without_explicit_fail_closed_metadata",
        "release_credit_not_explicitly_false",
    ):
        if category in flags:
            return category
    return "present_blocked_uncategorized"


def blocker_category_diagnostics(
    blocked: list[tuple[str, str, str, list[str]]],
) -> dict[str, Any]:
    all_categories = (
        "true_missing_supplier_return_artifacts",
        "missing_approval_metadata",
        "candidate_present_but_blocked",
        "present_unapproved_or_placeholder",
        "template_only_rows",
        "release_credit_not_explicitly_false",
        "present_without_explicit_fail_closed_metadata",
        "present_blocked_uncategorized",
    )
    categories: Counter[str] = Counter()
    primary_categories: Counter[str] = Counter()
    by_lane: dict[str, Counter[str]] = {}
    for lane, _evidence_class, expected_path, failures in blocked:
        flags = blocker_category_flags(expected_path, failures)
        categories.update(flags)
        primary = primary_blocker_category(expected_path, failures)
        primary_categories[primary] += 1
        by_lane.setdefault(lane, Counter())[primary] += 1
    return {
        "supplier_return_blocker_categories": {
            category: categories.get(category, 0) for category in all_categories
        },
        "primary_supplier_return_blocker_categories": {
            category: primary_categories.get(category, 0) for category in all_categories
        },
        "primary_supplier_return_blocker_categories_by_lane": {
            lane: dict(sorted(counter.items())) for lane, counter in sorted(by_lane.items())
        },
    }


def blocker_diagnostics(
    blocked: list[tuple[str, str, str, list[str]]],
) -> dict[str, Any]:
    by_lane = Counter(lane for lane, _evidence_class, _expected_path, _failures in blocked)
    by_evidence_class = Counter(
        evidence_class for _lane, evidence_class, _expected_path, _failures in blocked
    )
    by_evidence_group = Counter(
        evidence_group(evidence_class)
        for _lane, evidence_class, _expected_path, _failures in blocked
    )
    by_failure = Counter(
        failure
        for _lane, _evidence_class, _expected_path, failures in blocked
        for failure in failures
    )
    missing_paths_by_lane: dict[str, list[str]] = {}
    present_blocked_paths_by_lane: dict[str, list[str]] = {}
    for lane, _evidence_class, expected_path, failures in blocked:
        if "artifact_missing" in failures:
            missing_paths_by_lane.setdefault(lane, []).append(expected_path)
        else:
            present_blocked_paths_by_lane.setdefault(lane, []).append(expected_path)
    diagnostics = {
        "blocked_by_lane": dict(sorted(by_lane.items())),
        "blocked_by_evidence_group": dict(sorted(by_evidence_group.items())),
        "blocked_by_evidence_class": dict(sorted(by_evidence_class.items())),
        "blocked_by_failure": dict(sorted(by_failure.items())),
        "external_supplier_dependency_summary": {
            "external_supplier_return_rows": by_evidence_group.get("supplier_return", 0),
            "downstream_release_rows_waiting_on_supplier_returns": by_evidence_group.get(
                "downstream_release_evidence", 0
            ),
            "true_missing_supplier_return_artifacts": by_failure.get("artifact_missing", 0),
            "missing_signed_review_metadata": by_failure.get(
                "missing_external_signed_review_metadata", 0
            ),
            "unapproved_or_placeholder_rows": sum(
                count
                for failure, count in by_failure.items()
                if failure.endswith("disposition_not_approved")
                or failure.endswith("placeholder_or_blocked_marker_present")
            ),
            "validation_command": VALIDATION_COMMAND,
        },
        "missing_paths_by_lane": {
            lane: sorted(paths) for lane, paths in sorted(missing_paths_by_lane.items())
        },
        "present_blocked_paths_by_lane": {
            lane: sorted(paths) for lane, paths in sorted(present_blocked_paths_by_lane.items())
        },
        "approval_metadata_unblock_summary": approval_metadata_unblock_summary(blocked),
        "next_unblock_groups": [
            {
                "id": "collect_signed_supplier_returns",
                "owner": "sourcing",
                "blocked_rows": by_failure.get("artifact_missing", 0),
                "approval_authority": f"{APPROVAL_AUTHORITY_PREFIX}:supplier-family-owner",
                "required_signed_metadata_fields": sorted(
                    COMMON_RELEASE_FIELDS | SUPPLIER_METADATA_FIELDS
                ),
                "validation_command": VALIDATION_COMMAND,
                "release_credit": False,
                "required_action": (
                    "collect signed supplier RFQ/quote/sample/drawing/model returns at the "
                    "expected intake paths"
                ),
                "next_commands": [
                    "python3 scripts/check_e1_phone_supplier_return_content.py",
                    "python3 scripts/check_e1_phone_release_approval_signatures.py",
                ],
            },
            {
                "id": "complete_supplier_metadata_and_approvals",
                "owner": "sourcing",
                "blocked_rows": sum(
                    count
                    for failure, count in by_failure.items()
                    if failure.startswith("missing_supplier_field:")
                    or failure.startswith("missing_common_field:")
                    or failure == "disposition_not_approved"
                    or failure == "placeholder_or_blocked_marker_present"
                ),
                "approval_authority": f"{APPROVAL_AUTHORITY_PREFIX}:supplier-family-owner",
                "required_signed_metadata_fields": sorted(
                    COMMON_RELEASE_FIELDS | SUPPLIER_METADATA_FIELDS
                ),
                "validation_command": VALIDATION_COMMAND,
                "release_credit": False,
                "required_action": (
                    "replace placeholder supplier intake with reviewed metadata, supplier "
                    "traceability, and approved disposition"
                ),
                "next_commands": [
                    "python3 scripts/check_e1_phone_supplier_return_content.py",
                    "python3 scripts/check_e1_phone_release_approval_signatures.py",
                ],
            },
            {
                "id": "replace_downstream_release_placeholders",
                "owner": "sourcing:kicad-release",
                "blocked_rows": by_evidence_group.get("downstream_release_evidence", 0),
                "approval_authority": f"{APPROVAL_AUTHORITY_PREFIX}:supplier-family-owner",
                "required_signed_metadata_fields": sorted(
                    COMMON_RELEASE_FIELDS | SUPPLIER_METADATA_FIELDS
                ),
                "validation_command": VALIDATION_COMMAND,
                "release_credit": False,
                "required_action": (
                    "replace fail-closed KiCad/release placeholders with executed, "
                    "approved review records that trace back to signed supplier returns"
                ),
                "next_commands": [
                    "python3 scripts/check_e1_phone_supplier_return_content.py",
                    "python3 scripts/check_e1_phone_routed_output_content.py",
                    "python3 scripts/check_e1_phone_fabrication_release.py",
                ],
            },
        ],
    }
    diagnostics.update(blocker_category_diagnostics(blocked))
    return diagnostics


def mapping_missing_fields(data: Any, fields: set[str]) -> list[str]:
    if not isinstance(data, dict):
        return sorted(fields)
    return sorted(field for field in fields if not data.get(field))


def approved_supplier_record_failures(data: Any, prefix: str) -> list[str]:
    common_missing_prefix = (
        "missing_common_field" if prefix == "common" else f"missing_{prefix}_field"
    )
    supplier_missing_prefix = (
        "missing_supplier_field" if prefix == "common" else f"missing_{prefix}_supplier_field"
    )
    disposition_failure = (
        "disposition_not_approved" if prefix == "common" else f"{prefix}_disposition_not_approved"
    )
    placeholder_failure = (
        "placeholder_or_blocked_marker_present"
        if prefix == "common"
        else f"{prefix}_placeholder_or_blocked_marker_present"
    )
    failures: list[str] = []
    failures.extend(
        f"{common_missing_prefix}:{field}"
        for field in mapping_missing_fields(data, COMMON_RELEASE_FIELDS)
    )
    failures.extend(
        f"{supplier_missing_prefix}:{field}"
        for field in mapping_missing_fields(data, SUPPLIER_METADATA_FIELDS)
    )
    if isinstance(data, dict) and data.get("disposition") != "approved":
        failures.append(disposition_failure)
    if has_placeholder(data):
        failures.append(placeholder_failure)
    return failures


def external_metadata_failures(path: Path) -> list[str]:
    companion = path.with_suffix(path.suffix + ".metadata.yaml")
    if not companion.is_file():
        return ["missing_external_signed_review_metadata"]
    if companion.stat().st_size == 0:
        return ["external_signed_review_metadata_empty"]
    try:
        metadata = load_yaml_mapping(companion)
    except Exception as exc:  # noqa: BLE001 - this is a release gate error surface.
        return [f"external_signed_review_metadata_parse_failed:{type(exc).__name__}"]
    return approved_supplier_record_failures(metadata, "external_metadata")


def downstream_release_record_failures(parsed: Any) -> list[str]:
    if not isinstance(parsed, dict):
        return ["downstream_release_evidence_not_structured_review_record"]
    failures = approved_supplier_record_failures(parsed, "downstream_release")
    if parsed.get("release_credit") is not False:
        failures.append("downstream_release_credit_not_explicitly_false")
    if not parsed.get("expected_intake_path") and not parsed.get("artifact_id"):
        failures.append("downstream_release_traceability_missing")
    return failures


def evidence_failures(
    lane: str,
    evidence: dict[str, Any],
    function: str | None = None,
) -> list[str]:
    failures: list[str] = []
    expected_path = evidence.get("expected_local_intake_path")
    if not isinstance(expected_path, str) or not expected_path:
        failures.append("missing_expected_local_intake_path")
        return failures
    path = repo_path(expected_path)
    if not path.is_file():
        failures.append("artifact_missing")
        return failures
    evidence_class = str(evidence.get("evidence_class") or "")
    group = evidence_group(evidence_class)

    suffix = path.suffix.lower()
    if group == "downstream_release_evidence":
        parsed = parse_release_record_candidate(path)
        failures.extend(downstream_release_record_failures(parsed))
        if has_placeholder(parsed):
            failures.append("downstream_release_placeholder_or_blocked_marker_present")
    else:
        try:
            parsed = parse_file(path)
        except Exception as exc:  # noqa: BLE001 - this is a release gate error surface.
            failures.append(f"artifact_parse_failed:{type(exc).__name__}")
            return failures

        if suffix in {".yaml", ".yml", ".json"}:
            failures.extend(approved_supplier_record_failures(parsed, "common"))
        elif suffix == ".csv":
            if not isinstance(parsed, list) or not parsed:
                failures.append("csv_empty")
            else:
                headers = set(parsed[0])
                missing = {"net_or_pin", "supplier_pin_name", "source_revision"} - headers
                failures.extend(f"missing_csv_column:{field}" for field in sorted(missing))
            failures.extend(external_metadata_failures(path))
        elif suffix in {".pdf", ".step", ".stp", ".brep"}:
            failures.extend(external_metadata_failures(path))
        else:
            failures.append("unsupported_supplier_artifact_type")

        if has_placeholder(parsed):
            failures.append("placeholder_or_blocked_marker_present")
    if path.stat().st_size == 0:
        failures.append("artifact_empty")
    valid_scopes = {lane.lower()}
    if function:
        valid_scopes.add(function.lower())
    if group == "supplier_return" and not any(
        scope in expected_path.lower() for scope in valid_scopes
    ):
        failures.append("artifact_path_not_lane_scoped")
    return list(dict.fromkeys(failures))


def main() -> int:
    try:
        matrix = load_yaml_mapping(MATRIX)
        if matrix.get("schema") != EXPECTED_SCHEMA:
            raise ValueError(f"unexpected schema: {matrix.get('schema')!r}")
        rows = matrix.get("acceptance_matrix")
        if not isinstance(rows, list) or not rows:
            raise ValueError("acceptance_matrix must be a non-empty list")

        blocked: list[tuple[str, str, str, list[str]]] = []
        present = 0
        total = 0
        for row_index, row in enumerate(rows):
            if not isinstance(row, dict):
                raise ValueError(f"acceptance_matrix[{row_index}] must be a mapping")
            lane = row.get("lane") or row.get("function") or row.get("supplier_pack_id")
            function = row.get("function")
            if not isinstance(lane, str) or not lane:
                raise ValueError(
                    f"acceptance_matrix[{row_index}] missing lane/function/supplier_pack_id"
                )
            if not isinstance(function, str):
                function = None
            evidence_rows = row.get("required_supplier_return_evidence")
            if not isinstance(evidence_rows, list) or not evidence_rows:
                raise ValueError(f"{lane}: required_supplier_return_evidence must be non-empty")
            for evidence in evidence_rows:
                if not isinstance(evidence, dict):
                    raise ValueError(f"{lane}: evidence row must be a mapping")
                total += 1
                evidence_class = str(evidence.get("evidence_class") or "<missing_class>")
                expected_path = str(evidence.get("expected_local_intake_path") or "")
                failures = evidence_failures(lane, evidence, function=function)
                if failures:
                    blocked.append((lane, evidence_class, expected_path, failures))
                else:
                    present += 1
    except ValueError as exc:
        write_report(
            {
                "schema": "eliza.e1_phone_supplier_return_content_report.v1",
                "status": "fail",
                **FALSE_CLAIM_FLAGS,
                "summary": {"release_ready": False},
                "findings": [
                    {
                        "code": "supplier_return_contract_invalid",
                        "severity": "error",
                        "message": str(exc),
                        "evidence": rel(MATRIX),
                    }
                ],
            }
        )
        print(f"FAIL: E1 phone supplier-return content contract invalid: {exc}")
        return 1

    if blocked:
        diagnostics = blocker_diagnostics(blocked)
        categories = diagnostics["supplier_return_blocker_categories"]
        primary_categories = diagnostics["primary_supplier_return_blocker_categories"]
        primary_lane_actions = [
            unblock_action(lane, evidence_class, expected_path, failures)
            for lane, evidence_class, expected_path, failures in sorted(
                {
                    lane: (lane, evidence_class, expected_path, failures)
                    for lane, evidence_class, expected_path, failures in blocked
                }.values(),
                key=lambda item: item[0],
            )
        ]
        write_report(
            {
                "schema": "eliza.e1_phone_supplier_return_content_report.v1",
                "status": "blocked",
                **FALSE_CLAIM_FLAGS,
                "summary": {
                    "release_ready": False,
                    "rows": total,
                    "validated": present,
                    "blocked": len(blocked),
                    "supplier_return_blocker_categories": categories,
                    "primary_supplier_return_blocker_categories": primary_categories,
                    "external_supplier_dependencies": diagnostics[
                        "external_supplier_dependency_summary"
                    ],
                },
                "findings": [
                    {
                        "code": "supplier_return_content_blocked",
                        "severity": "blocker",
                        "message": f"{lane}:{evidence_class}: {', '.join(failures)}",
                        "evidence": f"{lane}:{evidence_class}",
                    }
                    for lane, evidence_class, _expected_path, failures in blocked
                ],
                "blocked_evidence_inventory": [
                    unblock_action(lane, evidence_class, expected_path, failures)
                    for lane, evidence_class, expected_path, failures in blocked
                ],
                "blocker_dependency_counts": {
                    "repo_artifact_generation": categories[
                        "true_missing_supplier_return_artifacts"
                    ],
                    "live_device_validation": 0,
                    "actionable_external_dependency": max(
                        0,
                        len(blocked) - categories["true_missing_supplier_return_artifacts"],
                    ),
                },
                "next_command_by_dependency": {
                    "actionable_external_dependency": [VALIDATION_COMMAND],
                    **(
                        {"repo_artifact_generation": [VALIDATION_COMMAND]}
                        if categories["true_missing_supplier_return_artifacts"] > 0
                        else {}
                    ),
                },
                "validation_commands": [VALIDATION_COMMAND],
                "primary_blocker": {
                    "dependency": "actionable_external_dependency",
                    "blocked_rows": len(blocked),
                    "required_action": (
                        "Collect supplier-returned files and signed review metadata by "
                        "lane; no current local generator can provide supplier approval."
                    ),
                    "validation_command": VALIDATION_COMMAND,
                    "release_credit": False,
                },
                "primary_lane_actions": primary_lane_actions,
                "blocker_diagnostics": diagnostics,
                "next_unblock_actions": [
                    unblock_action(lane, evidence_class, expected_path, failures)
                    for lane, evidence_class, expected_path, failures in blocked[:20]
                ],
            }
        )
        print(
            "STATUS: BLOCKED E1 phone supplier-return content "
            f"rows={total} validated={present} blocked={len(blocked)}"
        )
        print(
            "  categories: "
            f"true_missing={categories['true_missing_supplier_return_artifacts']} "
            f"missing_approval_metadata={categories['missing_approval_metadata']} "
            f"candidate_present_but_blocked={categories['candidate_present_but_blocked']} "
            "present_unapproved_or_placeholder="
            f"{categories['present_unapproved_or_placeholder']} "
            f"template_only={categories['template_only_rows']} "
            "present_without_explicit_fail_closed_metadata="
            f"{categories['present_without_explicit_fail_closed_metadata']}"
        )
        for lane, evidence_class, _expected_path, failures in blocked[:10]:
            print(f"  - {lane}:{evidence_class}: {', '.join(failures)}")
        if len(blocked) > 10:
            print(f"  - ... {len(blocked) - 10} more blocked supplier rows")
        return 2

    write_report(
        {
            "schema": "eliza.e1_phone_supplier_return_content_report.v1",
            "status": "pass",
            **FALSE_CLAIM_FLAGS,
            "summary": {
                "release_ready": True,
                "rows": total,
                "validated": present,
                "blocked": 0,
            },
            "findings": [],
        }
    )
    print(f"STATUS: PASS E1 phone supplier-return content rows={total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
