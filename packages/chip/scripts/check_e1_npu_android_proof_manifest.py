#!/usr/bin/env python3
"""Validate the Android HAL/CTS/VTS/NNAPI proof manifest.

This checker is intentionally fail-closed. A blocked template can be
structurally valid, but a passed manifest must bind every required status to a
real repo-relative artifact with matching SHA-256, byte count, and content
markers.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "docs/benchmarks/capabilities/e1_npu_android_proof_manifest.template.json"
DEFAULT_STATUS_JSON = ROOT / "build/reports/e1_npu_android_proof_manifest_check.json"
TEMPLATE_CLAIM_BOUNDARY = "template_only_not_android_boot_cts_vts_or_nnapi_evidence"
SCHEMA = "eliza.e1_npu_android_proof_manifest.v1"
REQUIRED_STATUSES = {
    "aidl_or_hidl_hal_declared",
    "hal_binary_in_vendorimage",
    "vintf_check",
    "selinux_policy_build",
    "selinux_neverallow",
    "vts_e1_npu",
    "cts_nnapi_smoke",
    "nnapi_accelerator_query",
    "fail_closed_absent_device",
}
REQUIRED_ARTIFACTS = {
    "vts_result",
    "cts_result",
    "selinux_policy_build_log",
    "selinux_neverallow_log",
    "vintf_check_log",
    "nnapi_query_log",
    "absent_device_probe_log",
}
PASSED = "passed"
BLOCKED = "blocked"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def display(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError as exc:
        raise SystemExit(f"missing manifest: {path}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"invalid JSON in {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise SystemExit(f"{path}: manifest must be a JSON object")
    return data


def is_sha256(value: Any) -> bool:
    return isinstance(value, str) and bool(SHA256_RE.fullmatch(value))


def is_template_placeholder(value: Any) -> bool:
    return isinstance(value, str) and "64-character lowercase sha256" in value


def validate_manifest(data: dict[str, Any], require_pass: bool) -> tuple[int, dict[str, Any]]:
    errors: list[str] = []
    blockers: list[str] = []

    is_template = data.get("claim_boundary") == TEMPLATE_CLAIM_BOUNDARY
    if data.get("schema") != SCHEMA:
        errors.append(f"schema must be {SCHEMA}")

    status = data.get("status")
    if status not in {BLOCKED, PASSED}:
        errors.append("status must be blocked or passed")
    if is_template and status != BLOCKED:
        errors.append("template manifest must remain blocked")

    proof_gate = data.get("proof_gate")
    if not isinstance(proof_gate, dict):
        errors.append("proof_gate must be an object")
    else:
        for key in ("android_boot_claim", "compatibility_claim", "nnapi_acceleration_claim"):
            value = proof_gate.get(key)
            if not isinstance(value, str) or not value:
                errors.append(f"proof_gate.{key} must be a non-empty string")
        if status == PASSED and "none" in str(proof_gate.get("nnapi_acceleration_claim", "")):
            errors.append("passed manifest cannot keep proof_gate.nnapi_acceleration_claim at none")

    statuses = data.get("required_statuses")
    if not isinstance(statuses, dict):
        errors.append("required_statuses must be an object")
        statuses = {}
    missing_statuses = sorted(REQUIRED_STATUSES - set(statuses))
    extra_statuses = sorted(set(statuses) - REQUIRED_STATUSES)
    if missing_statuses:
        errors.append("required_statuses missing: " + ", ".join(missing_statuses))
    if extra_statuses:
        errors.append("required_statuses has unexpected entries: " + ", ".join(extra_statuses))
    for name in sorted(REQUIRED_STATUSES & set(statuses)):
        value = statuses[name]
        if value not in {BLOCKED, PASSED}:
            errors.append(f"required_statuses.{name} must be blocked or passed")
        elif value != PASSED:
            blockers.append(f"{name}: {value}")

    if status == PASSED and blockers:
        errors.append("passed manifest still has blocked required_statuses")

    artifacts = data.get("artifacts")
    if not isinstance(artifacts, dict):
        errors.append("artifacts must be an object")
        artifacts = {}
    missing_artifacts = sorted(REQUIRED_ARTIFACTS - set(artifacts))
    if missing_artifacts:
        errors.append("artifacts missing: " + ", ".join(missing_artifacts))

    artifact_paths: dict[str, Path] = {}
    artifact_readable: dict[str, Path] = {}
    for name in sorted(REQUIRED_ARTIFACTS & set(artifacts)):
        entry = artifacts[name]
        if not isinstance(entry, dict):
            errors.append(f"artifacts.{name} must be an object")
            continue
        rel = entry.get("path")
        if not isinstance(rel, str) or not rel:
            errors.append(f"artifacts.{name}.path must be a non-empty string")
            continue
        if Path(rel).is_absolute():
            errors.append(f"artifacts.{name}.path must be repo-relative")
            continue
        path = ROOT / rel
        artifact_paths[name] = path

        expected_sha = entry.get("sha256")
        expected_bytes = entry.get("bytes")
        if is_template:
            if not is_template_placeholder(expected_sha):
                errors.append(f"template artifacts.{name}.sha256 must be a placeholder")
            continue

        if not is_sha256(expected_sha):
            errors.append(f"artifacts.{name}.sha256 must be lowercase SHA-256 hex")
        if (
            not isinstance(expected_bytes, int)
            or isinstance(expected_bytes, bool)
            or expected_bytes <= 0
        ):
            errors.append(f"artifacts.{name}.bytes must be a positive integer")
        if not path.is_file() or path.stat().st_size == 0:
            blockers.append(f"{name}: missing or empty artifact {display(path)}")
            continue

        artifact_readable[name] = path
        if is_sha256(expected_sha):
            actual_sha = sha256_file(path)
            if actual_sha != expected_sha:
                errors.append(f"artifacts.{name}.sha256 does not match {display(path)}")
        if isinstance(expected_bytes, int) and not isinstance(expected_bytes, bool):
            actual_bytes = path.stat().st_size
            if actual_bytes != expected_bytes:
                errors.append(
                    f"artifacts.{name}.bytes does not match {display(path)}; "
                    f"got {expected_bytes}, expected {actual_bytes}"
                )

    required_markers = data.get("required_markers")
    if not isinstance(required_markers, dict):
        errors.append("required_markers must be an object")
        required_markers = {}
    for name, markers in sorted(required_markers.items()):
        if name not in REQUIRED_ARTIFACTS:
            errors.append(f"required_markers.{name} does not match a required artifact")
            continue
        if not isinstance(markers, list) or not all(
            isinstance(marker, str) and marker for marker in markers
        ):
            errors.append(f"required_markers.{name} must be a list of non-empty strings")
            continue
        marker_path = artifact_readable.get(name)
        if marker_path is None:
            if not is_template and name in artifact_paths:
                blockers.append(f"{name}: markers not checked because artifact is unavailable")
            continue
        text = marker_path.read_text(encoding="utf-8", errors="replace")
        for marker in markers:
            if marker not in text:
                errors.append(f"{display(marker_path)} must contain marker {marker!r}")

    if require_pass and status != PASSED:
        blockers.append("manifest status is blocked; real Android proof has not been captured")

    result_status = "error" if errors else ("blocked" if blockers else "passed")
    return_code = 1 if errors else (2 if require_pass and blockers else 0)
    report = {
        "schema": "eliza.e1_npu_android_proof_manifest_check.v1",
        "status": result_status,
        "manifest_status": status,
        "template": is_template,
        "errors": errors,
        "blockers": blockers,
    }
    return return_code, report


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument(
        "--status-json",
        type=Path,
        default=DEFAULT_STATUS_JSON,
        help=(
            "Output path for the checker report. Defaults to "
            "build/reports/e1_npu_android_proof_manifest_check.json."
        ),
    )
    parser.add_argument(
        "--require-pass",
        action="store_true",
        help="Return blocked unless the manifest is a complete passed proof.",
    )
    parser.add_argument("--json", action="store_true", help="Print the full JSON report.")
    args = parser.parse_args(argv)

    manifest_path = args.manifest if args.manifest.is_absolute() else ROOT / args.manifest
    data = load_json(manifest_path)
    rc, report = validate_manifest(data, args.require_pass)
    status_path = args.status_json if args.status_json.is_absolute() else ROOT / args.status_json
    status_path.parent.mkdir(parents=True, exist_ok=True)
    status_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    elif report["status"] == "passed":
        print(f"Android proof manifest passed: {display(manifest_path)}")
    elif report["status"] == "blocked":
        print(f"Android proof manifest BLOCKED: {display(manifest_path)}")
        for blocker in report["blockers"]:
            print(f"  - {blocker}")
    else:
        print(f"Android proof manifest invalid: {display(manifest_path)}")
        for error in report["errors"]:
            print(f"  - {error}")
    return rc


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
