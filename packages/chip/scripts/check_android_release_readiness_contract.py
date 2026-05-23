#!/usr/bin/env python3
"""Static Android release readiness contract gate.

This blocks Android release promotion when manifests still describe draft
artifacts, omit a chip/riscv64 target, or when installer/post-flash validation
only proves boot properties instead of launcher and agent liveness.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = ROOT.parent
ANDROID_MANIFEST = WORKSPACE / "os/release/beta-2026-05-16/android-release-manifest.json"
UMBRELLA_MANIFEST = WORKSPACE / "os/release/beta-2026-05-16/manifest.json"
RELEASE_DIR = WORKSPACE / "os/release/beta-2026-05-16"
POST_FLASH = WORKSPACE / "os/android/installer/scripts/validate-post-flash.sh"
INSTALLER = WORKSPACE / "os/android/installer/install-elizaos-android.sh"
REPORT = ROOT / "build/reports/android_release_readiness_contract.json"
SCHEMA = "eliza.android_release_readiness_contract.v1"
CLAIM_BOUNDARY = "static_android_release_contract_only_not_runtime_flash_or_launcher_evidence"
ZERO_SHA256 = "0" * 64
LAUNCHER_AGENT_MARKERS = {
    "package_install": ("pm path",),
    "role_holder": ("cmd role holders", "role holders"),
    "home_resolve": ("resolve-activity", "HOME"),
    "package_state": ("dumpsys package",),
    "foreground_activity": ("dumpsys activity",),
    "agent_health": ("/api/health",),
    "fatal_log_scan": ("logcat",),
    "selinux_denial_scan": ("avc: denied", "denied"),
}


@dataclass(frozen=True)
class Finding:
    code: str
    severity: str
    message: str
    evidence: str
    next_step: str


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def read_json(path: Path) -> Any:
    return json.loads(read_text(path))


def rel(path: Path) -> str:
    try:
        return path.relative_to(WORKSPACE).as_posix()
    except ValueError:
        return str(path)


def add_if(
    findings: list[Finding],
    condition: bool,
    code: str,
    message: str,
    evidence: str,
    next_step: str,
) -> None:
    if condition:
        findings.append(Finding(code, "blocker", message, evidence, next_step))


def android_artifacts(umbrella: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        artifact
        for artifact in umbrella.get("artifacts", [])
        if artifact.get("kind") == "android-image"
    ]


def target_values(artifact: dict[str, Any]) -> set[str]:
    target = artifact.get("target", {})
    if not isinstance(target, dict):
        return set()
    return {
        str(value).lower() for value in target.values() if value is not None and str(value).strip()
    }


def has_chip_riscv64_release_target(
    android_manifest: dict[str, Any], umbrella: dict[str, Any]
) -> bool:
    devices = android_manifest.get("supportedDevices", [])
    manifest_target_values = {
        str(value).lower()
        for device in devices
        if isinstance(device, dict)
        for value in device.values()
        if isinstance(value, str)
    }
    umbrella_targets = [target_values(artifact) for artifact in android_artifacts(umbrella)]
    return any("riscv64" in values for values in umbrella_targets) and any(
        "chip" in value or "eliza_ai_soc" in value or "eliza-chip" in value
        for value in manifest_target_values
    )


def validation_properties(manifest: dict[str, Any]) -> dict[str, str]:
    validation = manifest.get("validation", {})
    if not isinstance(validation, dict):
        return {}
    properties = validation.get("properties", {})
    if not isinstance(properties, dict):
        return {}
    return {str(key): str(value) for key, value in properties.items()}


def evidence_rows(artifact: dict[str, Any]) -> list[dict[str, Any]]:
    validation = artifact.get("validation", {})
    if not isinstance(validation, dict):
        return []
    rows = validation.get("evidence", [])
    return [row for row in rows if isinstance(row, dict)]


def evidence_row_label(artifact: dict[str, Any], row: dict[str, Any]) -> str:
    artifact_id = artifact.get("id", artifact.get("filename", "<unknown>"))
    row_id = row.get("id", "<missing-id>")
    status = row.get("status", "<missing-status>")
    path = row.get("path", "<missing-path>")
    return f"{artifact_id}:{row_id}:{status}:{path}"


def unresolved_evidence_rows(artifact: dict[str, Any]) -> list[str]:
    return [
        evidence_row_label(artifact, row)
        for row in evidence_rows(artifact)
        if row.get("status") != "collected"
    ]


def missing_evidence_files(artifact: dict[str, Any]) -> list[str]:
    missing = []
    for row in evidence_rows(artifact):
        path = row.get("path")
        if not isinstance(path, str) or not path:
            continue
        if not (RELEASE_DIR / path).is_file():
            missing.append(evidence_row_label(artifact, row))
    return missing


def unresolved_evidence_file_payloads(artifact: dict[str, Any]) -> list[str]:
    unresolved = []
    allowed_statuses = {"collected", "pass", "passed"}
    for row in evidence_rows(artifact):
        path = row.get("path")
        if not isinstance(path, str) or not path:
            continue
        evidence_path = RELEASE_DIR / path
        if not evidence_path.is_file():
            continue
        try:
            payload = json.loads(evidence_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            unresolved.append(f"{evidence_row_label(artifact, row)}: unreadable_json={error}")
            continue
        status = str(payload.get("status", "")).lower()
        if status not in allowed_statuses:
            unresolved.append(f"{evidence_row_label(artifact, row)}: payload_status={status or '<missing>'}")
    return unresolved


def artifact_identity(artifact: dict[str, Any]) -> str:
    artifact_id = artifact.get("id", artifact.get("partition", "<unknown>"))
    filename = artifact.get("filename", "<missing-filename>")
    return f"{artifact_id}:{filename}"


def missing_manifest_validation_markers(manifest: dict[str, Any]) -> list[str]:
    properties = validation_properties(manifest)
    keys = {key.lower() for key in properties}
    values = {value.lower() for value in properties.values()}
    text = json.dumps(manifest.get("validation", {}), sort_keys=True).lower()
    required = {
        "launcher_package": ("pm_path", "pm path", "package"),
        "launcher_role": ("role", "home"),
        "foreground_activity": ("foreground", "activity"),
        "agent_service": ("service", "pid"),
        "agent_health": ("/api/health", "health"),
        "fatal_log_scan": ("logcat", "fatal", "crash"),
        "selinux_denial_scan": ("avc", "selinux", "denied"),
    }
    missing = []
    for name, markers in required.items():
        if not any(marker in text or marker in keys or marker in values for marker in markers):
            missing.append(name)
    return missing


def missing_script_markers(text: str) -> list[str]:
    lower = text.lower()
    if "validate-post-flash.sh" in lower:
        return []
    missing: list[str] = []
    for name, markers in LAUNCHER_AGENT_MARKERS.items():
        if not any(marker.lower() in lower for marker in markers):
            missing.append(name)
    return missing


def run_check(args: argparse.Namespace) -> dict[str, object]:
    inputs = (ANDROID_MANIFEST, UMBRELLA_MANIFEST, POST_FLASH, INSTALLER)
    findings: list[Finding] = []
    for path in inputs:
        add_if(
            findings,
            not path.is_file(),
            "missing_input",
            "required Android release readiness input is missing",
            rel(path),
            "Restore the release manifest and installer validation inputs before claiming Android release readiness.",
        )
    if findings:
        return payload(findings, {})

    android_manifest = read_json(ANDROID_MANIFEST)
    umbrella_manifest = read_json(UMBRELLA_MANIFEST)
    post_flash_text = read_text(POST_FLASH)
    installer_text = read_text(INSTALLER)
    artifacts = android_manifest.get("artifacts", [])
    android_release_artifacts = android_artifacts(umbrella_manifest)
    placeholder_hashes = [
        artifact_identity(artifact)
        for artifact in artifacts
        if artifact.get("sha256") in {None, "", ZERO_SHA256}
    ]
    sentinel_sizes = [
        artifact_identity(artifact)
        for artifact in artifacts
        if artifact.get("sizeBytes") in {None, 0, 1}
    ]
    umbrella_missing_hashes = [
        artifact_identity(artifact)
        for artifact in android_release_artifacts
        if not artifact.get("sha256")
    ]
    umbrella_missing_sizes = [
        artifact_identity(artifact)
        for artifact in android_release_artifacts
        if not artifact.get("sizeBytes")
    ]
    umbrella_empty_evidence = [
        artifact_identity(artifact)
        for artifact in android_release_artifacts
        if not evidence_rows(artifact)
    ]
    umbrella_uncollected_evidence = [
        row_label
        for artifact in android_release_artifacts
        for row_label in unresolved_evidence_rows(artifact)
    ]
    umbrella_missing_evidence_files = [
        row_label
        for artifact in android_release_artifacts
        for row_label in missing_evidence_files(artifact)
    ]
    umbrella_unresolved_evidence_payloads = [
        row_label
        for artifact in android_release_artifacts
        for row_label in unresolved_evidence_file_payloads(artifact)
    ]
    umbrella_targets = [target_values(artifact) for artifact in android_release_artifacts]
    manifest_missing_validation = missing_manifest_validation_markers(android_manifest)
    post_flash_missing = missing_script_markers(post_flash_text)
    installer_missing = missing_script_markers(installer_text)

    add_if(
        findings,
        bool(placeholder_hashes),
        "android_release_manifest_uses_placeholder_hashes",
        "Android partition release manifest still uses placeholder hashes",
        f"artifacts={placeholder_hashes}",
        "Publish only manifests with real SHA-256 values verified against the artifact directory.",
    )
    add_if(
        findings,
        bool(sentinel_sizes),
        "android_release_manifest_uses_sentinel_sizes",
        "Android partition release manifest still uses missing or sentinel artifact sizes",
        f"artifacts={sentinel_sizes}",
        "Populate real artifact sizes and verify them with validate-release-manifest.mjs --artifact-dir.",
    )
    add_if(
        findings,
        not has_chip_riscv64_release_target(android_manifest, umbrella_manifest),
        "android_release_manifest_missing_chip_riscv64_target",
        "Android release manifests do not declare a chip/riscv64 target",
        f"supportedDevices={android_manifest.get('supportedDevices', [])} android_targets={sorted(map(sorted, umbrella_targets))}",
        "Add the fused eliza chip emulator/product target and riscv64 architecture to the Android release manifest set.",
    )
    add_if(
        findings,
        bool(manifest_missing_validation),
        "android_release_validation_missing_launcher_agent_checks",
        "Android release manifest validation only covers boot properties, not launcher and agent liveness",
        f"missing={manifest_missing_validation} properties={validation_properties(android_manifest)}",
        "Require installed launcher package, HOME role, foreground activity, agent service PID, /api/health, logcat, and SELinux checks.",
    )
    add_if(
        findings,
        bool(post_flash_missing),
        "post_flash_validator_missing_launcher_agent_checks",
        "post-flash validator does not prove launcher foreground state and agent health",
        f"missing={post_flash_missing} script={rel(POST_FLASH)}",
        "Extend validate-post-flash.sh to check pm path, role holders, HOME resolution, foreground activity, service PID, health, and logs.",
    )
    add_if(
        findings,
        bool(installer_missing),
        "installer_reboot_validation_missing_launcher_agent_checks",
        "installer reboot validation stops at boot properties",
        f"missing={installer_missing} script={rel(INSTALLER)}",
        "Make installer post-reboot validation call the full launcher/agent validation contract.",
    )
    add_if(
        findings,
        bool(umbrella_missing_hashes) or bool(umbrella_missing_sizes),
        "umbrella_android_artifacts_missing_integrity",
        "umbrella release manifest Android artifacts lack hash or size metadata",
        f"missing_hashes={umbrella_missing_hashes} missing_sizes={umbrella_missing_sizes}",
        "Populate hash and size fields for every Android image in the umbrella release manifest.",
    )
    add_if(
        findings,
        bool(umbrella_empty_evidence),
        "umbrella_android_artifacts_missing_evidence",
        "umbrella release manifest Android artifacts have empty validation evidence",
        f"artifacts={umbrella_empty_evidence}",
        "Attach boot, role, launcher foreground, agent health, and log evidence records to each Android target.",
    )
    add_if(
        findings,
        bool(umbrella_missing_evidence_files),
        "umbrella_android_artifacts_evidence_files_missing",
        "umbrella release manifest Android artifact evidence rows point at files that do not exist",
        f"rows={umbrella_missing_evidence_files}",
        "Create explicit fail-closed missing-evidence records or collect the real evidence before promotion.",
    )
    add_if(
        findings,
        bool(umbrella_unresolved_evidence_payloads),
        "umbrella_android_artifacts_evidence_payloads_unresolved",
        "umbrella release manifest Android artifact evidence files are not collected/pass payloads",
        f"rows={umbrella_unresolved_evidence_payloads}",
        "Replace fail-closed placeholder evidence payloads with real collected/pass evidence before promotion.",
    )
    add_if(
        findings,
        bool(umbrella_uncollected_evidence),
        "umbrella_android_artifacts_evidence_not_collected",
        "umbrella release manifest Android artifacts have fail-closed validation rows that are not collected",
        f"artifacts={umbrella_uncollected_evidence}",
        "Collect boot, role, launcher foreground, agent health, fatal log, and SELinux evidence before promoting any Android artifact.",
    )
    add_if(
        findings,
        not any("riscv64" in values for values in umbrella_targets),
        "umbrella_missing_android_riscv64_chip_artifact",
        "umbrella release manifest has no Android riscv64 chip artifact",
        f"android_targets={sorted(map(sorted, umbrella_targets))}",
        "Add the chip-emulator Android riscv64 image artifact with exact validation evidence.",
    )

    evidence = {
        "android_manifest": rel(ANDROID_MANIFEST),
        "umbrella_manifest": rel(UMBRELLA_MANIFEST),
        "android_partition_artifact_count": len(artifacts),
        "umbrella_android_artifact_count": len(android_release_artifacts),
        "android_release_targets": [sorted(values) for values in umbrella_targets],
        "android_partition_artifact_integrity": android_manifest.get("validation", {}).get(
            "artifactIntegrity", {}
        ),
        "release_directory": rel(RELEASE_DIR),
        "post_flash_validator": rel(POST_FLASH),
        "installer": rel(INSTALLER),
    }
    return payload(findings, evidence)


def payload(findings: list[Finding], evidence: dict[str, object]) -> dict[str, Any]:
    blockers = [finding for finding in findings if finding.severity == "blocker"]
    return {
        "schema": SCHEMA,
        "status": "pass" if not blockers else "blocked",
        "claim_boundary": CLAIM_BOUNDARY,
        "summary": {"blockers": len(blockers), "findings": len(findings)},
        "findings": [asdict(finding) for finding in findings],
        "evidence": evidence,
    }


def write_report(report: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def print_summary(report: dict[str, Any]) -> None:
    print(f"STATUS: {str(report['status']).upper()} android.release_readiness_contract")
    for finding in report["findings"]:
        print(f"- {finding['code']}: {finding['message']}")
        print(f"  evidence: {finding['evidence']}")


def parse_args(argv: Iterable[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--report",
        default=str(REPORT),
        help=f"report path (default: {REPORT.relative_to(ROOT)})",
    )
    parser.add_argument("--json-only", action="store_true")
    return parser.parse_args(list(argv))


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    report = run_check(args)
    write_report(report, Path(args.report))
    if not args.json_only:
        print_summary(report)
    return 0 if report["status"] == "pass" else 2


if __name__ == "__main__":
    raise SystemExit(main())
