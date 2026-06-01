#!/usr/bin/env python3
"""Assemble the Android e1-NPU proof manifest from captured artifacts.

This does not create runtime evidence. It hashes existing logs/results, marks
missing or marker-incomplete inputs as blocked, and emits a manifest that the
strict checker can validate.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "docs/benchmarks/capabilities/e1_npu_android_proof_manifest.template.json"
DEFAULT_OUTPUT = ROOT / "docs/evidence/android/e1-npu/android-proof-manifest.json"
DEFAULT_REPORT = ROOT / "build/reports/e1_npu_android_proof_manifest_assembly.json"

STATUS_ARTIFACTS = {
    "aidl_or_hidl_hal_declared": ("vintf_check_log",),
    "hal_binary_in_vendorimage": ("vintf_check_log",),
    "vintf_check": ("vintf_check_log",),
    "selinux_policy_build": ("selinux_policy_build_log",),
    "selinux_neverallow": ("selinux_neverallow_log",),
    "vts_e1_npu": ("vts_result",),
    "cts_nnapi_smoke": ("cts_result",),
    "nnapi_accelerator_query": ("nnapi_query_log",),
    "fail_closed_absent_device": ("absent_device_probe_log",),
}


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_template(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("schema") != "eliza.e1_npu_android_proof_manifest.v1":
        raise SystemExit(f"{rel(path)} has unexpected schema")
    return data


def artifact_state(name: str, entry: dict[str, Any], markers: list[str]) -> dict[str, Any]:
    artifact_path = ROOT / str(entry["path"])
    state: dict[str, Any] = {
        "name": name,
        "path": rel(artifact_path),
        "present": artifact_path.is_file() and artifact_path.stat().st_size > 0,
        "marker_errors": [],
    }
    if not state["present"]:
        state["blocked_reason"] = "missing_or_empty_artifact"
        return state
    text = artifact_path.read_text(encoding="utf-8", errors="replace")
    state["sha256"] = sha256_file(artifact_path)
    state["bytes"] = artifact_path.stat().st_size
    state["marker_errors"] = [marker for marker in markers if marker not in text]
    if state["marker_errors"]:
        state["blocked_reason"] = "missing_required_markers"
    return state


def build_manifest(args: argparse.Namespace) -> tuple[dict[str, Any], dict[str, Any]]:
    template = load_template(args.template)
    required_markers = template["required_markers"]
    artifacts = template["artifacts"]
    states = {
        name: artifact_state(name, entry, required_markers.get(name, []))
        for name, entry in artifacts.items()
    }
    blocked_artifacts = {
        name: state
        for name, state in states.items()
        if not state.get("present") or state.get("marker_errors")
    }

    assembled_artifacts: dict[str, dict[str, Any]] = {}
    for name, entry in artifacts.items():
        state = states[name]
        if state.get("present") and not state.get("marker_errors"):
            assembled_artifacts[name] = {
                "path": state["path"],
                "sha256": state["sha256"],
                "bytes": state["bytes"],
            }
        else:
            assembled_artifacts[name] = {
                "path": str(entry["path"]),
                "sha256": f"blocked:{state.get('blocked_reason', 'unavailable')}",
                "bytes": int(entry.get("bytes", 1)),
            }

    required_statuses: dict[str, str] = {}
    for status_name, artifact_names in STATUS_ARTIFACTS.items():
        required_statuses[status_name] = (
            "blocked" if any(name in blocked_artifacts for name in artifact_names) else "passed"
        )

    manifest_status = "blocked" if blocked_artifacts else "passed"
    findings = [
        {
            "code": f"missing_or_invalid_android_npu_artifact_{name}",
            "severity": "blocker",
            "message": f"Android e1-NPU proof artifact {name} is not ready",
            "evidence": state.get("path"),
            "next_step": (
                "Capture the required Android e1-NPU artifact with the template-listed "
                "markers, then rerun scripts/assemble_e1_npu_android_proof_manifest.py."
            ),
            "blocked_reason": state.get("blocked_reason", "missing_required_markers"),
            "marker_errors": state.get("marker_errors", []),
        }
        for name, state in blocked_artifacts.items()
    ]
    manifest = {
        "schema": "eliza.e1_npu_android_proof_manifest.v1",
        "claim_boundary": "android_e1_npu_artifact_manifest_only_not_full_android_compatibility_claim",
        "status": manifest_status,
        "target": args.target,
        "generated_by": args.generated_by,
        "date_utc": datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "proof_gate": {
            "android_boot_claim": "artifact_bound_e1_npu_android_evidence"
            if manifest_status == "passed"
            else "none_until_all_required_artifacts_pass",
            "compatibility_claim": "none",
            "nnapi_acceleration_claim": "e1_npu_nnapi_query_and_cts_smoke_artifacts_passed"
            if manifest_status == "passed"
            else "none_without_all_required_artifacts_passed",
        },
        "capture_commands": template["capture_commands"],
        "required_statuses": required_statuses,
        "artifacts": assembled_artifacts,
        "required_markers": required_markers,
    }
    report = {
        "schema": "eliza.e1_npu_android_proof_manifest_assembly.v1",
        "status": manifest_status,
        "manifest": rel(args.output),
        "summary": {
            "artifacts": len(states),
            "blocked_artifacts": len(blocked_artifacts),
            "passed_statuses": sum(1 for value in required_statuses.values() if value == "passed"),
            "blocked_statuses": sum(
                1 for value in required_statuses.values() if value == "blocked"
            ),
        },
        "findings": findings,
        "artifact_states": states,
    }
    return manifest, report


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--template", type=Path, default=TEMPLATE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--target", default="eliza_ai_soc-userdebug")
    parser.add_argument(
        "--generated-by",
        default="scripts/assemble_e1_npu_android_proof_manifest.py",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    args.template = args.template if args.template.is_absolute() else ROOT / args.template
    args.output = args.output if args.output.is_absolute() else ROOT / args.output
    args.report = args.report if args.report.is_absolute() else ROOT / args.report
    manifest, report = build_manifest(args)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    args.report.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        f"STATUS: {report['status'].upper()} e1_npu_android_proof_manifest_assembly "
        f"blocked_artifacts={report['summary']['blocked_artifacts']} "
        f"report={rel(args.report)} manifest={rel(args.output)}"
    )
    return 0 if report["status"] == "passed" else 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
