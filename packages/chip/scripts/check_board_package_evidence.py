#!/usr/bin/env python3
import hashlib
import re
import sys
from argparse import ArgumentParser
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "docs/manufacturing/board-package-evidence.yaml"
ALLOWED_STATUS = {"missing", "draft", "complete"}
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
REQUIRED_RELEASE_BLOCKER_IDS = {
    "package_drawing",
    "footprint_source",
    "bond_diagram",
    "kicad_project",
    "kicad_schematic",
    "kicad_pcb",
    "vendor_derived_footprint",
    "erc",
    "drc",
    "gerbers",
    "drill",
    "bom",
    "pick_and_place",
    "cross_probe",
    "dfm",
    "si_pi",
    "first_article",
}
REQUIRED_SOURCE_CONTRACTS = {
    "package_pinout",
    "padframe_contract",
    "board_cross_probe",
    "board_fab_notes",
}
REQUIRED_SCALING_CHECKLIST_IDS = {
    "package_pin_budget",
    "external_lpddr_phy",
    "cpu_scaling_power",
    "npu_scaling_power",
    "board_power_thermal",
    "board_bringup",
}
REQUIRED_SCALING_SCOPE = {
    "package_pin_budget",
    "cpu_scaling_power",
    "npu_scaling_power",
    "external_lpddr_phy",
    "board_power_thermal",
    "board_bringup",
}
FORBIDDEN_SCALING_CLAIMS = {
    "package_ready",
    "board_fabrication_ready",
    "lpddr_routing_closed",
    "thermal_solution_validated",
    "npu_power_validated",
    "2028_product_ready",
}
REQUIRED_READINESS_MATRIX_IDS = {
    "lpddr",
    "power_rails",
    "thermal",
    "package_pins",
    "si_pi",
    "vendor_fab_evidence",
}
REQUIRED_CAPTURE_TEMPLATE_FIELDS = {
    "template",
    "status",
    "artifact_record_required_fields",
    "metadata_required_fields",
    "acceptance_required_fields",
    "forbidden_claims",
}
REQUIRED_EVIDENCE_RECORD_FIELDS = {
    "blocker_id",
    "artifact_name",
    "artifact_class",
    "source_path",
    "source_owner",
    "captured_at",
    "captured_by",
    "immutable_revision_or_lot",
    "sha256",
    "vendor_or_tool",
    "revision",
    "source_document",
    "package_or_board_revision",
    "reviewer",
    "acceptance_status",
    "acceptance_criteria",
    "review_record",
    "linked_release_gate",
    "supersedes_placeholder",
}
ACCEPTED_RELEASE_STATUSES = {"accepted", "approved", "pass"}
FORBIDDEN_RELEASE_PATH_PARTS = {"placeholder", "template", "scaffold", "skeleton"}
FORBIDDEN_RELEASE_TEXT_MARKERS = (
    "template_not_release_evidence",
    "non_release_placeholder",
    "release use: `prohibited`",
    "release_use: prohibited",
    "placeholder-only",
    "not a foundry-approved package",
    "not fabrication release evidence",
)


def as_string_list(value: object) -> list[str]:
    if isinstance(value, list) and all(isinstance(item, str) and item for item in value):
        return value
    return []


def repo_path(path: str) -> Path:
    return ROOT / path


def matching_files(globs: list[str]) -> list[Path]:
    files: list[Path] = []
    for pattern in globs:
        files.extend(path for path in ROOT.glob(pattern) if path.is_file())
    return sorted(set(files))


def path_matches_globs(path: str, globs: list[str]) -> bool:
    candidate = Path(path)
    return any(candidate.match(pattern) for pattern in globs)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_rel_path(field: str, value: str, failures: list[str]) -> None:
    path = Path(value)
    if path.is_absolute() or ".." in path.parts:
        failures.append(f"{field}: path must be repo-relative: {value}")


def validate_placeholder_blockers(manifest: dict, failures: list[str]) -> None:
    blockers = manifest.get("placeholder_blockers")
    if not isinstance(blockers, list) or not blockers:
        failures.append("placeholder_blockers: missing explicit placeholder blocker records")
        return
    for blocker in blockers:
        if not isinstance(blocker, dict):
            failures.append("placeholder_blockers: blocker must be a mapping")
            continue
        blocker_id = blocker.get("id", "<missing-id>")
        file_name = blocker.get("file")
        if not isinstance(file_name, str) or not file_name:
            failures.append(f"placeholder_blockers.{blocker_id}: missing file")
            continue
        validate_rel_path(f"placeholder_blockers.{blocker_id}.file", file_name, failures)
        path = repo_path(file_name)
        if not path.is_file():
            failures.append(f"placeholder_blockers.{blocker_id}: file is missing: {file_name}")
            continue
        text = path.read_text(errors="ignore")
        required_text = as_string_list(blocker.get("required_text"))
        if not required_text:
            failures.append(
                f"placeholder_blockers.{blocker_id}: required_text must be a non-empty string list"
            )
            continue
        missing_markers = [marker for marker in required_text if marker not in text]
        if missing_markers:
            failures.append(
                f"placeholder_blockers.{blocker_id}: missing placeholder marker(s): "
                + ", ".join(missing_markers)
            )


def load_yaml_contract(path: Path, label: str, failures: list[str]) -> dict:
    if not path.is_file():
        failures.append(f"{label}: file is missing: {path.relative_to(ROOT)}")
        return {}
    try:
        data = yaml.safe_load(path.read_text())
    except yaml.YAMLError as exc:
        failures.append(f"{label}: invalid YAML: {exc}")
        return {}
    if not isinstance(data, dict):
        failures.append(f"{label}: YAML must be a mapping")
        return {}
    return data


def validate_source_contracts(manifest: dict, failures: list[str]) -> None:
    contracts = manifest.get("source_contracts")
    if not isinstance(contracts, dict):
        failures.append("source_contracts: missing package/padframe/board contract links")
        return

    required = {
        "package_pinout",
        "padframe_contract",
        "board_cross_probe",
        "board_fab_notes",
    }
    for key in sorted(required):
        value = contracts.get(key)
        if not isinstance(value, str) or not value:
            failures.append(f"source_contracts.{key}: missing repo-relative path")
            continue
        validate_rel_path(f"source_contracts.{key}", value, failures)
        if not repo_path(value).is_file():
            failures.append(f"source_contracts.{key}: linked file is missing: {value}")

    package_pinout_path = contracts.get("package_pinout")
    padframe_path = contracts.get("padframe_contract")
    cross_probe_path = contracts.get("board_cross_probe")
    if not all(
        isinstance(path, str) for path in [package_pinout_path, padframe_path, cross_probe_path]
    ):
        return
    assert isinstance(package_pinout_path, str)
    assert isinstance(padframe_path, str)
    assert isinstance(cross_probe_path, str)

    pinout = load_yaml_contract(
        repo_path(package_pinout_path), "source_contracts.package_pinout", failures
    )
    padframe = load_yaml_contract(
        repo_path(padframe_path), "source_contracts.padframe_contract", failures
    )
    cross_probe = load_yaml_contract(
        repo_path(cross_probe_path), "source_contracts.board_cross_probe", failures
    )
    if not pinout or not padframe or not cross_probe:
        return

    padframe_pinout = padframe.get("package_pinout")
    padframe_artifacts = padframe.get("package_artifacts", {})
    cross_probe_scope = cross_probe.get("scope", {})
    if padframe_pinout != package_pinout_path:
        failures.append(
            "source_contracts.package_pinout: does not match padframe package_pinout "
            f"({padframe_pinout})"
        )
    if isinstance(padframe_artifacts, dict):
        if padframe_artifacts.get("pinout") != package_pinout_path:
            failures.append(
                "source_contracts.package_pinout: does not match padframe package_artifacts.pinout"
            )
        if padframe_artifacts.get("board_cross_probe") != cross_probe_path:
            failures.append(
                "source_contracts.board_cross_probe: does not match padframe package_artifacts.board_cross_probe"
            )
        board_fab_notes = contracts.get("board_fab_notes")
        if padframe_artifacts.get("board_fab_notes") != board_fab_notes:
            failures.append(
                "source_contracts.board_fab_notes: does not match padframe package_artifacts.board_fab_notes"
            )
    else:
        failures.append("source_contracts.padframe_contract: package_artifacts must be a mapping")

    if isinstance(cross_probe_scope, dict):
        if cross_probe_scope.get("package_pinout") != package_pinout_path:
            failures.append(
                "source_contracts.package_pinout: does not match cross-probe scope.package_pinout"
            )
        if cross_probe_scope.get("padframe_contract") != padframe_path:
            failures.append(
                "source_contracts.padframe_contract: does not match cross-probe scope.padframe_contract"
            )
        if cross_probe_scope.get("board_fab_notes") != contracts.get("board_fab_notes"):
            failures.append(
                "source_contracts.board_fab_notes: does not match cross-probe scope.board_fab_notes"
            )
    else:
        failures.append("source_contracts.board_cross_probe: scope must be a mapping")

    pins = pinout.get("pins")
    if not isinstance(pins, list) or not pins:
        failures.append("source_contracts.package_pinout: pins must be a non-empty list")
        return
    pin_count = len(pins)
    padframe_pin_count = padframe.get("package_pins")
    cross_probe_coverage = cross_probe.get("coverage", {})
    cross_probe_pin_count = (
        cross_probe_coverage.get("package_pins") if isinstance(cross_probe_coverage, dict) else None
    )
    if padframe_pin_count != pin_count:
        failures.append(
            f"source_contracts.package_pinout: pin count {pin_count} does not match "
            f"padframe package_pins {padframe_pin_count}"
        )
    if cross_probe_pin_count != pin_count:
        failures.append(
            f"source_contracts.package_pinout: pin count {pin_count} does not match "
            f"cross-probe coverage.package_pins {cross_probe_pin_count}"
        )

    missing_board_net = [
        str(pin.get("name", pin.get("pin", "<unnamed>")))
        for pin in pins
        if isinstance(pin, dict)
        and pin.get("direction") != "nc"
        and pin.get("board_net") in {None, ""}
    ]
    if missing_board_net:
        failures.append(
            "source_contracts.package_pinout: non-NC pins missing board_net: "
            + ", ".join(missing_board_net)
        )


def validate_capture_template(manifest: dict, failures: list[str]) -> None:
    value = manifest.get("capture_template")
    if not isinstance(value, str) or not value:
        failures.append("capture_template: missing repo-relative template path")
        return
    validate_rel_path("capture_template", value, failures)
    path = repo_path(value)
    if not path.is_file():
        failures.append(f"capture_template: file is missing: {value}")
        return
    try:
        template = yaml.safe_load(path.read_text())
    except yaml.YAMLError as exc:
        failures.append(f"{value}: invalid YAML: {exc}")
        return
    if not isinstance(template, dict):
        failures.append(f"{value}: template must be a mapping")
        return
    missing = sorted(REQUIRED_CAPTURE_TEMPLATE_FIELDS - set(template))
    if missing:
        failures.append(f"{value}: missing template fields: " + ", ".join(missing))
    if template.get("status") != "template_not_release_evidence":
        failures.append(f"{value}: status must be template_not_release_evidence")
    for list_field in (
        "artifact_record_required_fields",
        "metadata_required_fields",
        "acceptance_required_fields",
        "forbidden_claims",
    ):
        if not as_string_list(template.get(list_field)):
            failures.append(f"{value}: {list_field} must be a non-empty string list")


def validate_scaling_assessment(manifest: dict, failures: list[str]) -> None:
    value = manifest.get("scaling_assessment")
    if not isinstance(value, str) or not value:
        failures.append("scaling_assessment: missing repo-relative checklist path")
        return
    validate_rel_path("scaling_assessment", value, failures)
    path = repo_path(value)
    if not path.is_file():
        failures.append(f"scaling_assessment: file is missing: {value}")
        return
    try:
        assessment = yaml.safe_load(path.read_text())
    except yaml.YAMLError as exc:
        failures.append(f"{value}: invalid YAML: {exc}")
        return
    if not isinstance(assessment, dict):
        failures.append(f"{value}: assessment must be a mapping")
        return
    if assessment.get("schema") != "eliza.board_package_scaling_assessment.v1":
        failures.append(f"{value}: schema must be eliza.board_package_scaling_assessment.v1")
    if assessment.get("status") != "non_release_assessment":
        failures.append(f"{value}: status must be non_release_assessment")
    if assessment.get("release_use") != "prohibited":
        failures.append(f"{value}: release_use must be prohibited")
    if assessment.get("source_manifest") != str(MANIFEST.relative_to(ROOT)):
        failures.append(f"{value}: source_manifest must point at {MANIFEST.relative_to(ROOT)}")

    scope = set(as_string_list(assessment.get("scope")))
    missing_scope = sorted(REQUIRED_SCALING_SCOPE - scope)
    if missing_scope:
        failures.append(f"{value}: missing scope entries: " + ", ".join(missing_scope))
    forbidden_claims = set(as_string_list(assessment.get("forbidden_claims")))
    missing_forbidden = sorted(FORBIDDEN_SCALING_CLAIMS - forbidden_claims)
    if missing_forbidden:
        failures.append(f"{value}: missing forbidden_claims: " + ", ".join(missing_forbidden))
    assumptions = as_string_list(assessment.get("assumptions"))
    if len(assumptions) < 3:
        failures.append(
            f"{value}: assumptions must include package, LPDDR, and CPU/NPU power caveats"
        )

    matrix = assessment.get("readiness_matrix")
    if not isinstance(matrix, list) or not matrix:
        failures.append(f"{value}: readiness_matrix must be a non-empty list")
    else:
        seen_matrix_ids: set[str] = set()
        for row in matrix:
            if not isinstance(row, dict):
                failures.append(f"{value}: readiness_matrix entries must be mappings")
                continue
            row_id = row.get("id")
            if not isinstance(row_id, str) or not row_id:
                failures.append(f"{value}: readiness_matrix entry missing id")
                continue
            if row_id in seen_matrix_ids:
                failures.append(f"{value}: duplicate readiness_matrix id {row_id}")
            seen_matrix_ids.add(row_id)
            if row.get("status") != "blocked":
                failures.append(f"{value}.readiness_matrix.{row_id}: status must remain blocked")
            if row.get("blocks_release_gate") != "board_fabrication_release":
                failures.append(
                    f"{value}.readiness_matrix.{row_id}: blocks_release_gate must be board_fabrication_release"
                )
            for field in ("product_implication", "package_implication", "board_implication"):
                if not isinstance(row.get(field), str) or not row[field]:
                    failures.append(f"{value}.readiness_matrix.{row_id}: missing {field}")
            if len(as_string_list(row.get("required_evidence"))) < 3:
                failures.append(
                    f"{value}.readiness_matrix.{row_id}: required_evidence must list at least three evidence items"
                )
        missing_matrix_ids = sorted(REQUIRED_READINESS_MATRIX_IDS - seen_matrix_ids)
        if missing_matrix_ids:
            failures.append(
                f"{value}: missing readiness_matrix ids: " + ", ".join(missing_matrix_ids)
            )

    checklist = assessment.get("checklist")
    if not isinstance(checklist, list) or not checklist:
        failures.append(f"{value}: checklist must be a non-empty list")
        return
    seen_ids: set[str] = set()
    for item in checklist:
        if not isinstance(item, dict):
            failures.append(f"{value}: checklist entries must be mappings")
            continue
        item_id = item.get("id")
        if not isinstance(item_id, str) or not item_id:
            failures.append(f"{value}: checklist entry missing id")
            continue
        if item_id in seen_ids:
            failures.append(f"{value}: duplicate checklist id {item_id}")
        seen_ids.add(item_id)
        if item.get("status") != "blocked":
            failures.append(f"{value}.{item_id}: status must remain blocked")
        if item.get("blocks_release_gate") != "board_fabrication_release":
            failures.append(
                f"{value}.{item_id}: blocks_release_gate must be board_fabrication_release"
            )
        for field in ("owner", "implication"):
            if not isinstance(item.get(field), str) or not item[field]:
                failures.append(f"{value}.{item_id}: missing {field}")
        evidence = as_string_list(item.get("required_evidence"))
        if len(evidence) < 3:
            failures.append(
                f"{value}.{item_id}: required_evidence must list at least three evidence items"
            )
    missing_ids = sorted(REQUIRED_SCALING_CHECKLIST_IDS - seen_ids)
    if missing_ids:
        failures.append(f"{value}: missing checklist ids: " + ", ".join(missing_ids))


def validate_evidence_record_requirements(manifest: dict, failures: list[str]) -> None:
    requirements = manifest.get("evidence_record_requirements")
    if not isinstance(requirements, dict):
        failures.append("evidence_record_requirements: missing structured evidence record policy")
        return
    fields = set(as_string_list(requirements.get("required_fields")))
    missing_fields = sorted(REQUIRED_EVIDENCE_RECORD_FIELDS - fields)
    if missing_fields:
        failures.append(
            "evidence_record_requirements.required_fields: missing entries: "
            + ", ".join(missing_fields)
        )
    if requirements.get("linked_release_gate") != "board_fabrication_release":
        failures.append(
            "evidence_record_requirements.linked_release_gate must be board_fabrication_release"
        )
    accepted = set(as_string_list(requirements.get("accepted_release_statuses")))
    if not ACCEPTED_RELEASE_STATUSES.issubset(accepted):
        failures.append(
            "evidence_record_requirements.accepted_release_statuses must include: "
            + ", ".join(sorted(ACCEPTED_RELEASE_STATUSES))
        )
    if requirements.get("supersedes_placeholder_required") is not True:
        failures.append("evidence_record_requirements.supersedes_placeholder_required must be true")


def validate_evidence_records(
    field: str,
    artifact_name: str,
    blocker_id: str | None,
    globs: list[str],
    records: object,
    require_records: bool,
    manifest: dict,
    failures: list[str],
) -> None:
    if records is None:
        if require_records:
            failures.append(
                f"{field}: evidence_records are required before status complete/release"
            )
        return
    if not isinstance(records, list):
        failures.append(f"{field}: evidence_records must be a list")
        return
    if require_records and not records:
        failures.append(
            f"{field}: evidence_records must be non-empty before status complete/release"
        )
        return

    placeholder_files = {
        blocker.get("file")
        for blocker in manifest.get("placeholder_blockers", [])
        if isinstance(blocker, dict) and isinstance(blocker.get("file"), str)
    }
    capture_template = manifest.get("capture_template")
    for index, record in enumerate(records):
        record_field = f"{field}.evidence_records[{index}]"
        if not isinstance(record, dict):
            failures.append(f"{record_field}: must be a mapping")
            continue
        missing = sorted(REQUIRED_EVIDENCE_RECORD_FIELDS - set(record))
        if missing:
            failures.append(f"{record_field}: missing required fields: " + ", ".join(missing))
        if blocker_id and record.get("blocker_id") != blocker_id:
            failures.append(f"{record_field}.blocker_id: must match {blocker_id}")
        if record.get("artifact_name") != artifact_name:
            failures.append(f"{record_field}.artifact_name: must match {artifact_name}")
        if record.get("linked_release_gate") != "board_fabrication_release":
            failures.append(
                f"{record_field}.linked_release_gate: must be board_fabrication_release"
            )
        if record.get("supersedes_placeholder") is not True:
            failures.append(f"{record_field}.supersedes_placeholder: must be true")
        if record.get("acceptance_status") not in ACCEPTED_RELEASE_STATUSES:
            failures.append(
                f"{record_field}.acceptance_status: must be one of "
                + ", ".join(sorted(ACCEPTED_RELEASE_STATUSES))
            )

        source_path = record.get("source_path")
        if not isinstance(source_path, str) or not source_path:
            failures.append(f"{record_field}.source_path: missing repo-relative file path")
            continue
        validate_rel_path(f"{record_field}.source_path", source_path, failures)
        lower_parts = {part.lower() for part in Path(source_path).parts}
        forbidden_parts = sorted(FORBIDDEN_RELEASE_PATH_PARTS & lower_parts)
        if forbidden_parts:
            failures.append(
                f"{record_field}.source_path: release evidence path contains forbidden part(s): "
                + ", ".join(forbidden_parts)
            )
        if not path_matches_globs(source_path, globs):
            failures.append(f"{record_field}.source_path: must match one of {artifact_name} globs")
        if source_path == capture_template or source_path in placeholder_files:
            failures.append(
                f"{record_field}.source_path: template/placeholder files are not release evidence"
            )
            continue
        path = repo_path(source_path)
        if not path.is_file():
            failures.append(f"{record_field}.source_path: file is missing: {source_path}")
            continue
        text = path.read_text(errors="ignore").lower()
        matched_markers = [marker for marker in FORBIDDEN_RELEASE_TEXT_MARKERS if marker in text]
        if matched_markers:
            failures.append(
                f"{record_field}.source_path: contains non-release marker(s): "
                + ", ".join(matched_markers)
            )
        sha256 = record.get("sha256")
        if not isinstance(sha256, str) or not SHA256_RE.fullmatch(sha256):
            failures.append(f"{record_field}.sha256: must be lowercase sha256")
        elif file_sha256(path) != sha256:
            failures.append(f"{record_field}.sha256: does not match file content")


def validate_artifact(
    group_name: str,
    artifact: object,
    release: bool,
    manifest: dict,
    failures: list[str],
    release_blockers: list[str],
    blocker_ids: set[str],
) -> None:
    if not isinstance(artifact, dict):
        failures.append(f"{group_name}: artifact must be a mapping")
        return
    name = artifact.get("name")
    if not isinstance(name, str) or not name:
        failures.append(f"{group_name}: artifact missing name")
        name = "unnamed"
    field = f"{group_name}.{name}"
    status = artifact.get("status")
    if status not in ALLOWED_STATUS:
        failures.append(f"{field}: status must be missing, draft, or complete")
    globs = as_string_list(artifact.get("globs"))
    if not globs:
        failures.append(f"{field}: globs must be a non-empty string list")
    for pattern in globs:
        validate_rel_path(f"{field}.globs", pattern, failures)

    metadata = artifact.get("metadata", {})
    if metadata and not isinstance(metadata, dict):
        failures.append(f"{field}: metadata must be a mapping")
        metadata = {}
    required_metadata = as_string_list(artifact.get("required_metadata", []))
    if artifact.get("required_metadata", []) and not required_metadata:
        failures.append(f"{field}: required_metadata must be a string list")
    if isinstance(metadata, dict):
        for key, value in metadata.items():
            if key.endswith("_sha256") and (
                not isinstance(value, str) or not SHA256_RE.fullmatch(value)
            ):
                failures.append(f"{field}.metadata.{key}: must be lowercase sha256")
    if (release or status == "complete") and required_metadata:
        present = set(metadata) if isinstance(metadata, dict) else set()
        missing = sorted(set(required_metadata) - present)
        if missing:
            failures.append(f"{field}: missing required metadata: " + ", ".join(missing))

    files = matching_files(globs)
    blocker = artifact.get("release_blocker")
    blocker_id = artifact.get("release_blocker_id")
    if blocker is not None and (not isinstance(blocker, str) or not blocker):
        failures.append(f"{field}: release_blocker must be a non-empty string")
    if blocker_id is not None:
        if not isinstance(blocker_id, str) or not blocker_id:
            failures.append(f"{field}: release_blocker_id must be a non-empty string")
        else:
            if blocker_id in blocker_ids:
                failures.append(f"{field}: duplicate release_blocker_id {blocker_id}")
            blocker_ids.add(blocker_id)
    elif release or status != "complete":
        failures.append(f"{field}: release_blocker_id is required for fail-closed evidence")
    if not isinstance(blocker, str) or not blocker:
        failures.append(f"{field}: release_blocker is required for capturable blocker output")
    if status == "missing" and files:
        failures.append(f"{field}: status missing but files exist")
    if status == "complete" and not files:
        failures.append(f"{field}: status complete but files are missing")
    validate_evidence_records(
        field,
        name,
        blocker_id if isinstance(blocker_id, str) else None,
        globs,
        artifact.get("evidence_records"),
        status == "complete",
        manifest,
        failures,
    )
    if release:
        if isinstance(blocker, str) and blocker and (status != "complete" or not files):
            if isinstance(blocker_id, str) and blocker_id:
                release_blockers.append(f"{blocker_id}: {blocker}")
            else:
                release_blockers.append(blocker)
        if status != "complete":
            failures.append(f"{field}: release requires status complete, got {status}")
        if not files:
            failures.append(f"{field}: release artifact files are missing")


def validate_manifest(release: bool, release_blockers: list[str]) -> list[str]:
    failures: list[str] = []
    blocker_ids: set[str] = set()
    if not MANIFEST.is_file():
        return [f"missing manifest: {MANIFEST.relative_to(ROOT)}"]
    try:
        manifest = yaml.safe_load(MANIFEST.read_text())
    except yaml.YAMLError as exc:
        return [f"{MANIFEST.relative_to(ROOT)}: invalid YAML: {exc}"]
    if not isinstance(manifest, dict):
        return [f"{MANIFEST.relative_to(ROOT)}: manifest must be a mapping"]

    if manifest.get("status") != "release_blocked":
        failures.append(
            "manifest status must remain release_blocked until real artifacts are complete"
        )
    if manifest.get("release_gate") != "board_fabrication_release":
        failures.append("release_gate must be board_fabrication_release")
    if manifest.get("schema") != "eliza.board_package_evidence.v1":
        failures.append("schema must be eliza.board_package_evidence.v1")
    policy = manifest.get("policy")
    if (
        not isinstance(policy, dict)
        or not isinstance(policy.get("preflight"), str)
        or not isinstance(policy.get("release"), str)
    ):
        failures.append("policy must define preflight and release text")

    validate_source_contracts(manifest, failures)
    validate_capture_template(manifest, failures)
    validate_scaling_assessment(manifest, failures)
    validate_evidence_record_requirements(manifest, failures)
    validate_placeholder_blockers(manifest, failures)

    groups = manifest.get("artifact_groups")
    if not isinstance(groups, dict) or not groups:
        failures.append("artifact_groups: missing evidence groups")
        return failures
    for group_name, group in groups.items():
        if not isinstance(group, dict):
            failures.append(f"artifact_groups.{group_name}: group must be a mapping")
            continue
        group_status = group.get("status")
        if group_status not in ALLOWED_STATUS:
            failures.append(
                f"artifact_groups.{group_name}: status must be missing, draft, or complete"
            )
        if release and group_status != "complete":
            failures.append(
                f"artifact_groups.{group_name}: release requires status complete, got {group_status}"
            )
        artifacts = group.get("artifacts")
        if not isinstance(artifacts, list) or not artifacts:
            failures.append(f"artifact_groups.{group_name}: missing artifacts")
            continue
        for artifact in artifacts:
            validate_artifact(
                f"artifact_groups.{group_name}",
                artifact,
                release,
                manifest,
                failures,
                release_blockers,
                blocker_ids,
            )

    missing_blocker_ids = sorted(REQUIRED_RELEASE_BLOCKER_IDS - blocker_ids)
    if missing_blocker_ids:
        failures.append("missing required release blocker ids: " + ", ".join(missing_blocker_ids))

    return failures


def unique_items(items: list[str]) -> list[str]:
    seen: set[str] = set()
    unique: list[str] = []
    for item in items:
        if item not in seen:
            seen.add(item)
            unique.append(item)
    return unique


def main() -> int:
    parser = ArgumentParser(description="Validate board/package/vendor/fab evidence manifest.")
    parser.add_argument("--release", action="store_true", help="require release-complete evidence")
    args = parser.parse_args()

    release_blockers: list[str] = []
    failures = validate_manifest(args.release, release_blockers)
    if failures:
        mode = "release" if args.release else "preflight"
        print(f"board/package evidence {mode} check failed:")
        if args.release and release_blockers:
            print("Release blockers:")
            for blocker in unique_items(release_blockers):
                print(f"  - {blocker}")
            print("Validation detail:")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    mode = "release" if args.release else "preflight"
    print(f"board/package evidence {mode} check ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
