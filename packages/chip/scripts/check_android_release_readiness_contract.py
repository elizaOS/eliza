#!/usr/bin/env python3
"""Static Android release readiness contract gate.

This blocks Android release promotion when manifests still describe draft
artifacts, omit a chip/riscv64 target, or when installer/post-flash validation
only proves boot properties instead of launcher and agent liveness.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import zipfile
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = ROOT.parent
REPO_ROOT = WORKSPACE.parent
ANDROID_MANIFEST = WORKSPACE / "os/release/beta-2026-05-16/android-release-manifest.json"
UMBRELLA_MANIFEST = WORKSPACE / "os/release/beta-2026-05-16/manifest.json"
RELEASE_DIR = WORKSPACE / "os/release/beta-2026-05-16"
RELEASE_ANDROID_PARTITIONS_DIR = RELEASE_DIR / "android/partitions"
RELEASE_ANDROID_ARCHIVES_DIR = RELEASE_DIR / "android/archives"
POST_FLASH = WORKSPACE / "os/android/installer/scripts/validate-post-flash.sh"
INSTALLER = WORKSPACE / "os/android/installer/install-elizaos-android.sh"
LAUNCHER_RUNTIME_REPORT = ROOT / "build/reports/android_launcher_runtime_evidence.json"
SYSTEM_BRIDGE_REPORT = ROOT / "build/reports/android_system_bridge_contract.json"
ANDROID_APK_PAYLOAD_REPORT = ROOT / "build/reports/android_system_apk_payload.json"
REPORT = ROOT / "build/reports/android_release_readiness_contract.json"
SCHEMA = "eliza.android_release_readiness_contract.v1"
CLAIM_BOUNDARY = "static_android_release_contract_only_not_runtime_flash_or_launcher_evidence"
AOSP_WORKSPACE = Path("/home/shaw/aosp")
AOSP_PRODUCT_OUT = AOSP_WORKSPACE / "out/target/product/eliza_ai_soc"
AOSP_BUILD_REPORT = AOSP_WORKSPACE / "eliza-build-report.json"
AOSP_BUILD_LOG = AOSP_WORKSPACE / "eliza-build.log"
AOSP_BUILD_ONLY_EVIDENCE_LOGS = {
    "lunch": ROOT / "docs/evidence/android/eliza_ai_soc_lunch.log",
    "vendorimage": ROOT / "docs/evidence/android/eliza_ai_soc_vendorimage.log",
    "checkvintf": ROOT / "docs/evidence/android/eliza_ai_soc_checkvintf.log",
    "sepolicy-build": ROOT / "docs/evidence/android/eliza_ai_soc_sepolicy_build.log",
    "selinux-neverallow": ROOT / "docs/evidence/android/eliza_ai_soc_selinux_neverallow.log",
}
AOSP_IMAGE_ONLY_RESUME_LOG_GLOB = "eliza_ai_soc_image_only_resume_*.log"
AOSP_EXPECTED_CHIP_IMAGE_NAMES = ("vendor.img", "system.img", "product.img", "system_ext.img")
ANDROID_ARCHIVE_REQUIRED_MEMBERS = (
    "android-info.txt",
    "boot.img",
    "vendor_boot.img",
    "super.img",
    "system.img",
    "system_ext.img",
    "vendor.img",
    "product.img",
)
AOSP_PARTIAL_TREE_DIRS = ("vendor", "system", "product", "system_ext")
AOSP_IMAGE_BUILD_TARGETS = ("vendorimage", "systemimage", "productimage", "systemextimage")
AOSP_BUILD_ONLY_COMMAND = (
    "AOSP_DIR=/home/shaw/aosp python3 packages/chip/scripts/run_with_timeout.py "
    "--timeout-seconds 2400 --label aosp-build-only-evidence -- "
    "packages/chip/scripts/boot_android_simulator.sh --build-only"
)
AOSP_DIRECT_BUILD_COMMAND = (
    "packages/chip/sw/aosp-device/build-aosp-riscv64.sh "
    "--workspace /home/shaw/aosp --skip-sync --skip-preflight "
    "--lunch-target eliza_openagent_ai_soc_phone-trunk_staging-userdebug "
    "--report /home/shaw/aosp/eliza-build-report.json"
)
AOSP_IMAGE_ONLY_BUILD_COMMAND = (
    "cd /home/shaw/aosp && source build/envsetup.sh && "
    "lunch eliza_openagent_ai_soc_phone-trunk_staging-userdebug && "
    "m -j4 vendorimage systemimage productimage systemextimage"
)
ZERO_SHA256 = "0" * 64
HOST_SYMLINK_FINDING_CODES = {
    "launcher_permission_xml_host_symlink",
    "system_bridge_runtime_permission_xml_host_symlink",
}
ANDROID_TARGET_PREFIXES = (
    "/system/",
    "/vendor/",
    "/product/",
    "/system_ext/",
    "/odm/",
    "/apex/",
    "/data/",
)
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
LAUNCHER_AGENT_LIVENESS_SCHEMA = "eliza.android_release_launcher_agent_liveness.v1"
LAUNCHER_RUNTIME_SCHEMA = "eliza.android_launcher_runtime_evidence.v1"
LAUNCHER_RUNTIME_CLAIM_BOUNDARY = "booted_android_launcher_agent_runtime_evidence_only"
REQUIRED_LAUNCHER_LIVE_OBSERVATIONS = (
    "sys_boot_completed",
    "package_installed",
    "home_resolved_to_launcher",
    "foreground_activity",
    "agent_service_running",
    "agent_health_ready",
    "logcat_no_fatal",
    "selinux_no_denials",
)
LIVE_LAUNCHER_TARGETS = {
    "android-cuttlefish-x86_64-zip": {
        "targetKey": "cuttlefishX8664",
        "targetLabel": "cuttlefish-x86_64",
        "expectedCpuAbi": "x86_64",
        "expectedEvidenceRowId": "android-cuttlefish-x86_64-launcher-agent-live",
        "expectedReleaseEvidencePath": "evidence/android/cuttlefish-x86_64-launcher-agent-live.json",
    },
    "android-pixel-arm64-zip": {
        "targetKey": "pixelArm64",
        "targetLabel": "pixel-arm64",
        "expectedCpuAbi": "arm64-v8a",
        "expectedEvidenceRowId": "android-pixel-arm64-launcher-agent-live",
        "expectedReleaseEvidencePath": "evidence/android/pixel-arm64-launcher-agent-live.json",
    },
    "android-chip-riscv64-zip": {
        "targetKey": "chipRiscv64",
        "targetLabel": "chip-riscv64",
        "expectedCpuAbi": "riscv64",
        "expectedEvidenceRowId": "android-chip-riscv64-launcher-agent-live",
        "expectedReleaseEvidencePath": "evidence/android/chip-riscv64-launcher-agent-live.json",
    },
}


@dataclass(frozen=True)
class Finding:
    code: str
    severity: str
    message: str
    evidence: str
    next_step: str
    blocker_dependency: str = "repo_artifact_generation"


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def read_json(path: Path) -> Any:
    return json.loads(read_text(path))


def read_json_or_empty(path: Path) -> dict[str, Any]:
    try:
        value = read_json(path)
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def file_snapshot(path: Path, *, tail_lines: int = 0) -> dict[str, Any]:
    record: dict[str, Any] = {"path": str(path), "exists": path.exists()}
    if not path.exists():
        return record
    stat = path.stat()
    record["sizeBytes"] = stat.st_size
    record["mtimeUtc"] = (
        datetime.fromtimestamp(stat.st_mtime, UTC)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )
    if tail_lines:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        record["tail"] = lines[-tail_lines:]
    return record


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def count_tree_files(path: Path) -> int | None:
    if not path.is_dir():
        return None
    count = 0
    for child in path.rglob("*"):
        if child.is_file():
            count += 1
    return count


def aosp_partial_tree_snapshots(product_out: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for name in AOSP_PARTIAL_TREE_DIRS:
        tree = product_out / name
        installed_files = product_out / f"installed-files-{name}.txt"
        records.append(
            {
                "name": name,
                "path": str(tree),
                "exists": tree.is_dir(),
                "fileCount": count_tree_files(tree),
                "installedFilesList": file_snapshot(installed_files),
                "releaseCredit": False,
                "reason": (
                    "partial product-out directory proves intermediate build progress only; "
                    f"release requires {name}.img"
                ),
            }
        )
    return records


def aosp_build_log_progress(log_path: Path) -> dict[str, Any]:
    snapshot = file_snapshot(log_path, tail_lines=80)
    progress: dict[str, Any] = {
        "logFile": snapshot,
        "lastProgressLine": "",
        "lastProgressPercent": None,
        "lastProgressCompletedActions": None,
        "lastProgressTotalActions": None,
        "recentFailureLines": [],
    }
    if not log_path.is_file():
        return progress
    try:
        lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError as error:
        progress["readError"] = str(error)
        return progress
    progress_pattern = re.compile(r"\[\s*(\d+)%\s+(\d+)/(\d+)\s+")
    for line in lines:
        match = progress_pattern.search(line)
        if match:
            progress["lastProgressLine"] = line
            progress["lastProgressPercent"] = int(match.group(1))
            progress["lastProgressCompletedActions"] = int(match.group(2))
            progress["lastProgressTotalActions"] = int(match.group(3))
    failure_markers = ("error:", "FAILED:", "ninja failed", "fatal:", "Traceback")
    progress["recentFailureLines"] = [
        line
        for line in lines[-400:]
        if any(marker.lower() in line.lower() for marker in failure_markers)
    ][-20:]
    return progress


def aosp_build_only_stage_log(path: Path) -> dict[str, Any]:
    snapshot = file_snapshot(path, tail_lines=60)
    record: dict[str, Any] = {
        "path": str(path),
        "file": snapshot,
        "command": "",
        "startUtc": "",
        "endUtc": "",
        "result": None,
        "status": "missing",
        "releaseCredit": False,
        "reason": "build-only stage transcript is diagnostic evidence, not a release image",
    }
    if not path.is_file():
        return record
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    for line in lines:
        if line.startswith("COMMAND="):
            record["command"] = line.removeprefix("COMMAND=")
        elif line.startswith("START_UTC="):
            record["startUtc"] = line.removeprefix("START_UTC=")
        elif line.startswith("END_UTC="):
            record["endUtc"] = line.removeprefix("END_UTC=")
        elif line.startswith("RESULT="):
            value = line.removeprefix("RESULT=")
            try:
                record["result"] = int(value)
            except ValueError:
                record["result"] = value
    if record["result"] == 0:
        record["status"] = "pass"
    elif record["result"] is not None:
        record["status"] = "failed"
    elif record["startUtc"]:
        record["status"] = "incomplete_or_timed_out"
    return record


def aosp_build_only_evidence_inventory() -> dict[str, Any]:
    stages = {
        name: aosp_build_only_stage_log(path)
        for name, path in AOSP_BUILD_ONLY_EVIDENCE_LOGS.items()
    }
    incomplete = [
        name for name, record in stages.items() if record["status"] not in {"pass", "missing"}
    ]
    passed = [name for name, record in stages.items() if record["status"] == "pass"]
    missing = [name for name, record in stages.items() if record["status"] == "missing"]
    return {
        "status": "complete" if stages and len(passed) == len(stages) else "incomplete",
        "claimBoundary": "build_only_stage_logs_do_not_claim_release_images_or_runtime_boot",
        "passedStages": passed,
        "incompleteStages": incomplete,
        "missingStages": missing,
        "stages": stages,
        "nextStep": (
            "Rerun the bounded build-only command until vendorimage/checkvintf/sepolicy stages "
            "complete, then run the image-only resume command for system.img, product.img, "
            "and system_ext.img."
        ),
    }


def aosp_image_only_resume_attempt(path: Path) -> dict[str, Any]:
    snapshot = file_snapshot(path, tail_lines=80)
    record: dict[str, Any] = {
        "path": str(path),
        "file": snapshot,
        "command": "",
        "startUtc": "",
        "endUtc": "",
        "result": None,
        "status": "missing",
        "releaseCredit": False,
        "reason": "image-only resume transcript is diagnostic evidence until all required .img outputs exist",
        "lastProgressLine": "",
        "terminalFailureLines": [],
        "timedOut": False,
        "timeoutSeconds": None,
        "wrapperLabel": "",
        "wrapperStartUtc": "",
        "wrapperEndUtc": "",
        "reachedSoongBootstrap": False,
        "reachedSoongGraphNinjaGeneration": False,
        "reachedImageNinjaActions": False,
        "soongGraphGenerationIncomplete": False,
    }
    if not path.is_file():
        return record
    record["status"] = "unknown"
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    progress_pattern = re.compile(r"\[\s*\d+%\s+\d+/\d+\s+")
    wrapper_pattern = re.compile(
        r"\[timeout-wrapper\]\s+label=(?P<label>\S+)"
        r"(?:\s+status=(?P<status>\S+))?"
        r"\s+timeout_seconds=(?P<timeout>\d+)"
        r"(?:\s+(?P<time_key>started_at|ended_at)=(?P<timestamp>\S+))?"
    )
    for line in lines:
        if line.startswith("COMMAND="):
            record["command"] = line.removeprefix("COMMAND=")
        elif line.startswith("START_UTC="):
            record["startUtc"] = line.removeprefix("START_UTC=")
        elif line.startswith("END_UTC="):
            record["endUtc"] = line.removeprefix("END_UTC=")
        elif line.startswith("RESULT="):
            value = line.removeprefix("RESULT=")
            try:
                record["result"] = int(value)
            except ValueError:
                record["result"] = value
        if match := wrapper_pattern.search(line):
            record["wrapperLabel"] = match.group("label")
            record["timeoutSeconds"] = int(match.group("timeout"))
            if match.group("time_key") == "started_at":
                record["wrapperStartUtc"] = match.group("timestamp")
            elif match.group("time_key") == "ended_at":
                record["wrapperEndUtc"] = match.group("timestamp")
        if progress_pattern.search(line):
            record["lastProgressLine"] = line
        if "bootstrap blueprint" in line or "Running globs..." in line:
            record["reachedSoongBootstrap"] = True
        if "build.eliza_openagent_ai_soc_phone.ninja" in line:
            record["reachedSoongGraphNinjaGeneration"] = True
        if any(target in line for target in ("system.img", "product.img", "system_ext.img")):
            record["reachedImageNinjaActions"] = True
    failure_markers = (
        "FAILED:",
        "error:",
        "soong bootstrap failed",
        "status=timeout",
        "Got signal: terminated",
        "action cancelled",
    )
    record["terminalFailureLines"] = [
        line
        for line in lines[-160:]
        if any(marker.lower() in line.lower() for marker in failure_markers)
    ][-20:]
    record["timedOut"] = any("status=timeout" in line for line in lines)
    record["soongGraphGenerationIncomplete"] = record["reachedSoongGraphNinjaGeneration"] and any(
        "soong bootstrap failed" in line for line in lines
    )
    if record["result"] == 0:
        record["status"] = "pass"
    elif record["timedOut"]:
        record["status"] = "timeout"
    elif record["result"] is not None:
        record["status"] = "failed"
    elif record["wrapperStartUtc"] or record["startUtc"]:
        record["status"] = "in_progress"
    elif record["startUtc"]:
        record["status"] = "incomplete_or_timed_out"
    return record


def aosp_image_only_resume_inventory(
    evidence_dir: Path = ROOT / "docs/evidence/android",
) -> dict[str, Any]:
    attempts = [
        aosp_image_only_resume_attempt(path)
        for path in sorted(evidence_dir.glob(AOSP_IMAGE_ONLY_RESUME_LOG_GLOB))
    ]
    latest = attempts[-1] if attempts else None
    return {
        "status": "missing" if latest is None else latest["status"],
        "claimBoundary": "image_only_resume_logs_do_not_claim_release_images_or_runtime_boot",
        "glob": str(evidence_dir / AOSP_IMAGE_ONLY_RESUME_LOG_GLOB),
        "attemptCount": len(attempts),
        "latestAttempt": latest,
        "requiredTargets": list(AOSP_IMAGE_BUILD_TARGETS[1:]),
        "releaseCredit": False,
        "nextStep": (
            "Rerun the bounded image-only resume command until Soong finishes graph "
            "generation and Ninja reaches systemimage, productimage, and systemextimage; "
            "then verify system.img, product.img, and system_ext.img in product_out."
        ),
    }


def active_aosp_build_processes() -> str:
    import subprocess

    completed = subprocess.run(
        [
            "sh",
            "-lc",
            "ps -eo pid,ppid,etime,stat,cmd | "
            "grep -E 'aosp-build-only-evidence|build-aosp-riscv64|boot_android_simulator|"
            "capture-aosp-evidence|soong_ui|prebuilts/build-tools/.*/ninja|/bin/m ' | "
            "grep -v grep || true",
        ],
        check=False,
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=10,
    )
    return completed.stdout.strip()


def expected_android_payload_package() -> str:
    report = read_json_or_empty(ANDROID_APK_PAYLOAD_REPORT)
    evidence = report.get("evidence")
    if not isinstance(evidence, dict):
        return "ai.elizaos.app"
    for key in ("provenance_android_package", "vendor_ro_elizaos_home", "expected_package"):
        value = evidence.get(key)
        if isinstance(value, str) and value:
            return value
    return "ai.elizaos.app"


def rel(path: Path) -> str:
    try:
        return path.relative_to(WORKSPACE).as_posix()
    except ValueError:
        return str(path)


def repo_rel(path: Path) -> str:
    try:
        return path.relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return str(path)


def add_if(
    findings: list[Finding],
    condition: bool,
    code: str,
    message: str,
    evidence: str,
    next_step: str,
    blocker_dependency: str = "repo_artifact_generation",
) -> None:
    if condition:
        findings.append(Finding(code, "blocker", message, evidence, next_step, blocker_dependency))


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
        row_status = str(row.get("status", "")).lower()
        if row_status not in allowed_statuses:
            continue
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
            unresolved.append(
                f"{evidence_row_label(artifact, row)}: payload_status={status or '<missing>'}"
            )
    return unresolved


def missing_required_android_evidence_rows(artifact: dict[str, Any]) -> list[str]:
    artifact_id = str(artifact.get("id", artifact.get("filename", "<unknown>")))
    row_ids = {
        str(row.get("id", "")) for row in evidence_rows(artifact) if isinstance(row.get("id"), str)
    }
    missing: list[str] = []
    if not any(row_id.endswith("-artifact-integrity") for row_id in row_ids):
        missing.append(f"{artifact_id}:*-artifact-integrity")
    if not any(row_id.endswith("-launcher-agent-live") for row_id in row_ids):
        missing.append(f"{artifact_id}:*-launcher-agent-live")
    return missing


def invalid_artifact_integrity_payloads(artifact: dict[str, Any]) -> list[str]:
    invalid: list[str] = []
    artifact_id = str(artifact.get("id", artifact.get("filename", "<unknown>")))
    filename = artifact.get("filename")
    manifest_sha = artifact.get("sha256")
    manifest_size = artifact.get("sizeBytes")
    for row in evidence_rows(artifact):
        row_id = str(row.get("id", ""))
        if not row_id.endswith("-artifact-integrity"):
            continue
        path = row.get("path")
        if not isinstance(path, str) or not path:
            invalid.append(f"{artifact_id}:{row_id}:missing_path")
            continue
        evidence_path = RELEASE_DIR / path
        if not evidence_path.is_file():
            continue
        try:
            payload = json.loads(evidence_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        payload_artifact_id = payload.get("artifact_id")
        payload_filename = payload.get("filename")
        payload_sha = payload.get("sha256")
        payload_size = payload.get("sizeBytes")
        if payload_artifact_id != artifact.get("id"):
            invalid.append(f"{artifact_id}:{row_id}:artifact_id={payload_artifact_id!r}")
        if payload_filename != filename:
            invalid.append(f"{artifact_id}:{row_id}:filename={payload_filename!r}")
        if payload_sha != manifest_sha:
            invalid.append(f"{artifact_id}:{row_id}:sha256={payload_sha!r}")
        if payload_size != manifest_size:
            invalid.append(f"{artifact_id}:{row_id}:sizeBytes={payload_size!r}")
    return invalid


def artifact_integrity_payload_for(artifact: dict[str, Any]) -> dict[str, Any]:
    for row in evidence_rows(artifact):
        if not str(row.get("id", "")).endswith("-artifact-integrity"):
            continue
        path = row.get("path")
        if not isinstance(path, str) or not path:
            return {}
        evidence_path = RELEASE_DIR / path
        if not evidence_path.is_file():
            return {}
        return read_json_or_empty(evidence_path)
    return {}


def staged_android_archive_integrity_inventory(
    umbrella: dict[str, Any],
) -> dict[str, Any]:
    records: list[dict[str, Any]] = []
    mismatches: list[str] = []
    missing_archives: list[str] = []
    for artifact in android_artifacts(umbrella):
        artifact_id = str(artifact.get("id", artifact.get("filename", "<unknown>")))
        filename = artifact.get("filename")
        if not isinstance(filename, str) or not filename:
            missing_archives.append(f"{artifact_id}:filename=<missing>")
            continue
        expected = RELEASE_ANDROID_ARCHIVES_DIR / filename
        record: dict[str, Any] = {
            "artifactId": artifact_id,
            "filename": filename,
            "expectedPath": repo_rel(expected),
            "present": expected.is_file(),
            "manifestSizeBytes": artifact.get("sizeBytes"),
            "manifestSha256": artifact.get("sha256"),
            "actualSizeBytes": None,
            "actualSha256": None,
            "sizeMatchesManifest": None,
            "sha256MatchesManifest": None,
            "evidenceMatchesActual": None,
            "zipReadable": None,
            "requiredMembers": list(ANDROID_ARCHIVE_REQUIRED_MEMBERS),
            "presentMembers": [],
            "missingMembers": list(ANDROID_ARCHIVE_REQUIRED_MEMBERS),
            "extraReleaseMembers": [],
            "releaseCredit": False,
            "claimBoundary": "staged_archive_static_integrity_only_not_boot_or_launcher_liveness",
        }
        if not expected.is_file():
            missing_archives.append(f"{artifact_id}:{repo_rel(expected)}")
            records.append(record)
            continue

        stat = expected.stat()
        actual_size = stat.st_size
        actual_sha = file_sha256(expected)
        record["actualSizeBytes"] = actual_size
        record["actualSha256"] = actual_sha
        record["sizeMatchesManifest"] = artifact.get("sizeBytes") == actual_size
        record["sha256MatchesManifest"] = artifact.get("sha256") == actual_sha
        if not record["sizeMatchesManifest"]:
            mismatches.append(
                f"{artifact_id}:sizeBytes manifest={artifact.get('sizeBytes')!r} actual={actual_size}"
            )
        if not record["sha256MatchesManifest"]:
            mismatches.append(
                f"{artifact_id}:sha256 manifest={artifact.get('sha256')!r} actual={actual_sha}"
            )

        payload = artifact_integrity_payload_for(artifact)
        evidence_size = payload.get("sizeBytes")
        evidence_sha = payload.get("sha256")
        evidence_path = payload.get("path")
        record["evidenceSizeBytes"] = evidence_size
        record["evidenceSha256"] = evidence_sha
        record["evidencePath"] = evidence_path
        record["evidenceMatchesActual"] = (
            evidence_size == actual_size and evidence_sha == actual_sha
        )
        if payload and not record["evidenceMatchesActual"]:
            mismatches.append(
                f"{artifact_id}:evidence_integrity size={evidence_size!r} sha256={evidence_sha!r}"
            )
        if isinstance(evidence_path, str) and evidence_path:
            evidence_archive_path = _release_relative_path(evidence_path)
            record["evidenceArchivePathExists"] = evidence_archive_path.is_file()
            record["evidenceArchivePath"] = repo_rel(evidence_archive_path)
            if evidence_archive_path != expected:
                mismatches.append(
                    f"{artifact_id}:evidence_path={evidence_path!r} expected={repo_rel(expected)!r}"
                )

        try:
            with zipfile.ZipFile(expected) as archive:
                names = sorted(info.filename for info in archive.infolist())
        except zipfile.BadZipFile as error:
            record["zipReadable"] = False
            record["zipError"] = str(error)
            mismatches.append(f"{artifact_id}:zip_unreadable={error}")
        else:
            required = set(ANDROID_ARCHIVE_REQUIRED_MEMBERS)
            present = [name for name in ANDROID_ARCHIVE_REQUIRED_MEMBERS if name in names]
            missing = [name for name in ANDROID_ARCHIVE_REQUIRED_MEMBERS if name not in names]
            record["zipReadable"] = True
            record["presentMembers"] = present
            record["missingMembers"] = missing
            record["extraReleaseMembers"] = [
                name for name in names if name.endswith(".img") and name not in required
            ]
            if missing:
                mismatches.append(f"{artifact_id}:missing_zip_members={missing}")

        record["releaseCredit"] = bool(
            record["sizeMatchesManifest"]
            and record["sha256MatchesManifest"]
            and (not payload or record["evidenceMatchesActual"])
            and record["zipReadable"]
            and not record["missingMembers"]
        )
        records.append(record)

    return {
        "status": "pass" if not mismatches and not missing_archives else "blocked",
        "claimBoundary": "staged_archive_static_integrity_only_not_boot_or_launcher_liveness",
        "records": records,
        "missingArchives": missing_archives,
        "mismatches": mismatches,
    }


def staged_chip_riscv64_archive_has_release_integrity(
    staged_archive_inventory: dict[str, Any],
) -> bool:
    records = staged_archive_inventory.get("records")
    if not isinstance(records, list):
        return False
    for record in records:
        if not isinstance(record, dict):
            continue
        if record.get("artifactId") != "android-chip-riscv64-zip":
            continue
        return bool(record.get("releaseCredit"))
    return False


def _release_relative_path(path_value: str) -> Path:
    path = Path(path_value)
    if path.is_absolute():
        return path
    candidates = (RELEASE_DIR / path, REPO_ROOT / path, WORKSPACE / path)
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return RELEASE_DIR / path


def invalid_partition_artifact_integrity_payloads(
    android_manifest: dict[str, Any],
) -> list[str]:
    invalid: list[str] = []
    validation = android_manifest.get("validation")
    integrity = validation.get("artifactIntegrity") if isinstance(validation, dict) else None
    if not isinstance(integrity, dict):
        return ["artifactIntegrity=<missing>"]
    evidence_ref = integrity.get("evidence") or integrity.get("path")
    if not isinstance(evidence_ref, str) or not evidence_ref:
        return ["artifactIntegrity.evidence=<missing>"]
    evidence_path = _release_relative_path(evidence_ref)
    if not evidence_path.is_file():
        return [f"artifactIntegrity.evidence_file_missing={evidence_ref!r}"]
    try:
        payload = json.loads(evidence_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return [f"artifactIntegrity.evidence_unreadable={error}"]
    status = str(payload.get("status", "")).lower()
    if status not in {"collected", "pass", "passed"}:
        invalid.append(f"artifactIntegrity.payload_status={status or '<missing>'}")
    payload_artifacts = payload.get("artifacts")
    if not isinstance(payload_artifacts, list):
        return invalid + ["artifactIntegrity.payload_artifacts=<missing>"]
    payload_by_filename = {
        row.get("filename"): row
        for row in payload_artifacts
        if isinstance(row, dict) and isinstance(row.get("filename"), str)
    }
    for artifact in android_manifest.get("artifacts", []):
        if not isinstance(artifact, dict):
            continue
        filename = artifact.get("filename")
        if not isinstance(filename, str) or not filename:
            continue
        row = payload_by_filename.get(filename)
        if not isinstance(row, dict):
            invalid.append(f"{filename}:payload_row=<missing>")
            continue
        if row.get("partition") != artifact.get("partition"):
            invalid.append(f"{filename}:partition={row.get('partition')!r}")
        if row.get("sha256") != artifact.get("sha256"):
            invalid.append(f"{filename}:sha256={row.get('sha256')!r}")
        if row.get("sizeBytes") != artifact.get("sizeBytes"):
            invalid.append(f"{filename}:sizeBytes={row.get('sizeBytes')!r}")
        if "manifestSha256" in row and row.get("manifestSha256") != artifact.get("sha256"):
            invalid.append(f"{filename}:manifestSha256={row.get('manifestSha256')!r}")
        if "manifestSizeBytes" in row and row.get("manifestSizeBytes") != artifact.get("sizeBytes"):
            invalid.append(f"{filename}:manifestSizeBytes={row.get('manifestSizeBytes')!r}")
        if row.get("status") == "mismatch":
            invalid.append(f"{filename}:status=mismatch")
        if row.get("sha256Matches") is False:
            invalid.append(f"{filename}:sha256Matches=false")
        if row.get("sizeMatches") is False:
            invalid.append(f"{filename}:sizeMatches=false")
    return invalid


def _boolish_true(value: Any) -> bool:
    if value is True:
        return True
    if isinstance(value, str):
        return value.lower() in {"true", "yes", "1", "pass", "passed", "ready"}
    return False


def _intish(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and re.fullmatch(r"\d+", value.strip()):
        return int(value.strip())
    return None


def _runtime_log_counter_gaps(
    logs: dict[str, Any],
    *,
    canonical_key: str,
    legacy_key: str,
) -> list[str]:
    gaps: list[str] = []
    canonical_value = logs.get(canonical_key)
    canonical_count = _intish(canonical_value)
    if canonical_count is None:
        gaps.append(f"{canonical_key}={canonical_value!r}")
        return gaps
    if canonical_count != 0:
        gaps.append(f"{canonical_key}={canonical_value!r}")

    if legacy_key in logs:
        legacy_value = logs.get(legacy_key)
        legacy_count = _intish(legacy_value)
        if legacy_count is None or legacy_count != canonical_count:
            gaps.append(
                f"{legacy_key}={legacy_value!r} conflicts_with_{canonical_key}={canonical_value!r}"
            )
    return gaps


def _launcher_runtime_payload_gaps(
    payload: dict[str, Any],
    *,
    expected_target_label: str | None = None,
) -> list[str]:
    gaps: list[str] = []
    _app = payload.get("app")
    app: dict[str, object] = _app if isinstance(_app, dict) else {}
    _agent = payload.get("agent")
    agent: dict[str, object] = _agent if isinstance(_agent, dict) else {}
    _device = payload.get("device")
    device: dict[str, object] = _device if isinstance(_device, dict) else {}
    _logs = payload.get("logs")
    logs: dict[str, object] = _logs if isinstance(_logs, dict) else {}
    package_name = app.get("package_name")
    if payload.get("status") != "PASS":
        gaps.append(f"status={payload.get('status')!r}")
    if payload.get("result") != 0:
        gaps.append(f"result={payload.get('result')!r}")
    if payload.get("claim_boundary") != LAUNCHER_RUNTIME_CLAIM_BOUNDARY:
        gaps.append(f"claim_boundary={payload.get('claim_boundary')!r}")
    if expected_target_label and payload.get("target_label") != expected_target_label:
        gaps.append(
            f"target_label={payload.get('target_label')!r} expected_target_label={expected_target_label!r}"
        )
    if device.get("sys_boot_completed") != "1":
        gaps.append(f"sys_boot_completed={device.get('sys_boot_completed')!r}")
    if not isinstance(package_name, str) or not package_name:
        gaps.append("package_name=<missing>")
    elif not any(
        package_name in str(app.get(key, ""))
        for key in ("pm_path", "home_resolve_activity", "foreground_activity")
    ):
        gaps.append("launcher_package_not_observed_in_pm_home_or_foreground")
    if (
        not _boolish_true(app.get("system_apk_present"))
        and app.get("system_apk_present") != "present"
    ):
        gaps.append(f"system_apk_present={app.get('system_apk_present')!r}")
    service_pid = app.get("service_pid")
    if service_pid in {None, "", "0", 0}:
        gaps.append(f"service_pid={service_pid!r}")
    if agent.get("health_http") not in {200, "200"}:
        gaps.append(f"health_http={agent.get('health_http')!r}")
    if not _boolish_true(agent.get("health_ready")):
        gaps.append(f"health_ready={agent.get('health_ready')!r}")
    gaps.extend(
        _runtime_log_counter_gaps(
            logs,
            canonical_key="fatal_crash_count",
            legacy_key="fatal_count",
        )
    )
    gaps.extend(
        _runtime_log_counter_gaps(
            logs,
            canonical_key="avc_denial_count",
            legacy_key="selinux_avc_denied_count",
        )
    )
    return gaps


def invalid_launcher_agent_payloads(artifact: dict[str, Any]) -> list[str]:
    invalid: list[str] = []
    artifact_id = str(artifact.get("id", artifact.get("filename", "<unknown>")))
    target_plan = LIVE_LAUNCHER_TARGETS.get(artifact_id)
    for row in evidence_rows(artifact):
        row_id = str(row.get("id", ""))
        if not row_id.endswith("-launcher-agent-live"):
            continue
        if target_plan is not None:
            expected_row_id = str(target_plan["expectedEvidenceRowId"])
            expected_path = str(target_plan["expectedReleaseEvidencePath"])
            if row_id != expected_row_id:
                invalid.append(f"{artifact_id}:{row_id}:expected_row_id={expected_row_id!r}")
            if row.get("path") != expected_path:
                invalid.append(f"{artifact_id}:{row_id}:expected_path={expected_path!r}")
        path = row.get("path")
        if not isinstance(path, str) or not path:
            invalid.append(f"{artifact_id}:{row_id}:missing_path")
            continue
        evidence_path = RELEASE_DIR / path
        if not evidence_path.is_file():
            continue
        try:
            payload = json.loads(evidence_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if str(payload.get("status", "")).lower() not in {"collected", "pass", "passed"}:
            continue
        if payload.get("artifact_id") != artifact.get("id"):
            invalid.append(f"{artifact_id}:{row_id}:artifact_id={payload.get('artifact_id')!r}")
        schema = payload.get("schema")
        if schema == LAUNCHER_AGENT_LIVENESS_SCHEMA:
            observed = payload.get("observed")
            if not isinstance(observed, dict):
                invalid.append(f"{artifact_id}:{row_id}:observed=<missing>")
                continue
            missing = [
                name
                for name in REQUIRED_LAUNCHER_LIVE_OBSERVATIONS
                if not _boolish_true(observed.get(name))
            ]
            if missing:
                invalid.append(f"{artifact_id}:{row_id}:missing_observed={missing}")
        elif schema == LAUNCHER_RUNTIME_SCHEMA:
            gaps = _launcher_runtime_payload_gaps(
                payload,
                expected_target_label=(
                    str(target_plan["targetLabel"]) if target_plan is not None else None
                ),
            )
            if gaps:
                invalid.append(f"{artifact_id}:{row_id}:runtime_gaps={gaps}")
        else:
            invalid.append(f"{artifact_id}:{row_id}:schema={schema!r}")
    return invalid


def launcher_agent_live_row(artifact: dict[str, Any]) -> dict[str, Any] | None:
    for row in evidence_rows(artifact):
        row_id = str(row.get("id", ""))
        if row_id.endswith("-launcher-agent-live"):
            return row
    return None


def launcher_agent_live_evidence_status(artifact: dict[str, Any]) -> tuple[str, list[str]]:
    row = launcher_agent_live_row(artifact)
    if row is None:
        return "missing_row", ["launcher-agent-live evidence row is not declared"]

    blockers: list[str] = []
    artifact_id = str(artifact.get("id", artifact.get("filename", "<unknown>")))
    target_plan = LIVE_LAUNCHER_TARGETS.get(artifact_id)
    row_status = str(row.get("status", "")).lower()
    if row_status != "collected":
        blockers.append(f"row_status={row_status or '<missing>'}")
    row_id = str(row.get("id", ""))
    if target_plan is not None:
        expected_row_id = str(target_plan["expectedEvidenceRowId"])
        expected_path = str(target_plan["expectedReleaseEvidencePath"])
        if row_id != expected_row_id:
            blockers.append(f"row_id={row_id!r} expected_row_id={expected_row_id!r}")
        if row.get("path") != expected_path:
            blockers.append(f"row_path={row.get('path')!r} expected_path={expected_path!r}")
    path = row.get("path")
    if not isinstance(path, str) or not path:
        blockers.append("row_path=<missing>")
        return "blocked", blockers
    evidence_path = RELEASE_DIR / path
    if not evidence_path.is_file():
        blockers.append(f"evidence_file_missing={path}")
        return "blocked", blockers

    try:
        payload = json.loads(evidence_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        blockers.append(f"evidence_json_unreadable={error}")
        return "blocked", blockers

    payload_status = str(payload.get("status", "")).lower()
    if payload_status not in {"collected", "pass", "passed"}:
        blockers.append(f"payload_status={payload_status or '<missing>'}")
    if payload.get("artifact_id") != artifact.get("id"):
        blockers.append(f"payload_artifact_id={payload.get('artifact_id')!r}")

    schema = payload.get("schema")
    if schema == LAUNCHER_AGENT_LIVENESS_SCHEMA:
        observed = payload.get("observed")
        if not isinstance(observed, dict):
            blockers.append("observed=<missing>")
        else:
            missing = [
                name
                for name in REQUIRED_LAUNCHER_LIVE_OBSERVATIONS
                if not _boolish_true(observed.get(name))
            ]
            if missing:
                blockers.append(f"missing_observations={missing}")
    elif schema == LAUNCHER_RUNTIME_SCHEMA:
        gaps = _launcher_runtime_payload_gaps(
            payload,
            expected_target_label=(
                str(target_plan["targetLabel"]) if target_plan is not None else None
            ),
        )
        if gaps:
            blockers.append(f"runtime_gaps={gaps}")
    else:
        blockers.append(f"schema={schema!r}")

    return ("collected" if not blockers else "blocked", blockers)


def live_launcher_agent_missing_evidence(umbrella: dict[str, Any]) -> dict[str, Any]:
    commands = live_launcher_agent_capture_commands()
    records: list[dict[str, Any]] = []
    missing_targets: list[str] = []
    for artifact in android_artifacts(umbrella):
        artifact_id = str(artifact.get("id", artifact.get("filename", "<unknown>")))
        target_plan = LIVE_LAUNCHER_TARGETS.get(artifact_id)
        if target_plan is None:
            continue
        row = launcher_agent_live_row(artifact)
        status, blockers = launcher_agent_live_evidence_status(artifact)
        target_key = str(target_plan["targetKey"])
        if status != "collected":
            missing_targets.append(artifact_id)
        expected_release_path = str(target_plan["expectedReleaseEvidencePath"])
        target_label = str(target_plan["targetLabel"])
        expected_outputs = [
            expected_release_path,
            f"docs/evidence/android/{target_label}-launcher-agent-live.logcat.txt",
            f"docs/evidence/android/{target_label}-launcher-agent-live.transcript.log",
        ]
        validation_command = (
            "python3 packages/chip/scripts/check_android_launcher_runtime_evidence.py "
            f"--expected-artifact-id {artifact_id} "
            f"--expected-target-label {target_label} "
            f"--expected-cpu-abi {target_plan['expectedCpuAbi']} "
            f"--evidence {repo_rel(RELEASE_DIR / expected_release_path)}"
        )
        records.append(
            {
                "artifactId": artifact_id,
                "target": artifact.get("target", {}),
                "targetKey": target_key,
                "status": status,
                "releaseCredit": False,
                "blockers": blockers,
                "expectedCpuAbi": target_plan["expectedCpuAbi"],
                "expectedTargetLabel": target_plan["targetLabel"],
                "expectedEvidenceRowId": target_plan["expectedEvidenceRowId"],
                "expectedReleaseEvidencePath": target_plan["expectedReleaseEvidencePath"],
                "expectedOutputFiles": expected_outputs,
                "validationCommand": validation_command,
                "releaseCreditRule": (
                    "release_credit remains false until the target-specific capture command "
                    "and validation command both pass against this exact artifact id, target "
                    "label, CPU ABI, and release evidence path"
                ),
                "releaseEvidencePathMatchesExpected": bool(
                    row
                    and row.get("id") == target_plan["expectedEvidenceRowId"]
                    and row.get("path") == target_plan["expectedReleaseEvidencePath"]
                ),
                "manifestEvidenceRow": row or None,
                "collectionCommands": commands.get(target_key, []),
            }
        )
    return {
        "status": "pass" if not missing_targets else "blocked",
        "claimBoundary": "target_collection_plan_only_not_collected_runtime_evidence",
        "requiredObservationContract": list(REQUIRED_LAUNCHER_LIVE_OBSERVATIONS),
        "missingTargets": missing_targets,
        "records": records,
    }


def host_symlink_runtime_findings() -> list[str]:
    findings: list[str] = []
    for report_path in (LAUNCHER_RUNTIME_REPORT, SYSTEM_BRIDGE_REPORT):
        if not report_path.is_file():
            continue
        try:
            report = read_json(report_path)
        except (OSError, json.JSONDecodeError) as error:
            findings.append(f"{rel(report_path)}: unreadable_json={error}")
            continue
        rows = report.get("findings", [])
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, dict):
                continue
            code = str(row.get("code", ""))
            evidence = str(row.get("evidence", ""))
            if (
                code in HOST_SYMLINK_FINDING_CODES
                or "host_symlink" in code
                or contains_host_local_symlink(evidence)
            ):
                findings.append(f"{rel(report_path)}:{code}:{evidence}")
    return findings


def contains_host_local_symlink(text: str) -> bool:
    for target in re.findall(r"->\s+(/[^\s\"']+)", text):
        if not target.startswith(ANDROID_TARGET_PREFIXES):
            return True
    return any(marker in text for marker in (" -> /home/", " -> /tmp/", " -> /Users/"))


def artifact_identity(artifact: dict[str, Any]) -> str:
    artifact_id = artifact.get("id", artifact.get("partition", "<unknown>"))
    filename = artifact.get("filename", "<missing-filename>")
    return f"{artifact_id}:{filename}"


def android_release_artifact_inventory(
    android_manifest: dict[str, Any], umbrella: dict[str, Any]
) -> dict[str, Any]:
    partition_records = []
    for artifact in android_manifest.get("artifacts", []):
        if not isinstance(artifact, dict):
            continue
        filename = artifact.get("filename")
        if not isinstance(filename, str) or not filename:
            continue
        expected = RELEASE_ANDROID_PARTITIONS_DIR / filename
        partition_records.append(
            {
                "partition": artifact.get("partition"),
                "filename": filename,
                "expectedPath": repo_rel(expected),
                "sourcePath": f"$AOSP_ROOT/out/target/product/caiman/{filename}",
                "present": expected.is_file(),
                "manifestSizeBytes": artifact.get("sizeBytes"),
                "manifestSha256": artifact.get("sha256"),
            }
        )

    archive_records = []
    for artifact in android_artifacts(umbrella):
        filename = artifact.get("filename")
        if not isinstance(filename, str) or not filename:
            continue
        target = artifact.get("target", {})
        expected = RELEASE_ANDROID_ARCHIVES_DIR / filename
        source_dir = "$AOSP_ROOT/out/target/product/<target>"
        if isinstance(target, dict):
            device = str(target.get("device", ""))
            architecture = str(target.get("architecture", ""))
            if device == "cf_x86_64_phone":
                source_dir = "$AOSP_ROOT/out/target/product/vsoc_x86_64_only"
            elif architecture == "arm64" and device == "pixel-supported":
                source_dir = "$AOSP_ROOT/out/target/product/caiman"
            elif architecture == "riscv64" and device == "eliza_ai_soc":
                source_dir = "$AOSP_WORKSPACE/out/target/product/eliza_ai_soc"
        archive_records.append(
            {
                "artifactId": artifact.get("id"),
                "filename": filename,
                "target": target,
                "expectedPath": repo_rel(expected),
                "sourceDirectory": source_dir,
                "present": expected.is_file(),
                "manifestSizeBytes": artifact.get("sizeBytes"),
                "manifestSha256": artifact.get("sha256"),
            }
        )

    missing_partitions = [
        record["expectedPath"] for record in partition_records if not record["present"]
    ]
    missing_archives = [
        record["expectedPath"] for record in archive_records if not record["present"]
    ]
    return {
        "status": "pass" if not missing_partitions and not missing_archives else "blocked",
        "searchedRoots": [
            repo_rel(RELEASE_DIR),
            repo_rel(WORKSPACE / "os/android"),
            str(AOSP_WORKSPACE / "out/target/product"),
        ],
        "partitionArtifacts": partition_records,
        "umbrellaAndroidArchives": archive_records,
        "missing": {
            "partitionArtifacts": missing_partitions,
            "umbrellaAndroidArchives": missing_archives,
        },
        "commands": {
            "buildPixelCaimanPartitions": [
                "make -C packages/os/android bootanimation",
                'cd "$AOSP_ROOT" && source build/envsetup.sh && lunch eliza_caiman_phone-trunk_staging-userdebug && m -j"$(nproc)" bootimage vendorbootimage superimage',
            ],
            "stagePixelCaimanPartitions": [
                f"mkdir -p {repo_rel(RELEASE_ANDROID_PARTITIONS_DIR)}",
                f'cp "$AOSP_ROOT/out/target/product/caiman/boot.img" {repo_rel(RELEASE_ANDROID_PARTITIONS_DIR)}/boot.img',
                f'cp "$AOSP_ROOT/out/target/product/caiman/vendor_boot.img" {repo_rel(RELEASE_ANDROID_PARTITIONS_DIR)}/vendor_boot.img',
                f'cp "$AOSP_ROOT/out/target/product/caiman/super.img" {repo_rel(RELEASE_ANDROID_PARTITIONS_DIR)}/super.img',
            ],
            "buildCuttlefishX8664Archive": [
                "make -C packages/os/android bootanimation",
                'node packages/scripts/distro-android/build-aosp.mjs --brand-config packages/scripts/distro-android/brand.eliza.json --aosp-root "$AOSP_ROOT" --skip-libllama',
                f"mkdir -p {repo_rel(RELEASE_ANDROID_ARCHIVES_DIR)}",
                f'cd "$AOSP_ROOT/out/target/product/vsoc_x86_64_only" && zip -qry "$OLDPWD/{repo_rel(RELEASE_ANDROID_ARCHIVES_DIR)}/elizaos-beta-2026.05.16-android-cf_x86_64_phone.zip" android-info.txt boot.img vendor_boot.img super.img system.img system_ext.img vendor.img product.img',
            ],
            "buildPixelArm64Archive": [
                "make -C packages/os/android bootanimation",
                'cd "$AOSP_ROOT" && source build/envsetup.sh && lunch eliza_caiman_phone-trunk_staging-userdebug && m -j"$(nproc)"',
                f"mkdir -p {repo_rel(RELEASE_ANDROID_ARCHIVES_DIR)}",
                f'cd "$AOSP_ROOT/out/target/product/caiman" && zip -qry "$OLDPWD/{repo_rel(RELEASE_ANDROID_ARCHIVES_DIR)}/elizaos-beta-2026.05.16-android-pixel-arm64.zip" android-info.txt boot.img vendor_boot.img super.img system.img system_ext.img vendor.img product.img',
            ],
            "buildChipRiscv64Archive": [
                'packages/chip/sw/aosp-device/build-aosp-riscv64.sh --workspace "$AOSP_WORKSPACE" --lunch-target eliza_openagent_ai_soc_phone-trunk_staging-userdebug --report "$AOSP_WORKSPACE/eliza-build-report.json"',
                f"mkdir -p {repo_rel(RELEASE_ANDROID_ARCHIVES_DIR)}",
                f'cd "$AOSP_WORKSPACE/out/target/product/eliza_ai_soc" && zip -qry "$OLDPWD/{repo_rel(RELEASE_ANDROID_ARCHIVES_DIR)}/elizaos-beta-2026.05.16-android-eliza_ai_soc-riscv64.zip" android-info.txt boot.img vendor_boot.img super.img system.img system_ext.img vendor.img product.img',
            ],
            "generateArchiveIntegrityEvidence": [
                f"stat -c '%n %s' {repo_rel(RELEASE_ANDROID_ARCHIVES_DIR)}/*.zip",
                f"sha256sum {repo_rel(RELEASE_ANDROID_ARCHIVES_DIR)}/*.zip",
                (
                    "for each staged archive, write evidence/android/<target>-artifact-integrity.json "
                    "with status=collected, artifact_id, filename, path, exact sizeBytes, exact sha256, "
                    "members from `unzip -Z1`; then copy the same sizeBytes/sha256 into manifest.json"
                ),
            ],
            "populateIntegrity": [
                f"stat -c '%n %s' {repo_rel(RELEASE_ANDROID_PARTITIONS_DIR)}/*.img {repo_rel(RELEASE_ANDROID_ARCHIVES_DIR)}/*.zip",
                f"sha256sum {repo_rel(RELEASE_ANDROID_PARTITIONS_DIR)}/*.img {repo_rel(RELEASE_ANDROID_ARCHIVES_DIR)}/*.zip",
                "copy only those exact byte sizes and SHA-256 values into the manifests; do not use placeholders",
            ],
            "validate": [
                f"node packages/os/android/installer/scripts/validate-release-manifest.mjs {repo_rel(ANDROID_MANIFEST)} --artifact-dir {repo_rel(RELEASE_ANDROID_PARTITIONS_DIR)} --write-evidence {repo_rel(RELEASE_DIR / 'evidence/android/android-partition-artifacts-integrity.json')}",
                "python packages/chip/scripts/check_android_release_readiness_contract.py",
            ],
        },
    }


def archive_source_directory_for_artifact(artifact: dict[str, Any]) -> Path | None:
    target = artifact.get("target")
    if not isinstance(target, dict):
        return None
    device = str(target.get("device", ""))
    architecture = str(target.get("architecture", ""))
    if device == "cf_x86_64_phone":
        return AOSP_WORKSPACE / "out/target/product/vsoc_x86_64_only"
    if architecture == "arm64" and device == "pixel-supported":
        return AOSP_WORKSPACE / "out/target/product/caiman"
    if architecture == "riscv64" and device == "eliza_ai_soc":
        return AOSP_WORKSPACE / "out/target/product/eliza_ai_soc"
    return None


def android_archive_source_member_inventory(umbrella: dict[str, Any]) -> dict[str, Any]:
    records: list[dict[str, Any]] = []
    for artifact in android_artifacts(umbrella):
        filename = artifact.get("filename")
        source_dir = archive_source_directory_for_artifact(artifact)
        required = list(ANDROID_ARCHIVE_REQUIRED_MEMBERS)
        if source_dir is None:
            records.append(
                {
                    "artifactId": artifact.get("id"),
                    "filename": filename,
                    "sourceDirectory": None,
                    "sourceDirectoryExists": False,
                    "requiredMembers": required,
                    "presentMembers": [],
                    "missingMembers": required,
                    "readyToArchive": False,
                    "releaseCredit": False,
                    "reason": "artifact target is not mapped to a local AOSP product_out directory",
                }
            )
            continue
        member_records = []
        for member in required:
            path = source_dir / member
            snapshot = file_snapshot(path)
            member_records.append(
                {
                    "name": member,
                    "path": str(path),
                    "exists": snapshot["exists"],
                    "sizeBytes": snapshot.get("sizeBytes"),
                    "mtimeUtc": snapshot.get("mtimeUtc"),
                }
            )
        present = [row["name"] for row in member_records if row["exists"]]
        missing = [row["name"] for row in member_records if not row["exists"]]
        records.append(
            {
                "artifactId": artifact.get("id"),
                "filename": filename,
                "sourceDirectory": str(source_dir),
                "sourceDirectoryExists": source_dir.is_dir(),
                "requiredMembers": required,
                "presentMembers": present,
                "missingMembers": missing,
                "members": member_records,
                "readyToArchive": not missing,
                "releaseCredit": False,
                "reason": (
                    "source product_out member inventory only; release credit requires a "
                    "staged archive plus matching manifest size/SHA-256 integrity evidence"
                ),
            }
        )
    incomplete = [row["artifactId"] for row in records if not row["readyToArchive"]]
    return {
        "status": "pass" if not incomplete else "blocked",
        "claimBoundary": "local_aosp_archive_source_inventory_only_not_release_archive_integrity_or_runtime_evidence",
        "requiredMembers": list(ANDROID_ARCHIVE_REQUIRED_MEMBERS),
        "incompleteArtifacts": incomplete,
        "records": records,
    }


def android_archive_source_dependency(source_inventory: dict[str, Any]) -> str:
    records = source_inventory.get("records")
    if not isinstance(records, list):
        return "repo_artifact_generation"
    for record in records:
        if not isinstance(record, dict):
            continue
        if record.get("readyToArchive") is False:
            return "actionable_external_dependency"
    return "repo_artifact_generation"


def live_launcher_agent_capture_commands() -> dict[str, Any]:
    release_manifest = repo_rel(ANDROID_MANIFEST)
    evidence_dir = repo_rel(RELEASE_DIR / "evidence/android")
    docs_dir = repo_rel(ROOT / "docs/evidence/android")
    return {
        "claimBoundary": "operator_commands_only_not_collected_runtime_evidence",
        "requiredObservationContract": list(REQUIRED_LAUNCHER_LIVE_OBSERVATIONS),
        "cuttlefishX8664": [
            "export AOSP_ROOT=/home/shaw/aosp",
            "make -C packages/os/android bootanimation",
            'node packages/scripts/distro-android/build-aosp.mjs --brand-config packages/scripts/distro-android/brand.eliza.json --aosp-root "$AOSP_ROOT" --skip-libllama',
            'AOSP_DIR="$AOSP_ROOT" packages/chip/scripts/boot_android_simulator.sh --run-cuttlefish',
            (
                "python3 packages/chip/scripts/android/capture_launcher_runtime_evidence.py "
                "--artifact-id android-cuttlefish-x86_64-zip "
                "--target-label cuttlefish-x86_64 "
                "--expected-cpu-abi x86_64 "
                f"--output {evidence_dir}/cuttlefish-x86_64-launcher-agent-live.json "
                f"--logcat {docs_dir}/cuttlefish-x86_64-launcher-agent-live.logcat.txt "
                f"--transcript {docs_dir}/cuttlefish-x86_64-launcher-agent-live.transcript.log"
            ),
            (
                "python3 packages/chip/scripts/check_android_launcher_runtime_evidence.py "
                "--expected-artifact-id android-cuttlefish-x86_64-zip "
                "--expected-target-label cuttlefish-x86_64 "
                "--expected-cpu-abi x86_64 "
                f"--evidence {evidence_dir}/cuttlefish-x86_64-launcher-agent-live.json"
            ),
        ],
        "pixelArm64": [
            "export ADB_SERIAL=<pixel-adb-or-fastboot-serial>",
            (
                "packages/os/android/installer/install-elizaos-android.sh "
                f'--device "$ADB_SERIAL" --manifest {release_manifest} --execute'
            ),
            (
                "packages/os/android/installer/scripts/validate-post-flash.sh "
                f'--device "$ADB_SERIAL" --manifest {release_manifest} '
                "--launcher-package ai.elizaos.app "
                "--launcher-activity ai.elizaos.app/.MainActivity --execute"
            ),
            (
                "python3 packages/chip/scripts/android/capture_launcher_runtime_evidence.py "
                '--adb-serial "$ADB_SERIAL" '
                "--artifact-id android-pixel-arm64-zip "
                "--target-label pixel-arm64 "
                "--expected-cpu-abi arm64-v8a "
                f"--output {evidence_dir}/pixel-arm64-launcher-agent-live.json "
                f"--logcat {docs_dir}/pixel-arm64-launcher-agent-live.logcat.txt "
                f"--transcript {docs_dir}/pixel-arm64-launcher-agent-live.transcript.log"
            ),
            (
                "python3 packages/chip/scripts/check_android_launcher_runtime_evidence.py "
                "--expected-artifact-id android-pixel-arm64-zip "
                "--expected-target-label pixel-arm64 "
                "--expected-cpu-abi arm64-v8a "
                f"--evidence {evidence_dir}/pixel-arm64-launcher-agent-live.json"
            ),
        ],
        "chipRiscv64": [
            "export AOSP_DIR=/home/shaw/aosp",
            "export CHIP_ANDROID_ADB_HOSTPORT=<chip-emulator-adb-host:port>",
            (
                'AOSP_DIR="$AOSP_DIR" AOSP_PRODUCT=eliza_openagent_ai_soc_phone-trunk_staging-userdebug '
                "packages/chip/scripts/boot_android_simulator.sh --run-cuttlefish"
            ),
            (
                "python3 packages/chip/scripts/android/capture_launcher_runtime_evidence.py "
                '--adb-connect "$CHIP_ANDROID_ADB_HOSTPORT" '
                "--artifact-id android-chip-riscv64-zip "
                "--target-label chip-riscv64 "
                "--expected-cpu-abi riscv64 "
                f"--output {evidence_dir}/chip-riscv64-launcher-agent-live.json "
                f"--logcat {docs_dir}/chip-riscv64-launcher-agent-live.logcat.txt "
                f"--transcript {docs_dir}/chip-riscv64-launcher-agent-live.transcript.log"
            ),
            (
                "python3 packages/chip/scripts/check_android_launcher_runtime_evidence.py "
                "--expected-artifact-id android-chip-riscv64-zip "
                "--expected-target-label chip-riscv64 "
                "--expected-cpu-abi riscv64 "
                f"--evidence {evidence_dir}/chip-riscv64-launcher-agent-live.json"
            ),
        ],
        "releaseCreditRule": (
            "Only copy status=collected launcher-agent-live payloads into the release "
            "manifest after the capture and checker commands pass on the named booted target."
        ),
    }


def prioritized_live_evidence_capture_plan(
    umbrella: dict[str, Any],
) -> list[dict[str, Any]]:
    """Prioritized operator plan for remaining live evidence blockers.

    These rows deliberately carry release_credit=false. They describe how to
    collect evidence; they are not evidence that a target booted or passed.
    """
    commands = live_launcher_agent_capture_commands()
    docs_evidence_dir = repo_rel(ROOT / "docs/evidence/android")
    target_rows: list[dict[str, Any]] = []
    target_priorities = {
        "android-cuttlefish-x86_64-zip": 10,
        "android-pixel-arm64-zip": 20,
        "android-chip-riscv64-zip": 30,
    }
    target_prerequisites = {
        "android-cuttlefish-x86_64-zip": [
            "AOSP_ROOT points at a synced AOSP checkout with Cuttlefish support",
            "cvd/launch_cvd and adb are available on the host",
            "release archive members are staged or build commands are allowed to create them",
        ],
        "android-pixel-arm64-zip": [
            "Pixel arm64 device is connected over adb or fastboot",
            "bootloader/device state allows the installer command to flash the staged release",
            "ADB_SERIAL is set to the Pixel serial",
        ],
        "android-chip-riscv64-zip": [
            "/home/shaw/aosp contains the eliza_ai_soc AOSP workspace",
            "chip riscv64 images exist in out/target/product/eliza_ai_soc or the build lane is allowed to finish them",
            "CHIP_ANDROID_ADB_HOSTPORT is set after the chip Android emulator boots",
        ],
    }
    for artifact in android_artifacts(umbrella):
        artifact_id = str(artifact.get("id", artifact.get("filename", "<unknown>")))
        target_plan = LIVE_LAUNCHER_TARGETS.get(artifact_id)
        if target_plan is None:
            continue
        target_label = str(target_plan["targetLabel"])
        target_key = str(target_plan["targetKey"])
        expected_release_path = str(target_plan["expectedReleaseEvidencePath"])
        target_rows.append(
            {
                "priority": target_priorities.get(artifact_id, 99),
                "capture_area": target_label,
                "artifact_id": artifact_id,
                "release_credit": False,
                "prerequisites": target_prerequisites.get(artifact_id, []),
                "expected_output_files": [
                    expected_release_path,
                    f"{docs_evidence_dir}/{target_label}-launcher-agent-live.logcat.txt",
                    f"{docs_evidence_dir}/{target_label}-launcher-agent-live.transcript.log",
                ],
                "capture_commands": commands.get(target_key, []),
                "validation_commands": [
                    (
                        "python3 packages/chip/scripts/check_android_launcher_runtime_evidence.py "
                        f"--expected-artifact-id {artifact_id} "
                        f"--expected-target-label {target_label} "
                        f"--expected-cpu-abi {target_plan['expectedCpuAbi']} "
                        f"--evidence {repo_rel(RELEASE_DIR / expected_release_path)}"
                    ),
                    "python3 packages/chip/scripts/check_android_release_readiness_contract.py",
                ],
            }
        )

    runtime_rows = [
        {
            "priority": 40,
            "capture_area": "peripherals",
            "release_credit": False,
            "prerequisites": [
                "booted chip riscv64 Android target reachable over adb",
                "CHIP_ANDROID_ADB_HOSTPORT set to the chip emulator adb host:port",
                "simulated peripheral providers are enabled for rear/front camera, Wi-Fi, Bluetooth, and cellular",
            ],
            "expected_output_files": [
                f"{docs_evidence_dir}/peripherals/rear_camera_sim.log",
                f"{docs_evidence_dir}/peripherals/front_camera_sim.log",
                f"{docs_evidence_dir}/peripherals/wifi_sim.log",
                f"{docs_evidence_dir}/peripherals/bluetooth_sim.log",
                f"{docs_evidence_dir}/peripherals/cellular_5g_lte_sim.log",
            ],
            "capture_commands": [
                "export CHIP_ANDROID_ADB_HOSTPORT=<chip-emulator-adb-host:port>",
                (
                    "python3 packages/chip/scripts/android/capture_simulated_peripheral_evidence.py "
                    '--adb-connect "$CHIP_ANDROID_ADB_HOSTPORT" rear_camera'
                ),
                (
                    "python3 packages/chip/scripts/android/capture_simulated_peripheral_evidence.py "
                    '--adb-connect "$CHIP_ANDROID_ADB_HOSTPORT" front_camera'
                ),
                (
                    "python3 packages/chip/scripts/android/capture_simulated_peripheral_evidence.py "
                    '--adb-connect "$CHIP_ANDROID_ADB_HOSTPORT" wifi'
                ),
                (
                    "python3 packages/chip/scripts/android/capture_simulated_peripheral_evidence.py "
                    '--adb-connect "$CHIP_ANDROID_ADB_HOSTPORT" bluetooth'
                ),
                (
                    "python3 packages/chip/scripts/android/capture_simulated_peripheral_evidence.py "
                    '--adb-connect "$CHIP_ANDROID_ADB_HOSTPORT" cellular_5g_lte'
                ),
            ],
            "validation_commands": [
                "python3 packages/chip/scripts/check_android_simulated_peripheral_evidence.py",
                "python3 packages/chip/scripts/check_phone_runtime_readiness_contract.py",
            ],
        },
        {
            "priority": 50,
            "capture_area": "security_lifecycle",
            "release_credit": False,
            "prerequisites": [
                "verified boot policy and production key provisioning are enabled",
                "bench flow can attempt signed, tampered, rollback, and debug-lock/key-provisioning checks",
                "tamper/rollback commands return RESULT=0 only when rejection is observed",
            ],
            "expected_output_files": [
                f"{docs_evidence_dir}/security/verified_boot_acceptance.log",
                f"{docs_evidence_dir}/security/tampered_boot_rejection.log",
                f"{docs_evidence_dir}/security/rollback_rejection.log",
                f"{docs_evidence_dir}/security/debug_lock_key_provisioning.log",
            ],
            "capture_commands": [
                "export CHIP_ANDROID_ADB_HOSTPORT=<chip-emulator-adb-host:port>",
                (
                    'adb connect "$CHIP_ANDROID_ADB_HOSTPORT" && '
                    'state=$(adb -s "$CHIP_ANDROID_ADB_HOSTPORT" shell getprop '
                    "ro.boot.verifiedbootstate | tr -d '\\r') && "
                    'if [ "$state" = green ]; then result=0; verdict=pass; '
                    "else result=1; verdict=fail; fi; "
                    "printf 'VERIFIED_BOOT=%s\\nSTATE=%s\\nRESULT=%s\\n' "
                    f'"$verdict" "$state" "$result" | tee '
                    f"{docs_evidence_dir}/security/verified_boot_acceptance.log; "
                    'test "$result" = 0'
                ),
                (
                    "export ELIZA_TAMPERED_BOOT_REJECTION_COMMAND="
                    "'<lab command that flashes a tampered boot image and returns RESULT=0 only when rejected>'"
                ),
                (
                    'sh -c "$ELIZA_TAMPERED_BOOT_REJECTION_COMMAND" '
                    f"| tee {docs_evidence_dir}/security/tampered_boot_rejection.log"
                ),
                (
                    "export ELIZA_ROLLBACK_REJECTION_COMMAND="
                    "'<lab command that flashes an older rollback-index image and returns RESULT=0 only when rejected>'"
                ),
                (
                    'sh -c "$ELIZA_ROLLBACK_REJECTION_COMMAND" '
                    f"| tee {docs_evidence_dir}/security/rollback_rejection.log"
                ),
                (
                    "export ELIZA_DEBUG_LOCK_KEY_PROVISIONING_COMMAND="
                    "'<lab command that verifies production debug lock and key provisioning>'"
                ),
                (
                    'sh -c "$ELIZA_DEBUG_LOCK_KEY_PROVISIONING_COMMAND" '
                    f"| tee {docs_evidence_dir}/security/debug_lock_key_provisioning.log"
                ),
            ],
            "validation_commands": [
                "python3 packages/chip/scripts/check_security_lifecycle_scope.py",
                "python3 packages/chip/scripts/check_phone_runtime_readiness_contract.py",
            ],
        },
        {
            "priority": 60,
            "capture_area": "power_thermal",
            "release_credit": False,
            "prerequisites": [
                "calibrated VDDCORE/VDDIO power instrumentation is attached",
                "thermal and frequency telemetry are readable while the workload runs",
                "sustained NPU workload is staged on the booted target",
            ],
            "expected_output_files": [
                f"{docs_evidence_dir}/eliza_ai_soc_cvd_hal_processes.txt",
                f"{docs_evidence_dir}/power/sustained_npu_power_thermal_trace.json",
                f"{docs_evidence_dir}/eliza_ai_soc_e1_npu_hal_liveness.log",
            ],
            "capture_commands": [
                "export CHIP_ANDROID_ADB_HOSTPORT=<chip-emulator-adb-host:port>",
                (
                    'adb connect "$CHIP_ANDROID_ADB_HOSTPORT" && '
                    'adb -s "$CHIP_ANDROID_ADB_HOSTPORT" shell ps -A '
                    f"| tee {docs_evidence_dir}/eliza_ai_soc_cvd_hal_processes.txt"
                ),
                (
                    "export ELIZA_CALIBRATED_POWER_THERMAL_CAPTURE_COMMAND="
                    "'<calibrated power harness command that writes the sustained NPU JSON trace>'"
                ),
                (
                    'sh -c "$ELIZA_CALIBRATED_POWER_THERMAL_CAPTURE_COMMAND '
                    f'--output {docs_evidence_dir}/power/sustained_npu_power_thermal_trace.json"'
                ),
                (
                    'adb -s "$CHIP_ANDROID_ADB_HOSTPORT" shell cmd neuralnetworks list '
                    f"| tee {docs_evidence_dir}/eliza_ai_soc_e1_npu_hal_liveness.log"
                ),
            ],
            "validation_commands": [
                "python3 packages/chip/scripts/check_power_thermal_scope.py",
                "python3 packages/chip/scripts/check_phone_runtime_readiness_contract.py",
            ],
        },
    ]
    return sorted(target_rows + runtime_rows, key=lambda row: row["priority"])


def aosp_chip_build_artifact_inventory(
    product_out: Path = AOSP_PRODUCT_OUT,
    build_report: Path = AOSP_BUILD_REPORT,
    build_log: Path = AOSP_BUILD_LOG,
) -> dict[str, Any]:
    records = []
    for name in AOSP_EXPECTED_CHIP_IMAGE_NAMES:
        path = product_out / name
        record: dict[str, Any] = {
            "name": name,
            "path": str(path),
            "exists": path.is_file(),
            "required_for_bootable_chip_archive": True,
        }
        if path.is_file():
            stat = path.stat()
            record["sizeBytes"] = stat.st_size
            record["mtimeUtc"] = (
                datetime.fromtimestamp(stat.st_mtime, UTC)
                .replace(microsecond=0)
                .isoformat()
                .replace("+00:00", "Z")
            )
        records.append(record)
    present = [record["name"] for record in records if record["exists"]]
    missing = [record["name"] for record in records if not record["exists"]]
    backup_candidates = []
    for path in sorted(product_out.glob("*.img.bak*")) if product_out.exists() else []:
        backup_candidates.append(
            {
                **file_snapshot(path),
                "releaseCredit": False,
                "reason": "backup or workaround image is not an expected bootable chip archive member",
            }
        )
    build_report_snapshot = file_snapshot(build_report)
    report_mtime = build_report.stat().st_mtime if build_report.exists() else 0
    log_mtime = build_log.stat().st_mtime if build_log.exists() else 0
    build_report_payload = read_json_or_empty(build_report)
    build_log_progress = aosp_build_log_progress(build_log)
    report_artifacts = build_report_payload.get("artifacts")
    report_artifact_cross_check: dict[str, Any] = {}
    if isinstance(report_artifacts, dict):
        report_artifact_cross_check = {
            "system_img_sha256": report_artifacts.get("system_img_sha256"),
            "vendor_img_sha256": report_artifacts.get("vendor_img_sha256"),
            "boot_img_sha256": report_artifacts.get("boot_img_sha256"),
            "releaseCredit": False,
            "reason": (
                "build report is diagnostic metadata only; every image must exist at "
                "product_out with fresh size and SHA-256 before release staging"
            ),
        }
    latest_build_attempt = {
        "buildReport": build_report_payload,
        "buildReportFile": build_report_snapshot,
        "buildLogProgress": build_log_progress,
        "buildReportStaleComparedToLog": bool(build_log.exists() and log_mtime > report_mtime),
        "buildReportCredit": bool(build_report.exists() and report_mtime >= log_mtime),
        "staleBuildReportReason": (
            "build log is newer than eliza-build-report.json; trust current product_out "
            "image inventory over the stale report payload"
            if build_log.exists() and log_mtime > report_mtime
            else ""
        ),
        "buildReportArtifactCrossCheck": report_artifact_cross_check,
        "activeBuildProcesses": active_aosp_build_processes(),
        "imageOnlyResumeEvidence": aosp_image_only_resume_inventory(),
        "generationCommands": {
            "boundedBuildOnlyEvidence": AOSP_BUILD_ONLY_COMMAND,
            "directIncrementalBuild": AOSP_DIRECT_BUILD_COMMAND,
            "imageOnlyResumeFromCurrentTree": AOSP_IMAGE_ONLY_BUILD_COMMAND,
            "requiredImageTargets": list(AOSP_IMAGE_BUILD_TARGETS),
        },
    }
    return {
        "status": "complete" if not missing else ("partial" if present else "missing"),
        "productOut": str(product_out),
        "present": present,
        "missing": missing,
        "records": records,
        "nonReleaseImageCandidates": backup_candidates,
        "partialProductTrees": aosp_partial_tree_snapshots(product_out),
        "buildOnlyEvidence": aosp_build_only_evidence_inventory(),
        "latestBuildAttempt": latest_build_attempt,
        "blocker_dependency": "repo_artifact_generation" if missing else "",
        "next_step": (
            "Complete the eliza_ai_soc AOSP build so the chip archive can include "
            "vendor.img, system.img, product.img, and system_ext.img."
            if missing
            else "Stage these images into the chip riscv64 Android release archive."
        ),
    }


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


def manifest_launcher_packages(manifest: dict[str, Any]) -> dict[str, str]:
    validation = manifest.get("validation", {})
    if not isinstance(validation, dict):
        return {}
    properties = validation.get("properties", {})
    launcher_agent_checks = validation.get("launcherAgentChecks", {})
    found: dict[str, str] = {}
    if isinstance(properties, dict):
        for key in ("home_role", "foreground_activity"):
            value = properties.get(key)
            if isinstance(value, str) and value:
                found[f"validation.properties.{key}"] = value
    if isinstance(launcher_agent_checks, dict):
        for key in ("launcherPackage", "launcherActivity"):
            value = launcher_agent_checks.get(key)
            if isinstance(value, str) and value:
                found[f"validation.launcherAgentChecks.{key}"] = value
    return found


def package_expectation_mismatches(values: dict[str, str], expected_package: str) -> list[str]:
    mismatches: list[str] = []
    for key, value in values.items():
        if expected_package not in value:
            mismatches.append(f"{key}={value!r}")
    return mismatches


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
    umbrella_missing_required_evidence_rows = [
        row_label
        for artifact in android_release_artifacts
        for row_label in missing_required_android_evidence_rows(artifact)
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
    umbrella_invalid_artifact_integrity_payloads = [
        row_label
        for artifact in android_release_artifacts
        for row_label in invalid_artifact_integrity_payloads(artifact)
    ]
    android_partition_invalid_artifact_integrity_payloads = (
        invalid_partition_artifact_integrity_payloads(android_manifest)
    )
    umbrella_invalid_launcher_agent_payloads = [
        row_label
        for artifact in android_release_artifacts
        for row_label in invalid_launcher_agent_payloads(artifact)
    ]
    host_symlink_findings = host_symlink_runtime_findings()
    umbrella_targets = [target_values(artifact) for artifact in android_release_artifacts]
    manifest_missing_validation = missing_manifest_validation_markers(android_manifest)
    expected_package = expected_android_payload_package()
    launcher_packages = manifest_launcher_packages(android_manifest)
    launcher_package_mismatches = package_expectation_mismatches(
        launcher_packages, expected_package
    )
    post_flash_missing = missing_script_markers(post_flash_text)
    installer_missing = missing_script_markers(installer_text)
    artifact_inventory = android_release_artifact_inventory(android_manifest, umbrella_manifest)
    staged_archive_integrity_inventory = staged_android_archive_integrity_inventory(
        umbrella_manifest
    )
    chip_archive_staged_with_integrity = staged_chip_riscv64_archive_has_release_integrity(
        staged_archive_integrity_inventory
    )
    archive_source_inventory = android_archive_source_member_inventory(umbrella_manifest)
    archive_source_dependency = android_archive_source_dependency(archive_source_inventory)
    live_launcher_missing_inventory = live_launcher_agent_missing_evidence(umbrella_manifest)
    aosp_chip_inventory = aosp_chip_build_artifact_inventory()

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
        "live_device_validation",
    )
    add_if(
        findings,
        bool(launcher_package_mismatches),
        "android_release_manifest_launcher_package_mismatch",
        "Android release manifest launcher validation package does not match the staged system APK payload",
        f"expected_package={expected_package!r} mismatches={launcher_package_mismatches} payload_report={repo_rel(ANDROID_APK_PAYLOAD_REPORT)}",
        "Regenerate the Android release manifest from the current staged APK payload before release promotion.",
    )
    add_if(
        findings,
        bool(post_flash_missing),
        "post_flash_validator_missing_launcher_agent_checks",
        "post-flash validator does not prove launcher foreground state and agent health",
        f"missing={post_flash_missing} script={rel(POST_FLASH)}",
        "Extend validate-post-flash.sh to check pm path, role holders, HOME resolution, foreground activity, service PID, health, and logs.",
        "live_device_validation",
    )
    add_if(
        findings,
        bool(installer_missing),
        "installer_reboot_validation_missing_launcher_agent_checks",
        "installer reboot validation stops at boot properties",
        f"missing={installer_missing} script={rel(INSTALLER)}",
        "Make installer post-reboot validation call the full launcher/agent validation contract.",
        "live_device_validation",
    )
    add_if(
        findings,
        bool(umbrella_missing_hashes) or bool(umbrella_missing_sizes),
        "umbrella_android_artifacts_missing_integrity",
        "umbrella release manifest Android artifacts lack hash or size metadata",
        f"missing_hashes={umbrella_missing_hashes} missing_sizes={umbrella_missing_sizes}",
        "Populate hash and size fields only from staged Android archives built from complete target product_out directories.",
        archive_source_dependency,
    )
    add_if(
        findings,
        artifact_inventory["status"] != "pass",
        "android_release_artifacts_missing_from_expected_paths",
        "Android release artifacts are absent from the expected publish staging paths",
        f"missing={artifact_inventory['missing']}",
        "Build and stage the exact partition images and Android archives listed in evidence.android_release_artifact_inventory.commands, then populate real byte sizes and SHA-256 values.",
        archive_source_dependency,
    )
    add_if(
        findings,
        aosp_chip_inventory["status"] != "complete" and not chip_archive_staged_with_integrity,
        "android_chip_riscv64_aosp_artifacts_incomplete",
        "AOSP chip/riscv64 build output is incomplete before release archive staging",
        f"present={aosp_chip_inventory['present']} missing={aosp_chip_inventory['missing']} product_out={aosp_chip_inventory['productOut']}",
        "Finish the eliza_ai_soc AOSP build-only lane, then stage the complete image set into the Android release archive.",
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
        bool(umbrella_missing_required_evidence_rows),
        "umbrella_android_artifacts_missing_required_evidence_rows",
        "umbrella release manifest Android artifacts do not declare both integrity and live launcher/agent evidence rows",
        f"rows={umbrella_missing_required_evidence_rows}",
        "For every Android artifact, add a collected *-artifact-integrity row and a collected *-launcher-agent-live row before promotion.",
        "live_device_validation",
    )
    add_if(
        findings,
        bool(umbrella_missing_evidence_files),
        "umbrella_android_artifacts_evidence_files_missing",
        "umbrella release manifest Android artifact evidence rows point at files that do not exist",
        f"rows={umbrella_missing_evidence_files}",
        "Create explicit fail-closed missing-evidence records or collect the real evidence before promotion.",
        "live_device_validation",
    )
    add_if(
        findings,
        bool(umbrella_unresolved_evidence_payloads),
        "umbrella_android_artifacts_evidence_payloads_unresolved",
        "umbrella release manifest Android artifact evidence files are not collected/pass payloads",
        f"rows={umbrella_unresolved_evidence_payloads}",
        "Replace fail-closed placeholder evidence payloads with real collected/pass evidence before promotion.",
        "live_device_validation",
    )
    add_if(
        findings,
        bool(umbrella_invalid_artifact_integrity_payloads),
        "umbrella_android_artifacts_integrity_payload_mismatch",
        "umbrella Android artifact integrity evidence payloads do not match manifest artifact identity, filename, size, and SHA-256",
        f"rows={umbrella_invalid_artifact_integrity_payloads}",
        "Regenerate artifact-integrity evidence from the final release archives and copy the exact filename, sizeBytes, and sha256 into the umbrella manifest.",
        "live_device_validation",
    )
    add_if(
        findings,
        bool(staged_archive_integrity_inventory["mismatches"]),
        "staged_android_archive_integrity_mismatch",
        "staged Android release archives do not match manifest/evidence size, SHA-256, or required zip members",
        f"mismatches={staged_archive_integrity_inventory['mismatches']}",
        "Regenerate the staged archive from product_out, recompute SHA-256 and byte size from the staged zip, and update the manifest plus integrity evidence from that exact file.",
    )
    add_if(
        findings,
        bool(android_partition_invalid_artifact_integrity_payloads),
        "android_partition_artifacts_integrity_payload_mismatch",
        "Android partition artifact integrity evidence does not match manifest partition identity, size, and SHA-256 values",
        f"rows={android_partition_invalid_artifact_integrity_payloads}",
        "Regenerate android-release-manifest artifact integrity evidence from the final staged partition images with validate-release-manifest.mjs --artifact-dir.",
    )
    add_if(
        findings,
        bool(umbrella_invalid_launcher_agent_payloads),
        "umbrella_android_artifacts_launcher_agent_payload_invalid",
        "umbrella Android launcher/agent live evidence payloads do not prove booted launcher foreground state and agent health",
        f"rows={umbrella_invalid_launcher_agent_payloads}",
        "Run the target-specific command sequence in evidence.live_launcher_agent_capture_commands and keep rows missing until the booted target proves sys.boot_completed=1, installed launcher package, HOME/foreground state, running service, ready /api/health, and clean fatal/SELinux log scans.",
        "live_device_validation",
    )
    add_if(
        findings,
        live_launcher_missing_inventory["status"] != "pass",
        "android_live_launcher_agent_evidence_missing_by_target",
        "Android release targets are missing collected live launcher/agent evidence",
        f"missing_targets={live_launcher_missing_inventory['missingTargets']}",
        "Run the per-target command lists in evidence.live_launcher_agent_missing_evidence.records[*].collectionCommands, then update each manifest evidence row only with collected payloads from the named booted target.",
        "live_device_validation",
    )
    add_if(
        findings,
        bool(umbrella_uncollected_evidence),
        "umbrella_android_artifacts_evidence_not_collected",
        "umbrella release manifest Android artifacts have fail-closed validation rows that are not collected",
        f"artifacts={umbrella_uncollected_evidence}",
        "Collect boot, role, launcher foreground, agent health, fatal log, and SELinux evidence before promoting any Android artifact.",
        "live_device_validation",
    )
    add_if(
        findings,
        bool(host_symlink_findings),
        "android_runtime_evidence_contains_host_symlinked_system_inputs",
        "Android runtime evidence shows system permission inputs were baked as host-local symlinks",
        f"findings={host_symlink_findings}",
        "Rebuild the AOSP image with materialized device/vendor overlays, then recapture launcher and system-bridge runtime evidence before release promotion.",
        "live_device_validation",
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
        "android_manifest": repo_rel(ANDROID_MANIFEST),
        "umbrella_manifest": rel(UMBRELLA_MANIFEST),
        "android_partition_artifact_count": len(artifacts),
        "umbrella_android_artifact_count": len(android_release_artifacts),
        "android_release_targets": [sorted(values) for values in umbrella_targets],
        "android_partition_artifact_integrity": android_manifest.get("validation", {}).get(
            "artifactIntegrity", {}
        ),
        "release_directory": repo_rel(RELEASE_DIR),
        "post_flash_validator": rel(POST_FLASH),
        "installer": rel(INSTALLER),
        "expected_android_package": expected_package,
        "android_apk_payload_report": repo_rel(ANDROID_APK_PAYLOAD_REPORT),
        "launcher_package_validation_values": launcher_packages,
        "runtime_host_symlink_findings": host_symlink_findings,
        "android_release_artifact_inventory": artifact_inventory,
        "staged_android_archive_integrity_inventory": staged_archive_integrity_inventory,
        "chip_riscv64_archive_staged_with_integrity": chip_archive_staged_with_integrity,
        "android_archive_source_member_inventory": archive_source_inventory,
        "aosp_chip_build_artifact_inventory": aosp_chip_inventory,
        "live_launcher_agent_capture_commands": live_launcher_agent_capture_commands(),
        "live_launcher_agent_missing_evidence": live_launcher_missing_inventory,
        "prioritized_live_evidence_capture_plan": prioritized_live_evidence_capture_plan(
            umbrella_manifest
        ),
    }
    return payload(findings, evidence)


def payload(findings: list[Finding], evidence: dict[str, object]) -> dict[str, Any]:
    blockers = [finding for finding in findings if finding.severity == "blocker"]
    blocker_rows = [asdict(finding) for finding in blockers]
    dependency_counts: dict[str, int] = {}
    for finding in blockers:
        dependency_counts[finding.blocker_dependency] = (
            dependency_counts.get(finding.blocker_dependency, 0) + 1
        )
    return {
        "schema": SCHEMA,
        "status": "pass" if not blockers else "blocked",
        "claim_boundary": CLAIM_BOUNDARY,
        "summary": {"blockers": len(blockers), "findings": len(findings)},
        "blockers": blocker_rows,
        "blocker_dependency_counts": dependency_counts,
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
