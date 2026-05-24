#!/usr/bin/env python3
"""Dry-run validation for E1 phone release evidence content requirements."""

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
REPO_ROOT = ROOT.parents[1]
BOARD_ROOT = ROOT / "board/kicad/e1-phone"
REPORT_DATE = "2026-05-22"

DEFAULT_CONTRACT = (
    BOARD_ROOT / "production/readiness/release-evidence-content-contract-2026-05-22.yaml"
)
DEFAULT_REPORT = (
    BOARD_ROOT / "production/readiness/release-evidence-validation-dry-run-2026-05-22.yaml"
)

REQUIRED_CONTENT_FIELDS = {
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
    "tbd",
    "todo",
    "template_empty_not_executed",
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


class NoAliasDumper(yaml.SafeDumper):
    def ignore_aliases(self, data: Any) -> bool:
        return True


def load_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"{path}: expected YAML mapping")
    return data


def rel(path: Path) -> str:
    if path.is_relative_to(ROOT):
        return path.relative_to(ROOT).as_posix()
    if path.is_relative_to(REPO_ROOT):
        return path.relative_to(REPO_ROOT).as_posix()
    return path.as_posix()


def resolve_path(path_text: str | None) -> Path | None:
    if not path_text:
        return None
    path = Path(path_text)
    if path.is_absolute():
        return path
    if path_text.startswith("packages/chip/"):
        return REPO_ROOT / path
    return ROOT / path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def scalar_strings(node: Any) -> list[str]:
    if isinstance(node, dict):
        values: list[str] = []
        for key, value in node.items():
            values.append(str(key))
            values.extend(scalar_strings(value))
        return values
    if isinstance(node, list):
        values = []
        for item in node:
            values.extend(scalar_strings(item))
        return values
    if node is None:
        return ["null"]
    return [str(node)]


def parse_structured_file(path: Path) -> tuple[str, Any | None, str | None]:
    suffix = path.suffix.lower()
    try:
        if suffix in {".yaml", ".yml"}:
            return "yaml", yaml.safe_load(path.read_text(encoding="utf-8")), None
        if suffix == ".json":
            return "json", json.loads(path.read_text(encoding="utf-8")), None
        if suffix == ".csv":
            with path.open(newline="", encoding="utf-8") as handle:
                reader = csv.DictReader(handle)
                rows = list(reader)
            return "csv", {"fieldnames": reader.fieldnames or [], "rows": rows}, None
        if suffix == ".kicad_sch":
            text = path.read_text(encoding="utf-8")
            if (
                "eliza.e1_phone_supplier_return_intake_placeholder.v1" in text
                or "blocked_pending_supplier_return" in text
            ):
                parsed = yaml.safe_load(text)
                if isinstance(parsed, dict):
                    return "kicad_sch_placeholder_metadata", parsed, None
            return "kicad_sch", None, None
    except Exception as exc:  # pragma: no cover - exercised by real artifacts when malformed
        return suffix.lstrip(".") or "file", None, str(exc)
    return suffix.lstrip(".") or "file", None, None


def directory_manifest(path: Path) -> Path | None:
    for candidate in (
        path / "release-manifest.yaml",
        path / "manifest.yaml",
        path / "index.yaml",
    ):
        if candidate.is_file():
            return candidate
    return None


def required_fields_by_category(contract: dict[str, Any]) -> dict[str, set[str]]:
    fields: dict[str, set[str]] = {}
    for content_contract in contract.get("content_contracts", []):
        if not isinstance(content_contract, dict):
            continue
        category = content_contract.get("id")
        required = content_contract.get("required_content_fields")
        if not isinstance(category, str):
            continue
        if not isinstance(required, list) or not all(
            isinstance(field, str) for field in required
        ):
            raise ValueError(f"content contract {category} missing required_content_fields")
        fields[category] = set(required)
    return fields


def content_findings(
    row: dict[str, Any],
    resolved: Path | None,
    category_required_fields: dict[str, set[str]] | None = None,
) -> dict[str, Any]:
    local_failures: list[str] = []
    release_failures: list[str] = []
    warnings: list[str] = []
    parsed_kind = "missing"
    parsed: Any | None = None
    parse_error: str | None = None
    content_hash: str | None = None
    file_size: int | None = None
    required_fields = set(REQUIRED_CONTENT_FIELDS)
    if category_required_fields:
        category = str(row["category"])
        if category not in category_required_fields:
            raise ValueError(f"no content contract required fields for category {category}")
        required_fields = set(category_required_fields[category])
    missing_fields: list[str] = []

    if row["release_allowed"] is not True:
        release_failures.append("contract_row_release_not_allowed")
    if row["template_only"]:
        local_failures.append("template_only_artifact_cannot_validate")
        release_failures.append("template_only_artifact_cannot_validate")
    if row["presence_only"]:
        release_failures.append("contract_row_is_presence_only")
    if row["validated"] is not True:
        release_failures.append("contract_row_not_validated")
    if row["approval_status"] != "approved":
        release_failures.append("approval_status_not_approved")

    if resolved is None:
        local_failures.append("missing_path")
    elif not resolved.exists():
        local_failures.append("artifact_missing")
    else:
        try:
            resolved_real = resolved.resolve()
            resolved_real.relative_to(REPO_ROOT)
        except ValueError:
            local_failures.append("path_resolves_outside_repository")
        if resolved.is_symlink():
            warnings.append("symlink_requires_manual_review")

    if resolved is not None and resolved.exists() and resolved.is_dir():
        parsed_kind = "directory"
        if not any(resolved.iterdir()):
            local_failures.append("directory_empty")
        manifest_path = directory_manifest(resolved)
        if manifest_path is None:
            local_failures.append("directory_release_manifest_missing")
        else:
            parsed_kind, parsed, parse_error = parse_structured_file(manifest_path)
            parsed_kind = "directory_manifest_" + parsed_kind
            if parse_error:
                local_failures.append("directory_release_manifest_parse_error")
            elif isinstance(parsed, dict):
                missing_fields = sorted(required_fields - set(parsed))
                if missing_fields:
                    local_failures.append("required_content_fields_missing")
                    warnings.append("missing_fields:" + ",".join(missing_fields))
                if parsed.get("release_allowed") is False:
                    local_failures.append("directory_manifest_release_not_allowed")
                if parsed.get("release_children_complete") is False:
                    local_failures.append("directory_manifest_release_children_incomplete")
                if parsed.get("disposition") != "approved":
                    local_failures.append("directory_manifest_disposition_not_approved")
                text = "\n".join(scalar_strings(parsed)).lower()
                markers = sorted(marker for marker in PLACEHOLDER_MARKERS if marker in text)
                if markers:
                    local_failures.append("placeholder_or_blocked_content_marker_present")
                    warnings.append("markers:" + ",".join(markers))
            else:
                local_failures.append("directory_release_manifest_not_mapping")
        release_failures.append("directory_presence_is_not_content_validation")
    elif resolved is not None and resolved.exists() and resolved.is_file():
        file_size = resolved.stat().st_size
        content_hash = sha256(resolved)
        if row.get("sha256") and row["sha256"] != content_hash:
            local_failures.append("contract_sha256_mismatch")
        if file_size == 0:
            local_failures.append("file_empty")
        parsed_kind, parsed, parse_error = parse_structured_file(resolved)
        if parse_error:
            local_failures.append("parse_error")
        suffix = resolved.suffix.lower()
        if suffix in {".pdf", ".step", ".stp", ".brep"}:
            release_failures.append("binary_or_cad_file_requires_external_signed_review")
        elif suffix in {".yaml", ".yml", ".json", ".csv", ".kicad_sch"}:
            if parsed is None:
                local_failures.append("structured_content_missing")
            elif isinstance(parsed, dict):
                present_fields = set(parsed)
                if parsed_kind == "csv" and isinstance(parsed.get("fieldnames"), list):
                    present_fields = {str(field) for field in parsed["fieldnames"]}
                missing_fields = sorted(required_fields - present_fields)
                if missing_fields:
                    local_failures.append("required_content_fields_missing")
                    warnings.append("missing_fields:" + ",".join(missing_fields))
                text = "\n".join(scalar_strings(parsed)).lower()
                markers = sorted(marker for marker in PLACEHOLDER_MARKERS if marker in text)
                if markers:
                    local_failures.append("placeholder_or_blocked_content_marker_present")
                    warnings.append("markers:" + ",".join(markers))
            else:
                local_failures.append("structured_content_not_mapping")
        else:
            release_failures.append("unsupported_artifact_type_requires_manual_contract_extension")

    failures = local_failures + [
        failure for failure in release_failures if failure not in local_failures
    ]
    local_validation_state = (
        "locally_validated" if not local_failures else "local_blocked_fail_closed"
    )
    release_validation_state = (
        "blocked_fail_closed" if failures else "validated"
    )

    return {
        "evidence_id": row["evidence_id"],
        "category": row["category"],
        "path": row["path"],
        "resolved_path": rel(resolved) if resolved else None,
        "source_matrix": row["source_matrix"],
        "present": bool(resolved and resolved.exists()),
        "artifact_kind": "directory"
        if resolved and resolved.is_dir()
        else "file"
        if resolved and resolved.is_file()
        else "missing",
        "parsed_kind": parsed_kind,
        "file_size_bytes": file_size,
        "sha256": content_hash,
        "required_content_fields": sorted(required_fields),
        "required_content_fields_present": not missing_fields,
        "missing_required_content_fields": missing_fields,
        "local_evidence_validation_state": local_validation_state,
        "local_validation_failures": local_failures,
        "external_release_validation_state": release_validation_state,
        "external_release_failures": release_failures,
        "validation_state": release_validation_state,
        "release_allowed": False,
        "failures": failures,
        "warnings": warnings,
    }


def build_report(contract_path: Path, report_path: Path) -> dict[str, Any]:
    contract = load_yaml(contract_path)
    rows = contract["artifact_content_requirements"]
    category_required_fields = required_fields_by_category(contract)
    if not category_required_fields:
        raise ValueError("content_contracts required_content_fields mapping is empty")
    validation_rows = [
        content_findings(row, resolve_path(row.get("path")), category_required_fields)
        for row in rows
    ]
    missing = [
        row
        for row in validation_rows
        if "artifact_missing" in row["failures"] or "missing_path" in row["failures"]
    ]
    present_blocked = [
        row
        for row in validation_rows
        if row["present"] and row["validation_state"] == "blocked_fail_closed"
    ]
    validated = [row for row in validation_rows if row["validation_state"] == "validated"]
    locally_validated = [
        row
        for row in validation_rows
        if row["local_evidence_validation_state"] == "locally_validated"
    ]
    category_counts = Counter(str(row["category"]) for row in validation_rows)
    missing_by_category = Counter(
        str(row["category"])
        for row in validation_rows
        if "artifact_missing" in row["failures"] or "missing_path" in row["failures"]
    )
    present_blocked_by_category = Counter(str(row["category"]) for row in present_blocked)
    failure_counts = Counter(
        failure for row in validation_rows for failure in row["failures"]
    )

    return {
        "schema": "eliza.e1_phone_release_evidence_validation_dry_run.v1",
        "status": "blocked_fail_closed_release_evidence_not_validated",
        "date": REPORT_DATE,
        "claim_boundary": (
            "Dry-run validator for release evidence content requirements. It checks "
            "current file presence, parseability, hashes, template state, placeholder "
            "markers, and required metadata fields, but it does not approve fabrication, "
            "enclosure, first-article, factory, or end-to-end readiness."
        ),
        "inputs": {
            "release_evidence_content_contract": rel(contract_path),
            "contract_schema": contract.get("schema"),
            "contract_status": contract.get("status"),
            "report_path": rel(report_path),
        },
        "summary": {
            "artifact_content_requirement_count": len(rows),
            "validation_row_count": len(validation_rows),
            "locally_validated_row_count": len(locally_validated),
            "locally_blocked_row_count": len(validation_rows) - len(locally_validated),
            "validated_row_count": len(validated),
            "blocked_row_count": len(validation_rows) - len(validated),
            "missing_or_unmapped_row_count": len(missing),
            "present_but_blocked_row_count": len(present_blocked),
            "external_release_validated_row_count": len(validated),
            "external_release_blocked_row_count": len(validation_rows) - len(validated),
            "category_counts": dict(sorted(category_counts.items())),
            "missing_or_unmapped_by_category": dict(sorted(missing_by_category.items())),
            "present_but_blocked_by_category": dict(sorted(present_blocked_by_category.items())),
            "failure_counts": dict(sorted(failure_counts.items())),
            "release_state": "blocked_fail_closed",
        },
        "validation_policy": {
            "local_evidence_validation_does_not_unlock_release": True,
            "missing_artifact_blocks_release": True,
            "template_only_blocks_release": True,
            "presence_only_blocks_release": True,
            "placeholder_or_blocked_marker_blocks_release": True,
            "unsigned_or_unapproved_blocks_release": True,
            "binary_or_cad_requires_external_signed_review": True,
            "fabrication_release_allowed": False,
            "enclosure_release_allowed": False,
            "factory_first_article_allowed": False,
            "end_to_end_release_allowed": False,
        },
        "validation_rows": validation_rows,
        "missing_or_unmapped_rows": missing,
        "present_but_blocked_rows": present_blocked,
        "forbidden_claims": [
            "fabrication_ready",
            "enclosure_ready",
            "factory_ready",
            "first_article_passed",
            "end_to_end_phone_ready",
        ],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--contract", type=Path, default=DEFAULT_CONTRACT)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--write-report", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = build_report(args.contract, args.report)
    output = yaml.dump(report, Dumper=NoAliasDumper, sort_keys=False, width=100)
    if args.write_report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(output, encoding="utf-8")
    else:
        print(output, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
