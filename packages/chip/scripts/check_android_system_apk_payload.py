#!/usr/bin/env python3
"""Check the staged Android system APK carries the E1/AOSP agent payload.

This is a static package inspection only. It proves the prebuilt APK contains
the expected local-agent runtime files, riscv64 payload entries, model-free
llama.cpp diagnostic script, and build provenance. It does not prove Android
boot, launcher foreground state, service liveness, or GUI emulator behavior.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import zipfile
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = ROOT.parent
ELIZA_ROOT = ROOT.parents[1]
OUTER_WORKSPACE = ROOT.parents[2] if len(ROOT.parents) > 2 else ELIZA_ROOT


def resolve_default_apk() -> Path:
    upstream_apk = WORKSPACE / "os/android/vendor/eliza/apps/Eliza/Eliza.apk"
    outer_app_config = OUTER_WORKSPACE / "apps/app/app.config.ts"
    outer_vendor_root = OUTER_WORKSPACE / "os/android/vendor"
    if outer_app_config.is_file() and outer_vendor_root.is_dir():
        config = outer_app_config.read_text(encoding="utf-8")
        vendor_match = re.search(r"\bvendorDir\s*:\s*[\"']([^\"']+)[\"']", config)
        app_match = re.search(r"\bappName\s*:\s*[\"']([^\"']+)[\"']", config)
        if vendor_match and app_match:
            branded_apk = (
                outer_vendor_root
                / vendor_match.group(1)
                / "apps"
                / app_match.group(1)
                / f"{app_match.group(1)}.apk"
            )
            if branded_apk.is_file():
                return branded_apk
        candidates = sorted(outer_vendor_root.glob("*/apps/*/*.apk"))
        if len(candidates) == 1:
            return candidates[0]
    return upstream_apk


DEFAULT_APK = resolve_default_apk()
VENDOR_COMMON_MK = WORKSPACE / "os/android/vendor/eliza/eliza_common.mk"
REPORT = ROOT / "build/reports/android_system_apk_payload.json"

SCHEMA = "eliza.android_system_apk_payload.v1"
CLAIM_BOUNDARY = "staged_aosp_apk_payload_static_check_only_not_runtime_evidence"
AOSP_PROVENANCE_SCHEMA = "eliza.aosp_build_provenance.v1"
RUNTIME_PROVENANCE_SCHEMA = "eliza.android_agent_runtime_provenance.v1"
AOSP_PROVENANCE_CLAIM_BOUNDARY = (
    "apk_packaging_provenance_only_not_aosp_boot_or_gui_runtime_evidence"
)
RUNTIME_PROVENANCE_CLAIM_BOUNDARY = (
    "apk_staged_runtime_file_hashes_only_not_android_boot_or_runtime_execution_evidence"
)
PROVENANCE_ENTRY = "META-INF/eliza/aosp-build-provenance.json"
RUNTIME_PROVENANCE_ENTRY = "assets/agent/android-agent-runtime-provenance.json"
COMMON_REQUIRED_ENTRIES = (
    "AndroidManifest.xml",
    "assets/agent/agent-bundle.js",
    "assets/agent/launch.sh",
    "assets/agent/llama-kernel-diagnostic.mjs",
)
RISCV_AGENT_RUNTIME_ENTRIES = (
    "assets/agent/riscv64/bun",
    "assets/agent/riscv64/ld-musl-riscv64.so.1",
    "assets/agent/riscv64/libstdc++.so.6.0.33",
    "assets/agent/riscv64/libgcc_s.so.1",
)
RISCV_NATIVE_LIB_ENTRIES = (
    "lib/riscv64/libeliza_bun.so",
    "lib/riscv64/libeliza_gcc_s.so",
    "lib/riscv64/libeliza_ld_musl_riscv64.so",
    "lib/riscv64/libeliza_stdcpp.so",
)
REQUIRED_ENTRIES = COMMON_REQUIRED_ENTRIES + RISCV_AGENT_RUNTIME_ENTRIES + RISCV_NATIVE_LIB_ENTRIES
RISCV64_RUNTIME_BUILD_COMMANDS = (
    "BUN_RISCV64_FORCE_CLOOP=1 packages/app-core/scripts/bun-riscv64/run-build.sh",
    "test -f packages/app-core/scripts/bun-riscv64/dist/bun-linux-riscv64-musl.zip",
    "export ELIZA_BUN_RISCV64_FILE=packages/app-core/scripts/bun-riscv64/dist/bun-linux-riscv64-musl.zip",
    "export ELIZA_BUN_RISCV64_SHA256=$(sha256sum \"$ELIZA_BUN_RISCV64_FILE\" | awk '{print $1}')",
    "node --test packages/app-core/scripts/stage-android-agent.test.mjs",
    "bun run build:android:system",
    "python3 packages/chip/scripts/check_android_system_apk_payload.py --allow-missing-aapt",
)
RISCV64_RUNTIME_PROVENANCE_REQUIREMENTS = (
    f"{RUNTIME_PROVENANCE_ENTRY} must use schema eliza.android_agent_runtime_provenance.v1",
    "riscv64_bun_artifact.required must be true",
    "riscv64_bun_artifact.source must identify the local file or URL used",
    "riscv64_bun_artifact.sha256 must equal the staged Bun zip SHA-256",
    "files[] must enumerate every assets/agent/riscv64 and lib/riscv64 entry with size_bytes and sha256",
    f"{PROVENANCE_ENTRY}.runtime_provenance_sha256 must equal the APK asset provenance SHA-256",
)


def riscv64_runtime_remediation() -> str:
    commands = " && ".join(RISCV64_RUNTIME_BUILD_COMMANDS)
    requirements = "; ".join(RISCV64_RUNTIME_PROVENANCE_REQUIREMENTS)
    return f"Run: {commands}. Provenance requirements: {requirements}."


@dataclass(frozen=True)
class Finding:
    code: str
    severity: str
    message: str
    evidence: str
    next_step: str


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


def read_zip_entries(apk: Path) -> set[str]:
    with zipfile.ZipFile(apk) as zf:
        return set(zf.namelist())


def duplicate_zip_entries(apk: Path, critical_entries: Iterable[str]) -> list[str]:
    critical = set(critical_entries)
    counts: dict[str, int] = {}
    with zipfile.ZipFile(apk) as zf:
        for info in zf.infolist():
            if info.filename in critical:
                counts[info.filename] = counts.get(info.filename, 0) + 1
    return sorted(entry for entry, count in counts.items() if count > 1)


def package_name_from_apk(apk: Path) -> tuple[str | None, str]:
    aapt = shutil.which("aapt")
    if aapt:
        package_name = package_name_from_aapt(apk, aapt)
        if package_name:
            return package_name, aapt
    apkanalyzer = shutil.which("apkanalyzer") or str(
        Path.home() / "Android/Sdk/cmdline-tools/latest/bin/apkanalyzer"
    )
    if apkanalyzer and Path(apkanalyzer).is_file():
        completed = subprocess.run(
            [apkanalyzer, "manifest", "application-id", str(apk)],
            check=False,
            capture_output=True,
            text=True,
        )
        if completed.returncode == 0 and completed.stdout.strip():
            return completed.stdout.strip(), apkanalyzer
    return None, "aapt/apkanalyzer not found or failed"


def package_name_from_aapt(apk: Path, aapt: str) -> str | None:
    completed = subprocess.run(
        [aapt, "dump", "badging", str(apk)],
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        return None
    for line in completed.stdout.splitlines():
        if line.startswith("package:"):
            for part in line.split():
                if part.startswith("name="):
                    return part.split("=", 1)[1].strip("'\"")
    return None


def read_zip_json(apk: Path, entry: str) -> dict[str, Any]:
    try:
        with zipfile.ZipFile(apk) as zf, zf.open(entry) as fp:
            value = json.loads(fp.read().decode("utf-8"))
    except (KeyError, json.JSONDecodeError, UnicodeDecodeError, zipfile.BadZipFile):
        return {}
    return value if isinstance(value, dict) else {}


def read_zip_bytes(apk: Path, entry: str) -> bytes:
    try:
        with zipfile.ZipFile(apk) as zf:
            return zf.read(entry)
    except (KeyError, zipfile.BadZipFile):
        return b""


def runtime_file_integrity_mismatches(apk: Path, runtime_provenance: dict[str, Any]) -> list[str]:
    files = runtime_provenance.get("files", [])
    if not isinstance(files, list):
        return []
    mismatches: list[str] = []
    for item in files:
        if not isinstance(item, dict):
            continue
        entry = item.get("path")
        if not isinstance(entry, str) or not entry:
            continue
        data = read_zip_bytes(apk, entry)
        if not data:
            continue
        recorded_size = item.get("size_bytes")
        if isinstance(recorded_size, int) and recorded_size != len(data):
            mismatches.append(f"{entry}: size_bytes recorded={recorded_size} actual={len(data)}")
        recorded_sha256 = item.get("sha256")
        if isinstance(recorded_sha256, str) and recorded_sha256.lower() != sha256_bytes(data):
            mismatches.append(f"{entry}: sha256 does not match APK entry bytes")
    return mismatches


def runtime_file_metadata_failures(runtime_provenance: dict[str, Any]) -> list[str]:
    files = runtime_provenance.get("files", [])
    if not isinstance(files, list):
        return ["files: must be a list"]
    rows: dict[str, dict[str, Any]] = {}
    for item in files:
        if not isinstance(item, dict):
            continue
        path = item.get("path")
        if isinstance(path, str) and path:
            rows[path] = item

    failures: list[str] = []
    for entry in RISCV_AGENT_RUNTIME_ENTRIES + RISCV_NATIVE_LIB_ENTRIES:
        row = rows.get(entry)
        if row is None:
            failures.append(f"{entry}: missing files[] row")
            continue
        size = row.get("size_bytes")
        if not isinstance(size, int) or size <= 0:
            failures.append(f"{entry}: size_bytes must be a positive integer")
        sha256 = row.get("sha256")
        if not isinstance(sha256, str) or not re.fullmatch(r"[a-f0-9]{64}", sha256):
            failures.append(f"{entry}: sha256 must be 64 lowercase hex characters")
    return failures


def sha256_bytes(data: bytes) -> str:
    import hashlib

    return hashlib.sha256(data).hexdigest()


def host_local_paths(value: Any, prefix: str = "$") -> list[str]:
    paths: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            paths.extend(host_local_paths(child, f"{prefix}.{key}"))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            paths.extend(host_local_paths(child, f"{prefix}[{index}]"))
    elif isinstance(value, str) and value.startswith(("/home/", "/tmp/", "/Users/")):
        paths.append(f"{prefix}={value!r}")
    return paths


def vendor_common_mk_for_apk(apk: Path) -> Path:
    parts = apk.parts
    if "vendor" in parts and "apps" in parts:
        vendor_index = max(index for index, part in enumerate(parts) if part == "vendor")
        if vendor_index + 1 < len(parts):
            vendor_dir = Path(*parts[: vendor_index + 2])
            matches = sorted(vendor_dir.glob("*_common.mk"))
            if matches:
                return matches[0]
    return VENDOR_COMMON_MK


def vendor_home_package(apk: Path) -> str | None:
    common_mk = vendor_common_mk_for_apk(apk)
    if not common_mk.is_file():
        return None
    text = common_mk.read_text(encoding="utf-8")
    match = re.search(r"\bro\.elizaos\.home=([A-Za-z0-9_.]+)", text)
    if not match:
        match = re.search(r"\bro\.[A-Za-z0-9_.]+\.home=([A-Za-z0-9_.]+)", text)
    match = re.search(
        r"\bro\.elizaos\.home=([A-Za-z0-9_.]+)", VENDOR_COMMON_MK.read_text(encoding="utf-8")
    )
    return match.group(1) if match else None


def run_check(args: argparse.Namespace) -> dict[str, Any]:
    apk = Path(args.apk).resolve()
    findings: list[Finding] = []
    add_if(
        findings,
        not apk.is_file(),
        "apk_missing",
        "staged Android system APK is missing",
        rel(apk),
        "Build the android-system target and stage Eliza.apk before claiming AOSP APK readiness.",
    )
    if findings:
        return payload(findings, {"apk": rel(apk)})

    entries = read_zip_entries(apk)
    critical_entries = REQUIRED_ENTRIES + (PROVENANCE_ENTRY, RUNTIME_PROVENANCE_ENTRY)
    duplicate_critical_entries = duplicate_zip_entries(apk, critical_entries)
    missing_common = [entry for entry in COMMON_REQUIRED_ENTRIES if entry not in entries]
    missing_riscv_agent = [entry for entry in RISCV_AGENT_RUNTIME_ENTRIES if entry not in entries]
    missing_riscv_libs = [entry for entry in RISCV_NATIVE_LIB_ENTRIES if entry not in entries]
    missing = missing_common + missing_riscv_agent + missing_riscv_libs
    riscv_assets = sorted(entry for entry in entries if entry.startswith("assets/agent/riscv64/"))
    riscv_libs = sorted(entry for entry in entries if entry.startswith("lib/riscv64/"))
    provenance = read_zip_json(apk, PROVENANCE_ENTRY) if PROVENANCE_ENTRY in entries else {}
    runtime_provenance = (
        read_zip_json(apk, RUNTIME_PROVENANCE_ENTRY) if RUNTIME_PROVENANCE_ENTRY in entries else {}
    )
    runtime_provenance_bytes = read_zip_bytes(apk, RUNTIME_PROVENANCE_ENTRY)
    runtime_provenance_sha256 = (
        sha256_bytes(runtime_provenance_bytes) if runtime_provenance_bytes else None
    )
    provenance_package = provenance.get("android_package")
    vendor_package = vendor_home_package(apk)
    expected_package = vendor_package or provenance_package
    if args.allow_missing_aapt:
        package_name, package_source = None, "package metadata skipped by --allow-missing-aapt"
    else:
        package_name, package_source = package_name_from_apk(apk)
    package_values = {
        str(value)
        for value in (package_name, provenance_package, vendor_package)
        if isinstance(value, str) and value
    }

    add_if(
        findings,
        bool(missing_common),
        "missing_common_apk_payload_entries",
        "staged APK lacks required common local-agent payload entries",
        ", ".join(missing_common),
        riscv64_runtime_remediation(),
    )
    add_if(
        findings,
        bool(missing_riscv_agent),
        "missing_riscv64_agent_runtime_entries",
        "staged APK lacks required assets/agent/riscv64 runtime entries",
        ", ".join(missing_riscv_agent),
        riscv64_runtime_remediation(),
    )
    add_if(
        findings,
        bool(missing_riscv_libs),
        "missing_riscv64_native_loader_entries",
        "staged APK lacks required lib/riscv64 native loader entries",
        ", ".join(missing_riscv_libs),
        riscv64_runtime_remediation(),
    )
    add_if(
        findings,
        PROVENANCE_ENTRY not in entries,
        "aosp_build_provenance_missing",
        "staged APK lacks machine-readable AOSP build provenance",
        PROVENANCE_ENTRY,
        "Embed META-INF/eliza/aosp-build-provenance.json during Android system APK staging.",
    )
    add_if(
        findings,
        PROVENANCE_ENTRY in entries and provenance.get("schema") != AOSP_PROVENANCE_SCHEMA,
        "aosp_build_provenance_schema_mismatch",
        "staged APK AOSP build provenance has the wrong schema",
        f"schema={provenance.get('schema')!r}",
        "Regenerate META-INF/eliza/aosp-build-provenance.json with the current Android system build staging script.",
    )
    add_if(
        findings,
        PROVENANCE_ENTRY in entries
        and provenance.get("claim_boundary") != AOSP_PROVENANCE_CLAIM_BOUNDARY,
        "aosp_build_provenance_claim_boundary_mismatch",
        "staged APK AOSP build provenance has the wrong claim boundary",
        f"expected={AOSP_PROVENANCE_CLAIM_BOUNDARY!r} recorded={provenance.get('claim_boundary')!r}",
        "Regenerate META-INF/eliza/aosp-build-provenance.json with the current Android system build staging script.",
    )
    add_if(
        findings,
        PROVENANCE_ENTRY in entries and provenance.get("apk_name") != apk.name,
        "aosp_build_provenance_apk_name_mismatch",
        "staged APK AOSP build provenance names a different APK artifact",
        f"expected={apk.name!r} recorded={provenance.get('apk_name')!r}",
        "Regenerate AOSP build provenance after copying the exact APK promoted into vendor/eliza/apps/Eliza/.",
    )
    add_if(
        findings,
        RUNTIME_PROVENANCE_ENTRY not in entries,
        "runtime_provenance_missing",
        "staged APK lacks machine-readable runtime payload provenance",
        RUNTIME_PROVENANCE_ENTRY,
        riscv64_runtime_remediation(),
    )
    add_if(
        findings,
        RUNTIME_PROVENANCE_ENTRY in entries
        and runtime_provenance.get("schema") != RUNTIME_PROVENANCE_SCHEMA,
        "runtime_provenance_schema_mismatch",
        "runtime payload provenance has the wrong schema",
        f"schema={runtime_provenance.get('schema')!r}",
        "Regenerate the APK with the current stage-android-agent.mjs provenance writer.",
    )
    add_if(
        findings,
        RUNTIME_PROVENANCE_ENTRY in entries
        and runtime_provenance.get("claim_boundary") != RUNTIME_PROVENANCE_CLAIM_BOUNDARY,
        "runtime_provenance_claim_boundary_mismatch",
        "runtime payload provenance has the wrong claim boundary",
        f"expected={RUNTIME_PROVENANCE_CLAIM_BOUNDARY!r} recorded={runtime_provenance.get('claim_boundary')!r}",
        "Regenerate the APK with the current stage-android-agent.mjs provenance writer.",
    )
    runtime_file_paths = {
        file.get("path") for file in runtime_provenance.get("files", []) if isinstance(file, dict)
    }
    add_if(
        findings,
        RUNTIME_PROVENANCE_ENTRY in entries
        and not set(RISCV_AGENT_RUNTIME_ENTRIES).issubset(runtime_file_paths),
        "runtime_provenance_missing_riscv64_entries",
        "runtime provenance does not enumerate the required riscv64 runtime files",
        ", ".join(sorted(set(RISCV_AGENT_RUNTIME_ENTRIES) - runtime_file_paths)),
        riscv64_runtime_remediation(),
    )
    add_if(
        findings,
        RUNTIME_PROVENANCE_ENTRY in entries
        and not set(RISCV_NATIVE_LIB_ENTRIES).issubset(runtime_file_paths),
        "runtime_provenance_missing_riscv64_native_entries",
        "runtime provenance does not enumerate the required riscv64 native loader files",
        ", ".join(sorted(set(RISCV_NATIVE_LIB_ENTRIES) - runtime_file_paths)),
        riscv64_runtime_remediation(),
    )
    runtime_integrity_mismatches = runtime_file_integrity_mismatches(apk, runtime_provenance)
    add_if(
        findings,
        bool(runtime_integrity_mismatches),
        "runtime_provenance_file_integrity_mismatch",
        "runtime provenance file sizes or SHA-256 values do not match the embedded APK entries",
        "; ".join(runtime_integrity_mismatches[:8]),
        "Regenerate runtime provenance from the exact APK-staged riscv64 runtime files.",
    )
    runtime_metadata_failures = runtime_file_metadata_failures(runtime_provenance)
    add_if(
        findings,
        RUNTIME_PROVENANCE_ENTRY in entries and bool(runtime_metadata_failures),
        "runtime_provenance_file_metadata_incomplete",
        "runtime provenance does not record complete size and SHA-256 metadata for required riscv64 files",
        "; ".join(runtime_metadata_failures[:8]),
        riscv64_runtime_remediation(),
    )
    runtime_artifact = runtime_provenance.get("riscv64_bun_artifact", {})
    add_if(
        findings,
        RUNTIME_PROVENANCE_ENTRY in entries
        and not (
            isinstance(runtime_artifact, dict)
            and runtime_artifact.get("required") is True
            and isinstance(runtime_artifact.get("sha256"), str)
            and re.fullmatch(r"[a-f0-9]{64}", runtime_artifact["sha256"])
            and isinstance(runtime_artifact.get("source"), dict)
        ),
        "runtime_provenance_missing_riscv64_bun_artifact",
        "runtime provenance does not pin the real riscv64 Bun artifact source and SHA-256",
        json.dumps(runtime_artifact, sort_keys=True),
        riscv64_runtime_remediation(),
    )
    embedded_runtime = provenance.get("runtime_provenance")
    add_if(
        findings,
        PROVENANCE_ENTRY in entries
        and RUNTIME_PROVENANCE_ENTRY in entries
        and provenance.get("runtime_provenance_sha256") != runtime_provenance_sha256,
        "aosp_build_runtime_provenance_sha_mismatch",
        "AOSP build provenance does not match the embedded runtime provenance entry",
        f"expected={runtime_provenance_sha256!r} recorded={provenance.get('runtime_provenance_sha256')!r}",
        "Regenerate META-INF/eliza/aosp-build-provenance.json after staging runtime provenance.",
    )
    add_if(
        findings,
        PROVENANCE_ENTRY in entries
        and RUNTIME_PROVENANCE_ENTRY in entries
        and isinstance(embedded_runtime, dict)
        and embedded_runtime != runtime_provenance,
        "aosp_build_embedded_runtime_provenance_mismatch",
        "AOSP build provenance embeds runtime provenance that differs from the APK asset entry",
        "META-INF/eliza/aosp-build-provenance.json runtime_provenance differs from assets/agent/android-agent-runtime-provenance.json",
        "Regenerate AOSP build provenance in the same build that stages the runtime payload.",
    )
    add_if(
        findings,
        not args.allow_missing_aapt and package_name is None,
        "apk_package_name_unknown",
        "staged APK package name could not be read",
        package_source,
        "Install aapt or apkanalyzer in the evidence environment so package identity is checked before launcher/runtime claims.",
    )
    add_if(
        findings,
        not args.allow_missing_aapt
        and expected_package is not None
        and package_name is not None
        and package_name != expected_package,
        "apk_package_name_mismatch",
        "staged APK package name does not match the AOSP vendor package identity",
        f"expected={expected_package!r} actual={package_name!r} source={package_source}",
        "Rebuild the Android system APK and vendor role/permission layer around one package identity.",
    )
    add_if(
        findings,
        len(package_values) > 1,
        "apk_package_metadata_identity_mismatch",
        "staged APK package, AOSP build provenance, and vendor ro.elizaos.home do not agree",
        json.dumps(
            {
                "apk_package": package_name,
                "provenance_android_package": provenance_package,
                "vendor_ro_elizaos_home": vendor_package,
            },
            sort_keys=True,
        ),
        "Keep package metadata, provenance, vendor overlays, permission XML, and launcher/agent smokes on one package identity.",
    )
    add_if(
        findings,
        isinstance(provenance.get("repo_root"), str)
        and str(provenance["repo_root"]).startswith(("/home/", "/tmp/", "/Users/")),
        "aosp_build_provenance_contains_host_local_path",
        "staged APK build provenance records a host-local repo path",
        f"repo_root={provenance.get('repo_root')!r}",
        "Record reproducible repo identity and relative source roots instead of host-local paths in promoted AOSP APK provenance.",
    )
    provenance_host_paths = [
        path for path in host_local_paths(provenance) if not path.startswith("$.repo_root=")
    ]
    runtime_host_paths = host_local_paths(runtime_provenance)
    add_if(
        findings,
        bool(provenance_host_paths),
        "aosp_build_provenance_contains_host_local_paths",
        "staged APK AOSP provenance contains host-local paths",
        "; ".join(provenance_host_paths[:6]),
        "Regenerate AOSP build provenance with relative checkout paths and content hashes only.",
    )
    add_if(
        findings,
        bool(runtime_host_paths),
        "runtime_provenance_contains_host_local_paths",
        "staged APK runtime provenance contains host-local paths",
        "; ".join(runtime_host_paths[:6]),
        "Regenerate runtime provenance with relative checkout paths, artifact names, and SHA-256 values only.",
    )
    add_if(
        findings,
        bool(duplicate_critical_entries),
        "duplicate_critical_zip_entries",
        "staged APK contains duplicate critical ZIP entries",
        ", ".join(duplicate_critical_entries),
        "Rebuild or repack the APK so each required payload and provenance entry appears exactly once.",
    )

    evidence = {
        "apk": rel(apk),
        "entry_count": len(entries),
        "expected_package": expected_package,
        "package_name": package_name,
        "package_name_source": package_source,
        "vendor_ro_elizaos_home": vendor_package,
        "provenance_android_package": provenance_package,
        "provenance_entry": PROVENANCE_ENTRY,
        "provenance_present": PROVENANCE_ENTRY in entries,
        "provenance_schema": provenance.get("schema"),
        "provenance_apk_name": provenance.get("apk_name"),
        "provenance_claim_boundary": provenance.get("claim_boundary"),
        "provenance_expected_schema": AOSP_PROVENANCE_SCHEMA,
        "provenance_expected_claim_boundary": AOSP_PROVENANCE_CLAIM_BOUNDARY,
        "runtime_provenance_entry": RUNTIME_PROVENANCE_ENTRY,
        "runtime_provenance_present": RUNTIME_PROVENANCE_ENTRY in entries,
        "runtime_provenance_schema": runtime_provenance.get("schema"),
        "runtime_provenance_claim_boundary": runtime_provenance.get("claim_boundary"),
        "runtime_provenance_expected_schema": RUNTIME_PROVENANCE_SCHEMA,
        "runtime_provenance_expected_claim_boundary": RUNTIME_PROVENANCE_CLAIM_BOUNDARY,
        "runtime_provenance_sha256": runtime_provenance_sha256,
        "runtime_provenance_integrity_mismatches": runtime_integrity_mismatches,
        "runtime_provenance_metadata_failures": runtime_metadata_failures,
        "duplicate_critical_entries": duplicate_critical_entries,
        "runtime_provenance_file_count": len(runtime_provenance.get("files", []))
        if isinstance(runtime_provenance.get("files"), list)
        else 0,
        "required_entries": list(REQUIRED_ENTRIES),
        "riscv64_runtime_build_commands": list(RISCV64_RUNTIME_BUILD_COMMANDS),
        "riscv64_runtime_provenance_requirements": list(RISCV64_RUNTIME_PROVENANCE_REQUIREMENTS),
        "missing_entries": missing,
        "missing_common_entries": missing_common,
        "missing_riscv64_agent_runtime_entries": missing_riscv_agent,
        "missing_riscv64_native_loader_entries": missing_riscv_libs,
        "assets_agent_riscv64_entries": riscv_assets,
        "lib_riscv64_entries": riscv_libs,
        "has_arm64_agent_runtime": "assets/agent/arm64-v8a/bun" in entries,
        "has_x86_64_agent_runtime": "assets/agent/x86_64/bun" in entries,
        "has_llama_kernel_diagnostic": "assets/agent/llama-kernel-diagnostic.mjs" in entries,
    }
    return payload(findings, evidence)


def payload(findings: list[Finding], evidence: dict[str, Any]) -> dict[str, Any]:
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
    print(f"STATUS: {str(report['status']).upper()} android_system.apk_payload")
    for finding in report["findings"]:
        print(f"- {finding['code']}: {finding['message']}")
        print(f"  evidence: {finding['evidence']}")


def parse_args(argv: Iterable[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apk", default=str(DEFAULT_APK), help=f"APK path (default: {rel(DEFAULT_APK)})"
    )
    parser.add_argument(
        "--report", default=str(REPORT), help=f"report path (default: {rel(REPORT)})"
    )
    parser.add_argument("--allow-missing-aapt", action="store_true")
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
