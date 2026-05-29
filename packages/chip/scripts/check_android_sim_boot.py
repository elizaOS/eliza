#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = Path(
    os.environ.get("ANDROID_SIM_BOOT_REPORT", ROOT / "build/reports/android_sim_boot.json")
)
LOG_EVIDENCE_MANIFEST = ROOT / "docs/android/bsp-log-evidence-manifest.json"

sys.path.insert(0, str(ROOT / "scripts"))
import check_software_bsp  # noqa: E402

VALID_STATUSES = {"pass", "blocked", "failed"}
VIRTUAL_SMOKE_EVIDENCE = {
    "docs/evidence/android/eliza_ai_soc_cvd_hal_smoke.log",
    "docs/evidence/android/cuttlefish_riscv64_smoke.log",
    "docs/evidence/android/qemu_riscv64_smoke.log",
    "docs/evidence/android/renode_e1_soc_smoke.log",
}
CTS_VTS_PLAN_EVIDENCE = "docs/evidence/android/eliza_ai_soc_cts_vts_plan.log"
# A "pass" Android simulator boot must be backed by the structured launcher
# runtime evidence (booted launcher as HOME + live local agent), not just a
# generic virtual-device boot log.
LAUNCHER_RUNTIME_EVIDENCE = "docs/evidence/android/eliza_launcher_runtime_evidence.json"
REQUIRED_REPORT_FIELDS = {
    "schema": str,
    "status": str,
    "reason": str,
    "next_step": str,
    "aosp_dir": str,
    "aosp_product": str,
    "run_cuttlefish": bool,
    "run_cts": bool,
    "run_vts": bool,
    "run_qemu": bool,
    "run_renode": bool,
    "require_full_evidence": bool,
    "evidence_manifest": str,
    "software_bsp_checker": str,
    "required_evidence": list,
    "attempted_evidence": list,
    "host_requirements": dict,
    "linux_requirements": list,
    "handoff_commands": list,
    "claim_boundary": str,
    "phone_claim_allowed": bool,
    "release_claim_allowed": bool,
    "e1_chip_hardware_claim_allowed": bool,
    "cdd_compliance_claim_allowed": bool,
    "gms_claim_allowed": bool,
    "cts_vts_claim_allowed": bool,
    "full_android_compatibility_claim_allowed": bool,
    "hardware_boot_claim_allowed": bool,
    "production_readiness_claim_allowed": bool,
}
FALSE_CLAIM_FLAGS = {
    "phone_claim_allowed",
    "release_claim_allowed",
    "e1_chip_hardware_claim_allowed",
    "cdd_compliance_claim_allowed",
    "gms_claim_allowed",
    "cts_vts_claim_allowed",
    "full_android_compatibility_claim_allowed",
    "hardware_boot_claim_allowed",
    "production_readiness_claim_allowed",
}


def display_path(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def main() -> int:
    errors: list[str] = []
    required_evidence = check_software_bsp.TARGETS["aosp"]["evidence"]
    build_only_evidence = [
        path
        for path in required_evidence
        if path
        not in {
            "docs/evidence/android/eliza_ai_soc_cts_vts_plan.log",
            "docs/evidence/android/eliza_ai_soc_cvd_hal_smoke.log",
            "docs/evidence/android/cuttlefish_riscv64_smoke.log",
            "docs/evidence/android/qemu_riscv64_smoke.log",
            "docs/evidence/android/renode_e1_soc_smoke.log",
        }
    ]
    if not LOG_EVIDENCE_MANIFEST.is_file():
        return report("failed", [f"missing {LOG_EVIDENCE_MANIFEST.relative_to(ROOT)}"])
    try:
        manifest = json.loads(LOG_EVIDENCE_MANIFEST.read_text())
    except json.JSONDecodeError as exc:
        return report(
            "failed", [f"{LOG_EVIDENCE_MANIFEST.relative_to(ROOT)} is invalid JSON: {exc}"]
        )

    if manifest.get("claim_boundary") != "expected_future_log_markers_only_not_boot_evidence":
        errors.append("AOSP log evidence manifest must keep the expected-future-log boundary")
    manifest_logs = manifest.get("logs", {})
    if not isinstance(manifest_logs, dict):
        errors.append("AOSP log evidence manifest logs must be an object")
        manifest_logs = {}
    missing_manifest_specs = [path for path in required_evidence if path not in manifest_logs]
    if missing_manifest_specs:
        errors.append(
            "AOSP log evidence manifest missing required specs: "
            + ", ".join(missing_manifest_specs)
        )
    for path in required_evidence:
        spec = manifest_logs.get(path, {})
        if not isinstance(spec, dict):
            errors.append(f"AOSP log evidence manifest spec for {path} must be an object")
            continue
        if not spec.get("blocker_code"):
            errors.append(f"AOSP log evidence manifest spec for {path} missing blocker_code")
        required_metadata = spec.get("required_metadata", [])
        if not isinstance(required_metadata, list):
            errors.append(
                f"AOSP log evidence manifest spec for {path} required_metadata must be a list"
            )
            required_metadata = []
        if (
            path.startswith("docs/evidence/android/")
            and "COMPATIBILITY_CLAIM=none" not in required_metadata
        ):
            errors.append(
                f"AOSP log evidence manifest spec for {path} must require COMPATIBILITY_CLAIM=none"
            )
        if path in VIRTUAL_SMOKE_EVIDENCE:
            for marker in (
                "BOOT_CLAIM=none",
                "SCHEMA=docs/android/boot-transcript.schema.json",
            ):
                if marker not in required_metadata:
                    errors.append(f"AOSP virtual smoke spec for {path} must require {marker}")
            if spec.get("claim_boundary") not in {
                "expected_future_log_markers_only_not_boot_evidence",
                "virtual_device_smoke_only_not_boot_or_compatibility_evidence",
            }:
                errors.append(f"AOSP virtual smoke spec for {path} has unsafe claim boundary")
        if path == CTS_VTS_PLAN_EVIDENCE:
            forbidden_claims = spec.get("forbidden_claims", [])
            for claim in (
                "CTS passed",
                "VTS passed",
                "full CTS",
                "full VTS",
                "Android compatible",
            ):
                if claim not in forbidden_claims:
                    errors.append(f"AOSP CTS/VTS plan spec must forbid broad claim {claim!r}")

    if not REPORT.is_file():
        return report(
            "blocked",
            errors
            + [
                f"missing {display_path(REPORT)}",
                "run scripts/boot_android_simulator.sh with AOSP_DIR set",
            ],
        )

    try:
        data = json.loads(REPORT.read_text())
    except json.JSONDecodeError as exc:
        return report("failed", errors + [f"{display_path(REPORT)} is invalid JSON: {exc}"])

    for field, expected_type in REQUIRED_REPORT_FIELDS.items():
        value = data.get(field)
        if not isinstance(value, expected_type):
            errors.append(f"android sim report {field} must be {expected_type.__name__}")

    if data.get("schema") != "eliza.android_sim_boot.v1":
        errors.append("android sim report schema mismatch")
    if data.get("aosp_dir_source") is not None and not isinstance(
        data.get("aosp_dir_source"), str
    ):
        errors.append("android sim report aosp_dir_source must be string when present")
    status = data.get("status")
    if status not in VALID_STATUSES:
        errors.append(f"android sim report status {status!r} is invalid")
    if data.get("evidence_manifest") != "docs/android/bsp-log-evidence-manifest.json":
        errors.append(
            "android sim report must reference docs/android/bsp-log-evidence-manifest.json"
        )
    if data.get("software_bsp_checker") != "scripts/check_software_bsp.py aosp --require-evidence":
        errors.append("android sim report must reference the strict AOSP BSP evidence checker")
    if data.get("required_evidence") != required_evidence:
        errors.append("android sim report required_evidence must match check_software_bsp.py aosp")
    attempted = data.get("attempted_evidence")
    if data.get("require_full_evidence") is True and attempted != required_evidence:
        errors.append("full android sim report must attempt every required AOSP evidence category")
    if data.get("require_full_evidence") is False and attempted != build_only_evidence:
        errors.append(
            "build-only android sim report must stop before virtual-device smoke and compatibility evidence"
        )
    boundary = data.get("claim_boundary", "")
    if "not e1-chip hardware ABI proof" not in boundary:
        errors.append(
            "android sim report must separate Android virtual-device evidence from e1-chip ABI proof"
        )
    if "compatibility claim" not in boundary:
        errors.append("android sim report must avoid full Android compatibility claims")
    for key in sorted(FALSE_CLAIM_FLAGS):
        if data.get(key) is not False:
            errors.append(f"android sim report {key} must be exactly false")
    host_requirements = data.get("host_requirements", {})
    if isinstance(host_requirements, dict):
        if not isinstance(host_requirements.get("host_os"), str):
            errors.append("android sim report host_requirements.host_os must be string")
        if not isinstance(host_requirements.get("host_arch"), str):
            errors.append("android sim report host_requirements.host_arch must be string")
        missing = host_requirements.get("missing")
        if not isinstance(missing, list) or not all(isinstance(item, str) for item in missing):
            errors.append("android sim report host_requirements.missing must be a string list")
    linux_requirements = data.get("linux_requirements", [])
    if isinstance(linux_requirements, list):
        for required in ("AOSP_DIR", "/dev/kvm", "launch_cvd"):
            if not any(required in item for item in linux_requirements):
                errors.append(f"android sim report linux_requirements missing {required}")
    handoff_commands = data.get("handoff_commands", [])
    if isinstance(handoff_commands, list):
        for required in (
            "scripts/check_aosp_linux_preflight.py --write-report",
            "scripts/boot_android_simulator.sh --run-cuttlefish",
            "scripts/check_software_bsp.py aosp --require-evidence",
        ):
            if not any(required in item for item in handoff_commands):
                errors.append(f"android sim report handoff_commands missing {required}")

    if status == "pass":
        bsp_report = check_software_bsp.target_report("aosp")
        if bsp_report["errors"]:
            errors.extend(f"AOSP BSP evidence error: {error}" for error in bsp_report["errors"])
        missing_evidence = bsp_report["missing_evidence"]
        if missing_evidence:
            errors.extend(
                f"pass report is missing required evidence {item['path']}({item['blocker_code']})"
                for item in missing_evidence
            )
        if bsp_report["evidence_status"] != "PASS":
            errors.append(
                f"pass report cannot clear while AOSP evidence_status={bsp_report['evidence_status']}"
            )
        # A booted virtual device is not a booted product: require the
        # structured launcher runtime evidence (launcher as HOME, local agent
        # answering /api/health, no fatal crashes / SELinux denials) before a
        # pass can clear.
        launcher_path = ROOT / LAUNCHER_RUNTIME_EVIDENCE
        if not launcher_path.is_file():
            errors.append(
                f"pass report is missing launcher runtime evidence {LAUNCHER_RUNTIME_EVIDENCE}"
            )
        else:
            try:
                launcher = json.loads(launcher_path.read_text())
            except json.JSONDecodeError as exc:
                errors.append(f"{LAUNCHER_RUNTIME_EVIDENCE} is invalid JSON: {exc}")
            else:
                device = launcher.get("device", {})
                app = launcher.get("app", {})
                agent = launcher.get("agent", {})
                logs = launcher.get("logs", {})
                if str(device.get("sys_boot_completed")) != "1":
                    errors.append("launcher runtime evidence: device.sys_boot_completed != 1")
                if not str(app.get("home_resolve_activity", "")):
                    errors.append("launcher runtime evidence: launcher is not the resolved HOME")
                if agent.get("health_http") != 200 or agent.get("health_ready") is not True:
                    errors.append("launcher runtime evidence: local agent /api/health not ready")
                if logs.get("fatal_crash_count") not in (0, "0"):
                    errors.append("launcher runtime evidence: fatal crashes present")
                if logs.get("avc_denial_count") not in (0, "0"):
                    errors.append("launcher runtime evidence: SELinux AVC denials present")
    elif status == "blocked" and data.get("require_full_evidence") is False:
        attempted_paths = data.get("attempted_evidence", [])
        forbidden_build_only = sorted(set(attempted_paths) - set(build_only_evidence))
        if forbidden_build_only:
            errors.append(
                "build-only blocked report attempted virtual-device or compatibility evidence: "
                + ", ".join(forbidden_build_only)
            )

    if errors:
        severity = "blocked" if status == "blocked" else "failed"
        return report(severity, errors)

    if status == "pass":
        print("Android simulator boot check passed")
        return 0

    print(f"Android simulator boot blocked: {data.get('reason')}")
    missing = host_requirements.get("missing") if isinstance(host_requirements, dict) else None
    if missing:
        print("Missing host requirements:")
        for item in missing:
            print(f"  - {item}")
    print(f"Next step: {data.get('next_step')}")
    return 2


def report(status: str, errors: list[str]) -> int:
    code = 2 if status == "blocked" else 1
    heading = (
        "Android simulator boot blocked" if status == "blocked" else "Android simulator boot failed"
    )
    print(f"{heading}:")
    for error in errors:
        print(f"  - {error}")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
