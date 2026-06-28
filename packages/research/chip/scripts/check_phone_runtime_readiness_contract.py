#!/usr/bin/env python3
"""Gate complete-phone runtime surfaces for the chip/OS boot objective.

Several existing checks intentionally pass when they prove a scope remains
release-blocked. That is useful for documentation hygiene, but for the current
objective (Linux/AOSP forks boot on the chip emulator, launcher starts, and
everything runs) those same honest non-claims are blockers. This gate consumes
the scope reports and reclassifies unresolved phone runtime surfaces as
BLOCKED in the aggregate readiness view.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from collections.abc import Callable, Iterable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import check_phone_media_pipeline_scope
import check_power_thermal_scope
import check_radio_sensor_pmic_scope
import check_security_lifecycle_scope

ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parents[1] if len(ROOT.parents) > 1 else ROOT
REPORT = ROOT / "build/reports/phone_runtime_readiness_contract.json"
ANDROID_APK_PAYLOAD_REPORT = ROOT / "build/reports/android_system_apk_payload.json"
PLANNED_EVIDENCE_TEMPLATE_MANIFEST = (
    ROOT / "docs/evidence/runtime/phone_runtime_planned_evidence_templates.json"
)
LIVE_CAPTURE_CONTRACT_MANIFEST = (
    ROOT / "docs/evidence/android/runtime/live_runtime_capture_contracts.json"
)
SCHEMA = "eliza.phone_runtime_readiness_contract.v1"
CLAIM_BOUNDARY = "static_phone_runtime_readiness_contract_only_not_runtime_evidence"
FALSE_CLAIM_FLAGS = {
    "phone_claim_allowed": False,
    "release_claim_allowed": False,
    "runtime_claim_allowed": False,
    "android_boot_claim_allowed": False,
    "launcher_runtime_claim_allowed": False,
    "agent_liveness_claim_allowed": False,
    "hardware_boot_claim_allowed": False,
    "production_readiness_claim_allowed": False,
    "cts_vts_claim_allowed": False,
    "gms_claim_allowed": False,
}
ANDROID_PAYLOAD_PACKAGE_SENTINEL = "$ANDROID_PAYLOAD_PACKAGE"
CHIP_ANDROID_ADB_HOSTPORT_SENTINEL = "$CHIP_ANDROID_ADB_HOSTPORT"
PHONE_RUNTIME_VALIDATION_COMMAND = (
    "python3 packages/chip/scripts/check_phone_runtime_readiness_contract.py"
)
PHONE_RUNTIME_AGGREGATE_COMMAND = (
    "python3 packages/chip/scripts/aggregate_tapeout_readiness.py --scope phone --strict"
)
LIVE_CAPTURE_UNAVAILABLE_TOKENS = (
    "adb: no devices/emulators found",
    "adb device unavailable",
    "Connection refused",
    "connection refused",
    "failed to connect",
    "SELECTED_ADB_SERIAL=<none>",
    "PROBE_ERROR=adb",
    "status=BLOCKED",
    '"status": "BLOCKED"',
)
PLANNED_EVIDENCE_MISSING = "planned_evidence_missing"
PLANNED_EVIDENCE_INCOMPLETE = "planned_evidence_incomplete"
LIVE_CAPTURE_UNAVAILABLE = "live_capture_unavailable"
LIVE_DEVICE_VALIDATION = "live_device_validation"
PLANNED_MISSING_EVIDENCE = "planned_missing_evidence"
PLANNED_INCOMPLETE_EVIDENCE = "planned_incomplete_evidence"
REPO_ARTIFACT_GENERATION = "repo_artifact_generation"


@dataclass(frozen=True)
class EvidenceSpec:
    path: Path
    description: str
    required_tokens: tuple[str, ...] = ()
    forbidden_tokens: tuple[str, ...] = ()
    json_expectations: tuple[tuple[str, str, Any], ...] = ()


@dataclass(frozen=True)
class ScopeSpec:
    name: str
    report_builder: Callable[[], dict[str, Any]]
    validator: Callable[[dict[str, Any]], list[str]]
    required_status: str
    runtime_surface: str
    required_runtime_evidence: tuple[str, ...]
    required_evidence_files: tuple[EvidenceSpec, ...] = ()


@dataclass(frozen=True)
class Finding:
    code: str
    severity: str
    message: str
    evidence: str
    next_step: str
    blocker_dependency: str = "live_device_validation"


def utc_now() -> str:
    return dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


SCOPES: tuple[ScopeSpec, ...] = (
    ScopeSpec(
        name="phone_media_pipeline",
        report_builder=check_phone_media_pipeline_scope.build_report,
        validator=check_phone_media_pipeline_scope.validate_report,
        required_status="phone_media_pipeline_runtime_ready",
        runtime_surface="display, graphics/HWC, camera/ISP, audio/media privacy",
        required_runtime_evidence=(
            "DRM/KMS or Android HWC foreground transcript",
            "panel/scanout under memory pressure",
            "Camera HAL/V4L2 capture",
            "camera privacy/permission evidence",
        ),
        required_evidence_files=(
            EvidenceSpec(
                path=ROOT / "docs/evidence/android/eliza_launcher_runtime_evidence.json",
                description="booted RISC-V launcher owns HOME and agent runtime is healthy",
                json_expectations=(
                    ("status", "eq", "PASS"),
                    ("result", "eq", 0),
                    ("device.cpu_abi", "eq", "riscv64"),
                    ("device.sys_boot_completed", "eq", "1"),
                    ("app.package_name", "eq", ANDROID_PAYLOAD_PACKAGE_SENTINEL),
                    ("app.foreground_activity", "contains", ANDROID_PAYLOAD_PACKAGE_SENTINEL),
                    ("app.home_resolve_activity", "contains", ANDROID_PAYLOAD_PACKAGE_SENTINEL),
                    (
                        "app.role_holders.android.app.role.HOME",
                        "contains",
                        ANDROID_PAYLOAD_PACKAGE_SENTINEL,
                    ),
                    ("app.service_pid", "gt", 0),
                    ("agent.health_http", "eq", 200),
                    ("agent.health_ready", "eq", True),
                    ("logs.avc_denial_count", "eq", 0),
                    ("logs.fatal_crash_count", "eq", 0),
                ),
            ),
            EvidenceSpec(
                path=ROOT / "docs/evidence/android/eliza_ai_soc_cvd_hal_processes.txt",
                description="booted Android HAL process list includes display, audio, camera, and NPU services",
                required_tokens=(
                    "android.hardware.graphics.composer3-service",
                    "android.hardware.audio.service",
                    "android.hardware.camera.provider",
                    "android.hardware.neuralnetworks",
                ),
            ),
            EvidenceSpec(
                path=ROOT / "docs/evidence/android/peripherals/rear_camera_sim.log",
                description="rear camera capture probe completed after Android boot",
                required_tokens=("eliza-evidence: status=PASS", "CAPTURE_COUNT="),
                forbidden_tokens=("status=BLOCKED", "PROBE_ERROR", "MISSING_MARKERS"),
            ),
            EvidenceSpec(
                path=ROOT / "docs/evidence/android/peripherals/front_camera_sim.log",
                description="front camera capture probe completed after Android boot",
                required_tokens=("eliza-evidence: status=PASS", "CAPTURE_COUNT="),
                forbidden_tokens=("status=BLOCKED", "PROBE_ERROR", "MISSING_MARKERS"),
            ),
        ),
    ),
    ScopeSpec(
        name="security_lifecycle",
        report_builder=check_security_lifecycle_scope.build_report,
        validator=check_security_lifecycle_scope.validate_report,
        required_status="security_lifecycle_runtime_ready",
        runtime_surface="secure boot, verified boot, rollback, debug lock, production keys",
        required_runtime_evidence=(
            "signed boot acceptance",
            "unsigned/tampered image rejection",
            "rollback rejection",
            "debug-lock and key-provisioning transcript",
        ),
        required_evidence_files=(
            EvidenceSpec(
                path=ROOT / "docs/evidence/android/security/verified_boot_acceptance.log",
                description="signed verified-boot image accepted on target",
                required_tokens=("VERIFIED_BOOT=pass", "RESULT=0"),
                forbidden_tokens=("BLOCKED", "FAIL", "tampered image accepted"),
            ),
            EvidenceSpec(
                path=ROOT / "docs/evidence/android/security/tampered_boot_rejection.log",
                description="tampered boot image rejected by verified boot",
                required_tokens=("TAMPERED_BOOT_REJECTED=pass", "RESULT=0"),
                forbidden_tokens=("BLOCKED", "FAIL", "accepted"),
            ),
            EvidenceSpec(
                path=ROOT / "docs/evidence/android/security/rollback_rejection.log",
                description="rollback image rejected by rollback index policy",
                required_tokens=("ROLLBACK_REJECTED=pass", "RESULT=0"),
                forbidden_tokens=("BLOCKED", "FAIL", "accepted"),
            ),
            EvidenceSpec(
                path=ROOT / "docs/evidence/android/security/debug_lock_key_provisioning.log",
                description="production debug-lock and key provisioning transcript",
                required_tokens=("DEBUG_LOCKED=pass", "PRODUCTION_KEYS=pass", "RESULT=0"),
                forbidden_tokens=("BLOCKED", "FAIL", "test-keys", "dev-keys"),
            ),
        ),
    ),
    ScopeSpec(
        name="radio_sensor_pmic",
        report_builder=check_radio_sensor_pmic_scope.build_report,
        validator=check_radio_sensor_pmic_scope.validate_report,
        required_status="radio_sensor_pmic_runtime_ready",
        runtime_surface="Wi-Fi, Bluetooth, GNSS/NFC, cellular, sensors, haptics, PMIC, charger",
        required_runtime_evidence=(
            "radio firmware load and association/pairing/lock transcripts",
            "Android Sensors/Input/Vibrator HAL evidence",
            "Health/Power/Thermal HAL evidence",
            "charger/fuel-gauge/brownout/suspend evidence",
        ),
        required_evidence_files=(
            EvidenceSpec(
                path=ROOT / "docs/evidence/android/eliza_ai_soc_cvd_hal_processes.txt",
                description="booted Android HAL process list includes radio, sensor, haptic, PMIC, and thermal services",
                required_tokens=(
                    "android.hardware.wifi-service",
                    "android.hardware.bluetooth-service",
                    "android.hardware.gnss-service",
                    "android.hardware.nfc-service",
                    "android.hardware.sensors-service",
                    "android.hardware.vibrator-service",
                    "android.hardware.health-service",
                    "android.hardware.power-service",
                    "android.hardware.thermal-service",
                ),
            ),
            EvidenceSpec(
                path=ROOT / "docs/evidence/android/peripherals/wifi_sim.log",
                description="Wi-Fi association and IP connectivity transcript",
                required_tokens=("eliza-evidence: status=PASS", "IP_CONNECTIVITY=pass"),
                forbidden_tokens=("status=BLOCKED", "PROBE_ERROR", "MISSING_MARKERS"),
            ),
            EvidenceSpec(
                path=ROOT / "docs/evidence/android/peripherals/bluetooth_sim.log",
                description="Bluetooth controller and pairing transcript",
                required_tokens=("eliza-evidence: status=PASS", "PAIRING=pass"),
                forbidden_tokens=("status=BLOCKED", "PROBE_ERROR", "MISSING_MARKERS"),
            ),
            EvidenceSpec(
                path=ROOT / "docs/evidence/android/peripherals/cellular_5g_lte_sim.log",
                description="cellular modem attach and data transcript",
                required_tokens=("eliza-evidence: status=PASS", "DATA_ATTACH=pass"),
                forbidden_tokens=("status=BLOCKED", "PROBE_ERROR", "MISSING_MARKERS"),
            ),
        ),
    ),
    ScopeSpec(
        name="power_thermal",
        report_builder=check_power_thermal_scope.build_report,
        validator=check_power_thermal_scope.validate_report,
        required_status="power_thermal_runtime_ready",
        runtime_surface="sustained power, thermal, throttling, frequency, workload stability",
        required_runtime_evidence=(
            "calibrated VDDCORE/VDDIO power traces",
            "aligned thermal/frequency/throttle traces",
            "sustained NPU workload transcript",
            "instrument calibration records",
        ),
        required_evidence_files=(
            EvidenceSpec(
                path=ROOT / "docs/evidence/android/eliza_ai_soc_cvd_hal_processes.txt",
                description="booted Android HAL process list includes power, power stats, thermal, health, and NPU services",
                required_tokens=(
                    "android.hardware.power-service",
                    "android.hardware.power.stats-service",
                    "android.hardware.thermal-service",
                    "android.hardware.health-service",
                    "android.hardware.neuralnetworks",
                ),
            ),
            EvidenceSpec(
                path=ROOT / "docs/evidence/android/power/sustained_npu_power_thermal_trace.json",
                description="calibrated sustained NPU workload power/thermal/frequency trace",
                json_expectations=(
                    ("status", "eq", "PASS"),
                    ("result", "eq", 0),
                    ("device.cpu_abi", "eq", "riscv64"),
                    ("workload.npu_sustained", "eq", True),
                    ("instrumentation.calibrated", "eq", True),
                    ("thermal.throttling_observed", "eq", False),
                ),
            ),
            EvidenceSpec(
                path=ROOT / "docs/evidence/android/eliza_ai_soc_e1_npu_hal_liveness.log",
                description="NPU HAL liveness probe completed on booted Android target",
                required_tokens=(
                    "eliza-evidence: status=PASS",
                    "RESULT=0",
                    "NNAPI_SERVICE=present",
                    "E1_NPU_ACCELERATOR=present",
                ),
                forbidden_tokens=("status=BLOCKED", "PROBE_ERROR", "adb unavailable"),
            ),
        ),
    ),
)


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def repo_rel(path: Path) -> str:
    try:
        return path.relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return str(path)


def repo_output_path(package_relative_path: str) -> str:
    if package_relative_path.startswith("/"):
        return package_relative_path
    return f"packages/chip/{package_relative_path}"


def pwd_repo_output_path(package_relative_path: str) -> str:
    if package_relative_path.startswith("/"):
        return package_relative_path
    return f"$(pwd)/{repo_output_path(package_relative_path)}"


ADB_TARGET_SELECTOR_COMMAND = (
    'test -n "$CHIP_ANDROID_ADB_SERIAL" || test -n "$CHIP_ANDROID_ADB_HOSTPORT"'
)
ADB_HOSTPORT_EXPORT_COMMAND = "export CHIP_ANDROID_ADB_HOSTPORT=<chip-emulator-adb-host:port>"
ADB_SERIAL_EXPORT_COMMAND = "export CHIP_ANDROID_ADB_SERIAL=<adb-serial>"


def peripheral_capture_commands(component: str) -> list[str]:
    return [
        ADB_TARGET_SELECTOR_COMMAND,
        ADB_HOSTPORT_EXPORT_COMMAND,
        (
            "python3 packages/chip/scripts/android/capture_simulated_peripheral_evidence.py "
            f'--adb-connect "$CHIP_ANDROID_ADB_HOSTPORT" {component}'
        ),
        ADB_SERIAL_EXPORT_COMMAND,
        (
            "python3 packages/chip/scripts/android/capture_simulated_peripheral_evidence.py "
            f'--adb-serial "$CHIP_ANDROID_ADB_SERIAL" {component}'
        ),
    ]


def evidence_capture_plan(path: Path) -> dict[str, Any]:
    """Return exact operator commands for collecting a required evidence file."""
    relative = rel(path)
    repo_relative = repo_rel(path)
    contract = live_capture_contract(relative)
    base = {
        "expected_output_files": [repo_relative],
        "release_credit": False,
        "prerequisites": [
            "run capture_commands from the repository root",
            "booted eliza_ai_soc Android target reachable over adb",
            "CHIP_ANDROID_ADB_HOSTPORT set for emulator targets or CHIP_ANDROID_ADB_SERIAL set for lab targets",
            "current staged system APK payload report generated",
        ],
        "validation_command": PHONE_RUNTIME_VALIDATION_COMMAND,
        "validation_commands": [PHONE_RUNTIME_VALIDATION_COMMAND],
        "repo_relative_expected_path": repo_relative,
        "package_relative_expected_path": relative,
        "expected_file_schema": contract.get(
            "expected_file_schema",
            "runtime evidence file satisfying required_tokens, forbidden_tokens, or json_expectations",
        ),
        "device_or_emulator_prerequisites": contract.get(
            "device_or_emulator_prerequisites",
            [
                "booted eliza_ai_soc Android target reachable over adb",
                "exactly one selected target through CHIP_ANDROID_ADB_HOSTPORT or CHIP_ANDROID_ADB_SERIAL",
            ],
        ),
        "fail_closed_validation_rule": contract.get(
            "fail_closed_validation_rule",
            "The runtime checker keeps this file blocked unless every required token/json expectation is present and no forbidden blocker token is present.",
        ),
        "capture_contract_manifest": contract.get(
            "capture_contract_manifest", rel(LIVE_CAPTURE_CONTRACT_MANIFEST)
        ),
    }
    adb_prefix = (
        "export CHIP_ANDROID_ADB_HOSTPORT=<chip-emulator-adb-host:port> && "
        'adb connect "$CHIP_ANDROID_ADB_HOSTPORT"'
    )
    plans: dict[str, dict[str, Any]] = {
        "docs/evidence/android/eliza_launcher_runtime_evidence.json": {
            **base,
            "expected_output_files": [
                "packages/chip/docs/evidence/android/eliza_launcher_runtime_evidence.json",
                "packages/chip/docs/evidence/android/eliza_launcher_runtime_logcat.txt",
                "packages/chip/docs/evidence/android/eliza_launcher_runtime_transcript.log",
            ],
            "capture_commands": [
                ADB_TARGET_SELECTOR_COMMAND,
                ADB_HOSTPORT_EXPORT_COMMAND,
                (
                    "python3 packages/chip/scripts/android/capture_launcher_runtime_evidence.py "
                    '--adb-connect "$CHIP_ANDROID_ADB_HOSTPORT" '
                    "--artifact-id android-chip-riscv64-zip "
                    "--target-label chip-riscv64 "
                    "--expected-cpu-abi riscv64 "
                    "--output $(pwd)/packages/chip/docs/evidence/android/eliza_launcher_runtime_evidence.json "
                    "--logcat $(pwd)/packages/chip/docs/evidence/android/eliza_launcher_runtime_logcat.txt "
                    "--transcript $(pwd)/packages/chip/docs/evidence/android/eliza_launcher_runtime_transcript.log"
                ),
                ADB_SERIAL_EXPORT_COMMAND,
                (
                    "python3 packages/chip/scripts/android/capture_launcher_runtime_evidence.py "
                    '--adb-serial "$CHIP_ANDROID_ADB_SERIAL" '
                    "--artifact-id android-chip-riscv64-zip "
                    "--target-label chip-riscv64 "
                    "--expected-cpu-abi riscv64 "
                    "--output $(pwd)/packages/chip/docs/evidence/android/eliza_launcher_runtime_evidence.json "
                    "--logcat $(pwd)/packages/chip/docs/evidence/android/eliza_launcher_runtime_logcat.txt "
                    "--transcript $(pwd)/packages/chip/docs/evidence/android/eliza_launcher_runtime_transcript.log"
                ),
                (
                    "python3 packages/chip/scripts/check_android_launcher_runtime_evidence.py "
                    "--expected-artifact-id android-chip-riscv64-zip "
                    "--expected-target-label chip-riscv64 "
                    "--expected-cpu-abi riscv64 "
                    "--evidence packages/chip/docs/evidence/android/eliza_launcher_runtime_evidence.json"
                ),
            ],
        },
        "docs/evidence/android/eliza_ai_soc_cvd_hal_processes.txt": {
            **base,
            "capture_commands": [
                ADB_TARGET_SELECTOR_COMMAND,
                adb_prefix,
                (
                    "mkdir -p packages/chip/docs/evidence/android && "
                    'adb -s "$CHIP_ANDROID_ADB_HOSTPORT" shell ps -A '
                    "| tee packages/chip/docs/evidence/android/eliza_ai_soc_cvd_hal_processes.txt"
                ),
                ADB_SERIAL_EXPORT_COMMAND,
                (
                    "mkdir -p packages/chip/docs/evidence/android && "
                    'adb -s "$CHIP_ANDROID_ADB_SERIAL" shell ps -A '
                    "| tee packages/chip/docs/evidence/android/eliza_ai_soc_cvd_hal_processes.txt"
                ),
            ],
        },
        "docs/evidence/android/peripherals/rear_camera_sim.log": {
            **base,
            "capture_commands": peripheral_capture_commands("rear_camera"),
        },
        "docs/evidence/android/peripherals/front_camera_sim.log": {
            **base,
            "capture_commands": peripheral_capture_commands("front_camera"),
        },
        "docs/evidence/android/peripherals/wifi_sim.log": {
            **base,
            "capture_commands": peripheral_capture_commands("wifi"),
        },
        "docs/evidence/android/peripherals/bluetooth_sim.log": {
            **base,
            "capture_commands": peripheral_capture_commands("bluetooth"),
        },
        "docs/evidence/android/peripherals/cellular_5g_lte_sim.log": {
            **base,
            "capture_commands": peripheral_capture_commands("cellular_5g_lte"),
        },
        "docs/evidence/android/security/verified_boot_acceptance.log": {
            **base,
            "capture_commands": [
                ADB_TARGET_SELECTOR_COMMAND,
                adb_prefix,
                (
                    "mkdir -p packages/chip/docs/evidence/android/security && "
                    'state=$(adb -s "$CHIP_ANDROID_ADB_HOSTPORT" shell getprop '
                    "ro.boot.verifiedbootstate | tr -d '\\r') && "
                    'if [ "$state" = green ]; then result=0; verdict=pass; '
                    "else result=1; verdict=fail; fi; "
                    "printf 'VERIFIED_BOOT=%s\\nSTATE=%s\\nRESULT=%s\\n' "
                    '"$verdict" "$state" "$result" | tee '
                    "packages/chip/docs/evidence/android/security/verified_boot_acceptance.log; "
                    'test "$result" = 0'
                ),
                ADB_SERIAL_EXPORT_COMMAND,
                (
                    "mkdir -p packages/chip/docs/evidence/android/security && "
                    'state=$(adb -s "$CHIP_ANDROID_ADB_SERIAL" shell getprop '
                    "ro.boot.verifiedbootstate | tr -d '\\r') && "
                    'if [ "$state" = green ]; then result=0; verdict=pass; '
                    "else result=1; verdict=fail; fi; "
                    "printf 'VERIFIED_BOOT=%s\\nSTATE=%s\\nRESULT=%s\\n' "
                    '"$verdict" "$state" "$result" | tee '
                    "packages/chip/docs/evidence/android/security/verified_boot_acceptance.log; "
                    'test "$result" = 0'
                ),
            ],
        },
        "docs/evidence/android/security/tampered_boot_rejection.log": {
            **base,
            "prerequisites": [
                "bench or emulator flow can flash a deliberately tampered boot image",
                "production verified-boot key policy is enabled",
                "operator command exits RESULT=0 only when the target rejects the image",
            ],
            "capture_commands": [
                'test -n "$ELIZA_TAMPERED_BOOT_REJECTION_COMMAND"',
                (
                    "mkdir -p packages/chip/docs/evidence/android/security && "
                    'sh -c "$ELIZA_TAMPERED_BOOT_REJECTION_COMMAND" '
                    "| tee packages/chip/docs/evidence/android/security/tampered_boot_rejection.log"
                ),
            ],
        },
        "docs/evidence/android/security/rollback_rejection.log": {
            **base,
            "prerequisites": [
                "bench or emulator flow can flash an older rollback-index image",
                "rollback index storage/policy is enabled",
                "operator command exits RESULT=0 only when rollback is rejected",
            ],
            "capture_commands": [
                'test -n "$ELIZA_ROLLBACK_REJECTION_COMMAND"',
                (
                    "mkdir -p packages/chip/docs/evidence/android/security && "
                    'sh -c "$ELIZA_ROLLBACK_REJECTION_COMMAND" '
                    "| tee packages/chip/docs/evidence/android/security/rollback_rejection.log"
                ),
            ],
        },
        "docs/evidence/android/security/debug_lock_key_provisioning.log": {
            **base,
            "prerequisites": [
                "production debug-lock state is provisioned on the target",
                "production key material/provisioning transcript source is available",
                "operator command emits DEBUG_LOCKED=pass, PRODUCTION_KEYS=pass, and RESULT=0 only for production state",
            ],
            "capture_commands": [
                'test -n "$ELIZA_DEBUG_LOCK_KEY_PROVISIONING_COMMAND"',
                (
                    "mkdir -p packages/chip/docs/evidence/android/security && "
                    'sh -c "$ELIZA_DEBUG_LOCK_KEY_PROVISIONING_COMMAND" '
                    "| tee packages/chip/docs/evidence/android/security/debug_lock_key_provisioning.log"
                ),
            ],
        },
        "docs/evidence/android/power/sustained_npu_power_thermal_trace.json": {
            **base,
            "prerequisites": [
                "calibrated VDDCORE/VDDIO power instrumentation attached",
                "thermal and frequency telemetry readable during the run",
                "sustained NPU workload available on the booted target",
            ],
            "capture_commands": [
                'test -n "$ELIZA_CALIBRATED_POWER_THERMAL_CAPTURE_COMMAND"',
                (
                    "mkdir -p packages/chip/docs/evidence/android/power && "
                    'sh -c "$ELIZA_CALIBRATED_POWER_THERMAL_CAPTURE_COMMAND '
                    '--output packages/chip/docs/evidence/android/power/sustained_npu_power_thermal_trace.json"'
                ),
            ],
        },
        "docs/evidence/android/eliza_ai_soc_e1_npu_hal_liveness.log": {
            **base,
            "capture_commands": [
                ADB_TARGET_SELECTOR_COMMAND,
                ADB_HOSTPORT_EXPORT_COMMAND,
                (
                    "python3 packages/chip/scripts/android/capture_e1_npu_hal_liveness.py "
                    '--adb-connect "$CHIP_ANDROID_ADB_HOSTPORT" '
                    "--output $(pwd)/packages/chip/docs/evidence/android/eliza_ai_soc_e1_npu_hal_liveness.log"
                ),
                ADB_SERIAL_EXPORT_COMMAND,
                (
                    "python3 packages/chip/scripts/android/capture_e1_npu_hal_liveness.py "
                    '--adb-serial "$CHIP_ANDROID_ADB_SERIAL" '
                    "--output $(pwd)/packages/chip/docs/evidence/android/eliza_ai_soc_e1_npu_hal_liveness.log"
                ),
            ],
        },
    }
    return plans.get(
        relative,
        {
            **base,
            "capture_commands": [
                (
                    "Generate the planned runtime evidence artifact at "
                    f"{relative} using the owning capture flow, then rerun "
                    f"{PHONE_RUNTIME_VALIDATION_COMMAND}"
                )
            ],
        },
    )


def live_capture_contract(relative_path: str) -> dict[str, Any]:
    manifest = load_json_file(LIVE_CAPTURE_CONTRACT_MANIFEST)
    contracts = manifest.get("live_capture_contracts")
    if not isinstance(contracts, list):
        return {}
    for contract in contracts:
        if not isinstance(contract, dict):
            continue
        if contract.get("expected_path") not in {
            relative_path,
            repo_output_path(relative_path),
        }:
            continue
        return {
            **contract,
            "capture_contract_manifest": rel(LIVE_CAPTURE_CONTRACT_MANIFEST),
            "release_credit": False,
        }
    return {}


def prioritized_runtime_capture_plan() -> list[dict[str, Any]]:
    """Operator-facing live evidence plan. This is not release evidence itself."""
    plan: list[dict[str, Any]] = []
    scope_priority = {
        "phone_media_pipeline": 40,
        "radio_sensor_pmic": 50,
        "security_lifecycle": 60,
        "power_thermal": 70,
    }
    for spec in SCOPES:
        expected_files: list[str] = []
        commands: list[str] = []
        prerequisites: list[str] = []
        validation_commands = {
            "python3 packages/chip/scripts/check_phone_runtime_readiness_contract.py"
        }
        for evidence_spec in spec.required_evidence_files:
            capture = evidence_capture_plan(evidence_spec.path)
            expected_files.extend(str(path) for path in capture["expected_output_files"])
            commands.extend(str(command) for command in capture.get("capture_commands", []))
            prerequisites.extend(str(item) for item in capture.get("prerequisites", []))
            validation_commands.update(
                str(command) for command in capture.get("validation_commands", [])
            )
        plan.append(
            {
                "priority": scope_priority.get(spec.name, 99),
                "capture_area": spec.name,
                "runtime_surface": spec.runtime_surface,
                "release_credit": False,
                "prerequisites": sorted(set(prerequisites)),
                "expected_output_files": sorted(set(expected_files)),
                "capture_commands": list(dict.fromkeys(commands)),
                "validation_commands": sorted(validation_commands),
                "required_runtime_evidence": list(spec.required_runtime_evidence),
            }
        )
    return sorted(plan, key=lambda row: row["priority"])


def scope_report_summary(report: dict[str, Any]) -> str:
    status = report.get("status")
    summary = report.get("summary", {})
    allowed = summary.get("release_claim_allowed") if isinstance(summary, dict) else None
    return f"status={status!r} release_claim_allowed={allowed!r}"


def json_value(data: Any, dotted_path: str) -> Any:
    if not dotted_path:
        return data
    if not isinstance(data, dict):
        return None
    if dotted_path in data:
        return data[dotted_path]
    parts = dotted_path.split(".")
    for index in range(1, len(parts) + 1):
        key = ".".join(parts[:index])
        if key in data:
            return json_value(data[key], ".".join(parts[index:]))
    return None


def expectation_passes(actual: Any, op: str, expected: Any) -> bool:
    if op == "eq":
        return actual == expected
    if op == "contains":
        if isinstance(actual, list):
            return expected in actual
        return expected in str(actual)
    if op == "gt":
        try:
            return float(actual) > float(expected)
        except (TypeError, ValueError):
            return False
    raise ValueError(f"unsupported evidence expectation operator: {op}")


def load_json_file(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def planned_evidence_template(path: Path) -> dict[str, Any] | None:
    manifest = load_json_file(PLANNED_EVIDENCE_TEMPLATE_MANIFEST)
    templates = manifest.get("planned_evidence_templates")
    if not isinstance(templates, list):
        return None
    relative = rel(path)
    for template in templates:
        if not isinstance(template, dict):
            continue
        if template.get("expected_path") == relative:
            return {
                **template,
                "template_manifest": rel(PLANNED_EVIDENCE_TEMPLATE_MANIFEST),
                "release_credit": False,
            }
    return None


def expected_android_payload_package() -> str:
    report = load_json_file(ANDROID_APK_PAYLOAD_REPORT)
    evidence = report.get("evidence")
    if not isinstance(evidence, dict):
        return "ai.elizaos.app"
    for key in ("provenance_android_package", "vendor_ro_elizaos_home", "expected_package"):
        value = evidence.get(key)
        if isinstance(value, str) and value:
            return value
    return "ai.elizaos.app"


def resolve_expected_value(expected: Any) -> Any:
    if expected == ANDROID_PAYLOAD_PACKAGE_SENTINEL:
        return expected_android_payload_package()
    return expected


def resolved_json_expectations(spec: EvidenceSpec) -> list[dict[str, Any]]:
    return [
        {"path": path, "op": op, "expected": resolve_expected_value(expected)}
        for path, op, expected in spec.json_expectations
    ]


def validate_evidence_spec(spec: EvidenceSpec) -> list[str]:
    errors: list[str] = []
    if not spec.path.exists():
        template = planned_evidence_template(spec.path)
        if template is not None:
            return [
                (
                    f"{rel(spec.path)} has planned-incomplete template "
                    f"{rel(PLANNED_EVIDENCE_TEMPLATE_MANIFEST)} ({spec.description})"
                )
            ]
        return [f"{rel(spec.path)} missing ({spec.description})"]

    text = spec.path.read_text(encoding="utf-8", errors="replace")
    for token in spec.required_tokens:
        if token not in text:
            errors.append(f"{rel(spec.path)} missing token {token!r}")
    for token in spec.forbidden_tokens:
        if token in text:
            errors.append(f"{rel(spec.path)} contains forbidden token {token!r}")

    if spec.json_expectations:
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            errors.append(f"{rel(spec.path)} is not valid JSON: {exc}")
            return errors
        for dotted_path, op, expected in spec.json_expectations:
            expected = resolve_expected_value(expected)
            actual = json_value(data, dotted_path)
            if not expectation_passes(actual, op, expected):
                errors.append(
                    f"{rel(spec.path)} expected {dotted_path} {op} {expected!r}, got {actual!r}"
                )
    return errors


def evidence_blocker_class(spec: EvidenceSpec, errors: list[str]) -> str | None:
    if not errors:
        return None
    live_contract = live_capture_contract(rel(spec.path))
    if live_contract.get("capture_commands"):
        return LIVE_CAPTURE_UNAVAILABLE
    if not spec.path.exists() and planned_evidence_template(spec.path) is not None:
        return PLANNED_EVIDENCE_INCOMPLETE
    if not spec.path.exists():
        return PLANNED_EVIDENCE_MISSING
    text = spec.path.read_text(encoding="utf-8", errors="replace")
    if any(token in text for token in LIVE_CAPTURE_UNAVAILABLE_TOKENS):
        return LIVE_CAPTURE_UNAVAILABLE
    if any("got 'adb:" in error or "got ['adb:" in error for error in errors):
        return LIVE_CAPTURE_UNAVAILABLE
    return PLANNED_EVIDENCE_INCOMPLETE


def evidence_blocker_label(blocker_class: str | None) -> str:
    labels = {
        LIVE_CAPTURE_UNAVAILABLE: "live capture unavailable",
        PLANNED_EVIDENCE_MISSING: "planned evidence artifact missing",
        PLANNED_EVIDENCE_INCOMPLETE: "planned evidence artifact incomplete",
    }
    return labels.get(blocker_class or "", "not blocked")


def evidence_blocker_category(
    spec: EvidenceSpec, errors: list[str], blocker_class: str | None
) -> str | None:
    if not errors:
        return None
    if blocker_class == LIVE_CAPTURE_UNAVAILABLE:
        return LIVE_DEVICE_VALIDATION
    if blocker_class == PLANNED_EVIDENCE_MISSING:
        return PLANNED_MISSING_EVIDENCE
    if blocker_class == PLANNED_EVIDENCE_INCOMPLETE:
        return PLANNED_INCOMPLETE_EVIDENCE
    return PLANNED_INCOMPLETE_EVIDENCE


def evidence_blocker_category_label(blocker_category: str | None) -> str:
    labels = {
        LIVE_DEVICE_VALIDATION: "live-device validation",
        PLANNED_MISSING_EVIDENCE: "planned missing evidence",
        PLANNED_INCOMPLETE_EVIDENCE: "planned incomplete evidence",
        REPO_ARTIFACT_GENERATION: "repo artifact generation",
    }
    return labels.get(blocker_category or "", "not blocked")


def validate_runtime_evidence(spec: ScopeSpec) -> tuple[list[str], list[dict[str, Any]]]:
    errors: list[str] = []
    records: list[dict[str, Any]] = []
    for evidence_spec in spec.required_evidence_files:
        spec_errors = validate_evidence_spec(evidence_spec)
        blocker_class = evidence_blocker_class(evidence_spec, spec_errors)
        blocker_category = evidence_blocker_category(evidence_spec, spec_errors, blocker_class)
        errors.extend(spec_errors)
        records.append(
            {
                "path": rel(evidence_spec.path),
                "description": evidence_spec.description,
                "required_tokens": list(evidence_spec.required_tokens),
                "forbidden_tokens": list(evidence_spec.forbidden_tokens),
                "json_expectations": resolved_json_expectations(evidence_spec),
                "status": "pass" if not spec_errors else "blocked",
                "blocker_class": blocker_class,
                "blocker_label": evidence_blocker_label(blocker_class),
                "blocker_category": blocker_category,
                "blocker_category_label": evidence_blocker_category_label(blocker_category),
                "errors": spec_errors,
                "planned_evidence_template": planned_evidence_template(evidence_spec.path),
                **evidence_capture_plan(evidence_spec.path),
            }
        )
    return errors, records


def runtime_evidence_collection_inventory(evidence: dict[str, Any]) -> list[dict[str, Any]]:
    inventory: list[dict[str, Any]] = []
    scopes = evidence.get("scopes")
    if not isinstance(scopes, dict):
        return inventory
    for spec in SCOPES:
        scope_evidence = scopes.get(spec.name)
        if not isinstance(scope_evidence, dict):
            continue
        runtime_files = scope_evidence.get("runtime_evidence_files")
        if not isinstance(runtime_files, list):
            runtime_files = []
        blocked_files = [
            record
            for record in runtime_files
            if isinstance(record, dict) and record.get("status") != "pass"
        ]
        if not blocked_files and scope_evidence.get("status") == spec.required_status:
            continue
        inventory.append(
            {
                "scope": spec.name,
                "runtime_surface": spec.runtime_surface,
                "release_credit": False,
                "required_runtime_evidence": list(spec.required_runtime_evidence),
                "required_status": spec.required_status,
                "current_status": scope_evidence.get("status"),
                "blocked_evidence_files": [
                    {
                        "path": record.get("path"),
                        "description": record.get("description"),
                        "blocker_class": record.get("blocker_class"),
                        "blocker_label": record.get("blocker_label"),
                        "blocker_category": record.get("blocker_category"),
                        "blocker_category_label": record.get("blocker_category_label"),
                        "errors": record.get("errors", []),
                        "json_expectations": record.get("json_expectations", []),
                        "required_tokens": record.get("required_tokens", []),
                        "forbidden_tokens": record.get("forbidden_tokens", []),
                        "planned_evidence_template": record.get("planned_evidence_template"),
                        "prerequisites": record.get("prerequisites", []),
                        "device_or_emulator_prerequisites": record.get(
                            "device_or_emulator_prerequisites", []
                        ),
                        "expected_file_schema": record.get("expected_file_schema"),
                        "fail_closed_validation_rule": record.get("fail_closed_validation_rule"),
                        "capture_contract_manifest": record.get("capture_contract_manifest"),
                        "expected_output_files": record.get("expected_output_files", []),
                        "repo_relative_expected_path": record.get("repo_relative_expected_path"),
                        "package_relative_expected_path": record.get(
                            "package_relative_expected_path"
                        ),
                        "capture_commands": record.get("capture_commands", []),
                        "validation_command": record.get("validation_command"),
                        "validation_commands": record.get("validation_commands", []),
                        "release_credit": False,
                    }
                    for record in blocked_files
                ],
                "blocked_evidence_file_count": len(blocked_files),
                "blocked_evidence_class_counts": count_blocker_classes(blocked_files),
                "blocked_evidence_category_counts": count_blocker_categories(blocked_files),
                "next_artifacts": sorted(
                    {
                        path
                        for record in blocked_files
                        for path in record.get("expected_output_files", [])
                        if isinstance(path, str)
                    }
                ),
                "next_commands": sorted(
                    {
                        command
                        for record in blocked_files
                        for command in record.get("capture_commands", [])
                        if isinstance(command, str)
                    }
                )
                + [
                    "python3 packages/chip/scripts/check_android_release_readiness_contract.py",
                    PHONE_RUNTIME_VALIDATION_COMMAND,
                    PHONE_RUNTIME_AGGREGATE_COMMAND,
                ],
                "next_command_batches": next_command_batches(blocked_files),
            }
        )
    return inventory


def count_blocker_classes(records: list[dict[str, Any]]) -> dict[str, int]:
    counts = {
        LIVE_CAPTURE_UNAVAILABLE: 0,
        PLANNED_EVIDENCE_MISSING: 0,
        PLANNED_EVIDENCE_INCOMPLETE: 0,
    }
    for record in records:
        blocker_class = record.get("blocker_class")
        if blocker_class in counts:
            counts[blocker_class] += 1
    return counts


def count_blocker_categories(records: list[dict[str, Any]]) -> dict[str, int]:
    counts = {
        LIVE_DEVICE_VALIDATION: 0,
        PLANNED_MISSING_EVIDENCE: 0,
        PLANNED_INCOMPLETE_EVIDENCE: 0,
        REPO_ARTIFACT_GENERATION: 0,
    }
    for record in records:
        category = record.get("blocker_category")
        if category in counts:
            counts[category] += 1
    return counts


def next_command_batches(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return ordered, per-artifact operator command batches.

    ``next_commands`` remains a flat compatibility field, but operators need to
    know which commands belong to which missing/blocking artifact and in what
    order to run them. These batches are plan metadata only; they are not
    evidence that a target booted or passed.
    """
    batches: list[dict[str, Any]] = []
    for record in records:
        if not isinstance(record, dict):
            continue
        commands = [
            str(command)
            for command in record.get("capture_commands", [])
            if isinstance(command, str)
        ]
        validation_commands = [
            str(command)
            for command in record.get("validation_commands", [])
            if isinstance(command, str)
        ]
        if not commands and not validation_commands:
            continue
        batches.append(
            {
                "artifact": record.get("repo_relative_expected_path") or record.get("path"),
                "package_relative_artifact": record.get("package_relative_expected_path")
                or record.get("path"),
                "description": record.get("description"),
                "blocker_class": record.get("blocker_class"),
                "blocker_category": record.get("blocker_category"),
                "release_credit": False,
                "expected_output_files": record.get("expected_output_files", []),
                "capture_commands": commands,
                "validation_commands": validation_commands,
                "claim_boundary": "operator_command_batch_only_not_runtime_evidence",
            }
        )
    return batches


def runtime_capture_area_groups(
    collection_inventory: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    groups: list[dict[str, Any]] = []
    priority_by_area = {
        row["capture_area"]: row["priority"] for row in prioritized_runtime_capture_plan()
    }
    for scope_record in collection_inventory:
        blocked_files = [
            record
            for record in scope_record.get("blocked_evidence_files", [])
            if isinstance(record, dict)
        ]
        capture_commands: list[str] = []
        expected_files: list[str] = []
        for record in blocked_files:
            capture_commands.extend(str(command) for command in record.get("capture_commands", []))
            expected_files.extend(str(path) for path in record.get("expected_output_files", []))
        command_batches = next_command_batches(blocked_files)
        groups.append(
            {
                "capture_area": scope_record.get("scope"),
                "priority": priority_by_area.get(str(scope_record.get("scope")), 99),
                "runtime_surface": scope_record.get("runtime_surface"),
                "release_credit": False,
                "blocked_evidence_file_count": len(blocked_files),
                "blocked_evidence_class_counts": count_blocker_classes(blocked_files),
                "blocked_evidence_category_counts": count_blocker_categories(blocked_files),
                "next_artifacts": sorted(set(expected_files)),
                "next_commands": list(dict.fromkeys(capture_commands))
                + [PHONE_RUNTIME_VALIDATION_COMMAND, PHONE_RUNTIME_AGGREGATE_COMMAND],
                "next_command_batches": command_batches,
            }
        )
    return sorted(groups, key=lambda row: row["priority"])


def next_runtime_capture_action(
    capture_area_groups: list[dict[str, Any]],
) -> dict[str, Any] | None:
    """Return the first operator action needed to move live runtime evidence."""
    if not capture_area_groups:
        return None
    group = capture_area_groups[0]
    return {
        "capture_area": group.get("capture_area"),
        "priority": group.get("priority"),
        "runtime_surface": group.get("runtime_surface"),
        "release_credit": False,
        "blocked_evidence_file_count": group.get("blocked_evidence_file_count", 0),
        "blocked_evidence_class_counts": group.get("blocked_evidence_class_counts", {}),
        "blocked_evidence_category_counts": group.get("blocked_evidence_category_counts", {}),
        "next_artifacts": group.get("next_artifacts", []),
        "next_commands": group.get("next_commands", []),
        "next_command_batches": group.get("next_command_batches", []),
        "validation_commands": [
            PHONE_RUNTIME_VALIDATION_COMMAND,
            PHONE_RUNTIME_AGGREGATE_COMMAND,
        ],
        "claim_boundary": "operator_capture_action_only_not_runtime_release_evidence",
    }


def report_next_command_plan(
    capture_area_groups: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Return aggregate-friendly command batches for runtime evidence capture."""
    plan: list[dict[str, Any]] = []
    for group in capture_area_groups:
        commands = [
            command for command in group.get("next_commands", []) if isinstance(command, str)
        ]
        if not commands:
            continue
        capture_area = str(group.get("capture_area") or "phone_runtime")
        plan.append(
            {
                "id": f"capture_{capture_area}_phone_runtime_evidence",
                "area": "runtime",
                "capture_area": capture_area,
                "source": "packages/chip/build/reports/phone_runtime_readiness_contract.json",
                "claim_boundary": "operator_commands_only_not_phone_runtime_or_release_evidence",
                "commands": commands,
                "expected_output_files": group.get("next_artifacts", []),
                "next_command_batches": group.get("next_command_batches", []),
                "requires": [
                    "booted eliza_ai_soc Android target reachable over adb",
                    "CHIP_ANDROID_ADB_HOSTPORT set for emulator targets or CHIP_ANDROID_ADB_SERIAL set for lab targets",
                    "fresh runtime evidence files matching the fail-closed contracts",
                    "rerun of phone runtime readiness and aggregate tapeout checks",
                ],
            }
        )
    return plan


def finding_capture_area(finding: Finding) -> str | None:
    for suffix in (
        "_runtime_evidence_incomplete",
        "_runtime_surface_blocked",
        "_scope_report_invalid",
    ):
        if finding.code.endswith(suffix):
            return finding.code[: -len(suffix)]
    return None


def finding_commands(
    finding: Finding,
    capture_area_groups: list[dict[str, Any]],
) -> list[str]:
    capture_area = finding_capture_area(finding)
    if not capture_area:
        return []
    for group in capture_area_groups:
        if group.get("capture_area") != capture_area:
            continue
        commands: list[str] = []
        for batch in group.get("next_command_batches", []):
            if not isinstance(batch, dict):
                continue
            commands.extend(
                command
                for command in batch.get("capture_commands", [])
                if isinstance(command, str) and command
            )
            commands.extend(
                command
                for command in batch.get("validation_commands", [])
                if isinstance(command, str) and command
            )
        commands.extend(
            command for command in group.get("next_commands", []) if isinstance(command, str)
        )
        return list(dict.fromkeys(commands))
    return []


def is_setup_only_command(command: str) -> bool:
    stripped = command.strip()
    return stripped.startswith("export ") or stripped.startswith("adb connect ")


def is_validation_only_command(command: str) -> bool:
    return command in {PHONE_RUNTIME_VALIDATION_COMMAND, PHONE_RUNTIME_AGGREGATE_COMMAND}


def is_capture_action_command(command: str) -> bool:
    return (
        "packages/chip/scripts/android/capture_" in command
        or 'sh -c "$ELIZA_' in command
        or "| tee packages/chip/docs/evidence/" in command
    )


def preferred_finding_command(commands: list[str]) -> str:
    return next(
        (
            command
            for command in commands
            if is_capture_action_command(command)
            and not is_setup_only_command(command)
            and not is_validation_only_command(command)
        ),
        commands[0],
    )


def finding_payload(
    finding: Finding,
    capture_area_groups: list[dict[str, Any]],
) -> dict[str, Any]:
    row = asdict(finding)
    commands = finding_commands(finding, capture_area_groups)
    if commands:
        row["next_command"] = preferred_finding_command(commands)
        row["next_commands"] = commands
    return row


def run_check(args: argparse.Namespace) -> dict[str, Any]:
    del args
    findings: list[Finding] = []
    evidence: dict[str, Any] = {"scopes": {}}
    for spec in SCOPES:
        report = spec.report_builder()
        errors = spec.validator(report)
        evidence["scopes"][spec.name] = {
            "status": report.get("status"),
            "summary": report.get("summary"),
            "claim_boundary": report.get("claim_boundary"),
            "required_runtime_evidence": list(spec.required_runtime_evidence),
        }
        evidence_errors, evidence_records = validate_runtime_evidence(spec)
        evidence["scopes"][spec.name]["runtime_evidence_files"] = evidence_records
        if errors:
            findings.append(
                Finding(
                    f"{spec.name}_scope_report_invalid",
                    "failure",
                    "phone runtime scope report failed its structural validation",
                    "; ".join(errors),
                    "Fix the underlying scope report before using it as readiness evidence.",
                )
            )
            continue
        if evidence_errors:
            findings.append(
                Finding(
                    f"{spec.name}_runtime_evidence_incomplete",
                    "blocker",
                    f"{spec.runtime_surface} lack complete machine-checkable runtime evidence",
                    "; ".join(evidence_errors),
                    "Capture fresh booted-target evidence for: "
                    + "; ".join(spec.required_runtime_evidence),
                )
            )
        summary = report.get("summary", {})
        release_allowed = (
            summary.get("release_claim_allowed") if isinstance(summary, dict) else None
        )
        if report.get("status") != spec.required_status or release_allowed is not True:
            findings.append(
                Finding(
                    f"{spec.name}_runtime_surface_blocked",
                    "blocker",
                    f"{spec.runtime_surface} are not runtime-ready for the chip/OS objective",
                    scope_report_summary(report),
                    "Capture real runtime evidence: " + "; ".join(spec.required_runtime_evidence),
                )
            )
    return payload(findings, evidence)


def payload(findings: list[Finding], evidence: dict[str, Any]) -> dict[str, Any]:
    failures = [finding for finding in findings if finding.severity == "failure"]
    blockers = [finding for finding in findings if finding.severity == "blocker"]
    blocker_dependency_counts: dict[str, int] = {
        "repo_artifact_generation": 0,
        "live_device_validation": 0,
        "actionable_external_dependency": 0,
    }
    for finding in blockers:
        if finding.blocker_dependency in blocker_dependency_counts:
            blocker_dependency_counts[finding.blocker_dependency] += 1
    if failures:
        status = "fail"
    elif blockers:
        status = "blocked"
    else:
        status = "pass"
    capture_plan = prioritized_runtime_capture_plan()
    collection_inventory = runtime_evidence_collection_inventory(evidence)
    capture_area_groups = runtime_capture_area_groups(collection_inventory)
    next_capture_action = next_runtime_capture_action(capture_area_groups)
    next_command_plan = report_next_command_plan(capture_area_groups)
    blocked_runtime_files = [
        file_record
        for scope_record in collection_inventory
        for file_record in scope_record.get("blocked_evidence_files", [])
        if isinstance(file_record, dict)
    ]
    blocked_file_class_counts = count_blocker_classes(blocked_runtime_files)
    blocked_file_category_counts = count_blocker_categories(blocked_runtime_files)
    highest_priority_capture_area = capture_plan[0]["capture_area"] if capture_plan else None
    return {
        "schema": SCHEMA,
        "generated_utc": utc_now(),
        "status": status,
        "claim_boundary": CLAIM_BOUNDARY,
        **FALSE_CLAIM_FLAGS,
        "summary": {
            "failures": len(failures),
            "blockers": len(blockers),
            "findings": len(findings),
            "blocker_dependency_counts": blocker_dependency_counts,
            "runtime_capture_plan_count": len(capture_plan),
            "next_command_batch_count": len(next_command_plan),
            "runtime_evidence_collection_scope_count": len(collection_inventory),
            "blocked_runtime_evidence_file_count": len(blocked_runtime_files),
            "live_capture_unavailable_file_count": blocked_file_class_counts[
                LIVE_CAPTURE_UNAVAILABLE
            ],
            "planned_evidence_missing_file_count": blocked_file_class_counts[
                PLANNED_EVIDENCE_MISSING
            ],
            "planned_evidence_incomplete_file_count": blocked_file_class_counts[
                PLANNED_EVIDENCE_INCOMPLETE
            ],
            "live_device_validation_file_count": blocked_file_category_counts[
                LIVE_DEVICE_VALIDATION
            ],
            "planned_missing_evidence_file_count": blocked_file_category_counts[
                PLANNED_MISSING_EVIDENCE
            ],
            "planned_incomplete_evidence_file_count": blocked_file_category_counts[
                PLANNED_INCOMPLETE_EVIDENCE
            ],
            "repo_artifact_generation_file_count": blocked_file_category_counts[
                REPO_ARTIFACT_GENERATION
            ],
            "highest_priority_capture_area": highest_priority_capture_area,
            "next_runtime_capture_area": (
                next_capture_action.get("capture_area") if next_capture_action else None
            ),
            "next_runtime_capture_blocked_file_count": (
                next_capture_action.get("blocked_evidence_file_count") if next_capture_action else 0
            ),
        },
        "findings": [finding_payload(finding, capture_area_groups) for finding in findings],
        "evidence": evidence,
        "prioritized_runtime_capture_plan": capture_plan,
        "runtime_capture_area_groups": capture_area_groups,
        "next_command_plan": next_command_plan,
        "next_runtime_capture_action": next_capture_action,
        "runtime_evidence_collection_inventory": collection_inventory,
    }


def write_report(report: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def print_summary(report: dict[str, Any]) -> None:
    print(f"STATUS: {str(report['status']).upper()} phone.runtime_readiness_contract")
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
    if report["status"] == "pass":
        return 0
    if report["status"] == "blocked":
        return 2
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
