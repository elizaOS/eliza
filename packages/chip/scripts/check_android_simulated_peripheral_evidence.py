#!/usr/bin/env python3
"""Static Android simulated-peripheral evidence gate.

Interactive AOSP readiness requires the phone-facing surfaces to work after
boot, not just a kernel/userspace boot marker. This gate validates the
archived simulated peripheral logs required by the AOSP completion checklist
and catches source-tree contradictions that would make those logs impossible
to produce on the current product.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
GATE_YAML = ROOT / "docs/project/aosp-simulator-completion-gate.yaml"
LAUNCH_CVD = ROOT / "sw/aosp-device/launch-cuttlefish-riscv64.sh"
ELIZA_AI_SOC_README = ROOT / "sw/aosp-device/device/eliza/eliza_ai_soc/README.md"
CUTTLEFISH_E1_README = ROOT / "sw/aosp-device/device/eliza/cuttlefish_e1/README.md"
REPORT = ROOT / "build/reports/android_simulated_peripheral_evidence.json"

SCHEMA = "eliza.android_simulated_peripheral_evidence.v1"
CLAIM_BOUNDARY = "static_android_simulated_peripheral_evidence_only_not_live_runtime"
FALSE_CLAIM_FLAGS = {
    "phone_claim_allowed": False,
    "release_claim_allowed": False,
    "live_runtime_claim_allowed": False,
    "android_boot_claim_allowed": False,
    "launcher_runtime_claim_allowed": False,
    "hardware_boot_claim_allowed": False,
    "cts_vts_claim_allowed": False,
    "gms_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}
CAPTURE_SCRIPT = "packages/chip/scripts/android/capture_simulated_peripheral_evidence.py"
RECHECK_COMMAND = (
    "python3 packages/chip/scripts/check_android_simulated_peripheral_evidence.py --json-only"
)
ADB_CONNECT_CANDIDATES = ("127.0.0.1:6520", "127.0.0.1:5555")
REQUIRED_COMPONENTS = {
    "rear_camera",
    "front_camera",
    "microphone",
    "speakers",
    "wifi",
    "bluetooth",
    "cellular_5g_lte",
}
REQUIRED_LOG_PROVENANCE = (
    "eliza-evidence: target=android_simulated_peripheral component=",
    "eliza-evidence: claim_boundary=adb-backed Android simulator peripheral evidence only",
    "eliza-evidence: command_env=",
    "eliza-evidence: command_source=default",
    "eliza-evidence: command=",
    "eliza-evidence: started_utc=",
    "COMMAND_OUTPUT_BEGIN",
    "ADB_PREP_BEGIN",
    "COMMAND_OUTPUT_END",
    "eliza-evidence: ended_utc=",
)
CANONICAL_PROBES = {
    "rear_camera": "sw/aosp-device/peripherals/probe-rear-camera.sh",
    "front_camera": "sw/aosp-device/peripherals/probe-front-camera.sh",
    "microphone": "sw/aosp-device/peripherals/probe-microphone.sh",
    "speakers": "sw/aosp-device/peripherals/probe-speakers.sh",
    "wifi": "sw/aosp-device/peripherals/probe-wifi.sh",
    "bluetooth": "sw/aosp-device/peripherals/probe-bluetooth.sh",
    "cellular_5g_lte": "sw/aosp-device/peripherals/probe-cellular-5g.sh",
}


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


@dataclass(frozen=True)
class Finding:
    code: str
    severity: str
    message: str
    evidence: str
    next_step: str
    blocker_dependency: str = "live_device_validation"


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def add_if(
    findings: list[Finding],
    condition: bool,
    code: str,
    message: str,
    evidence: str,
    next_step: str,
    blocker_dependency: str = "live_device_validation",
) -> None:
    if condition:
        findings.append(Finding(code, "blocker", message, evidence, next_step, blocker_dependency))


def load_gate(findings: list[Finding]) -> dict[str, Any]:
    if not GATE_YAML.is_file():
        findings.append(
            Finding(
                "missing_aosp_completion_gate",
                "blocker",
                "AOSP completion gate YAML is missing",
                rel(GATE_YAML),
                "Restore the completion checklist before evaluating Android phone-surface evidence.",
            )
        )
        return {}
    try:
        data = yaml.safe_load(read_text(GATE_YAML))
    except yaml.YAMLError as exc:
        findings.append(
            Finding(
                "invalid_aosp_completion_gate_yaml",
                "blocker",
                "AOSP completion gate YAML is invalid",
                f"{rel(GATE_YAML)}: {exc}",
                "Fix the YAML so required_simulated_peripherals can be evaluated.",
            )
        )
        return {}
    if not isinstance(data, dict):
        findings.append(
            Finding(
                "invalid_aosp_completion_gate_shape",
                "blocker",
                "AOSP completion gate YAML must be a mapping",
                rel(GATE_YAML),
                "Use a top-level mapping with required_simulated_peripherals entries.",
            )
        )
        return {}
    return data


def peripheral_entries(data: dict[str, Any], findings: list[Finding]) -> list[dict[str, Any]]:
    raw = data.get("required_simulated_peripherals")
    if not isinstance(raw, list):
        findings.append(
            Finding(
                "missing_required_simulated_peripherals",
                "blocker",
                "AOSP completion gate does not define required simulated peripherals",
                rel(GATE_YAML),
                "List every phone-surface peripheral with evidence path and required markers.",
            )
        )
        return []
    entries: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            findings.append(
                Finding(
                    "invalid_peripheral_entry",
                    "blocker",
                    "required_simulated_peripherals entry is not a mapping",
                    repr(item),
                    "Use mappings with id, evidence, and required_markers keys.",
                )
            )
            continue
        component = item.get("id")
        evidence = item.get("evidence")
        producer = item.get("producer")
        markers = item.get("required_markers")
        if not isinstance(component, str) or not component:
            findings.append(
                Finding(
                    "invalid_peripheral_id",
                    "blocker",
                    "simulated peripheral entry has no stable id",
                    repr(item),
                    "Give each required peripheral a stable id.",
                )
            )
            continue
        if component in seen:
            findings.append(
                Finding(
                    "duplicate_peripheral_id",
                    "blocker",
                    "simulated peripheral id is duplicated",
                    component,
                    "Keep one checklist entry per required component.",
                )
            )
        seen.add(component)
        if not isinstance(evidence, str) or not evidence:
            findings.append(
                Finding(
                    f"peripheral_evidence_path_missing:{component}",
                    "blocker",
                    "simulated peripheral entry has no evidence path",
                    component,
                    "Point the entry at its archived probe log.",
                )
            )
            continue
        if not isinstance(markers, list) or not all(isinstance(marker, str) for marker in markers):
            findings.append(
                Finding(
                    f"peripheral_markers_invalid:{component}",
                    "blocker",
                    "simulated peripheral entry has invalid required markers",
                    component,
                    "Use a string list of markers that prove the component worked.",
                )
            )
            continue
        if not isinstance(producer, str) or not producer:
            findings.append(
                Finding(
                    f"peripheral_producer_missing:{component}",
                    "blocker",
                    "simulated peripheral entry has no capture producer",
                    component,
                    "Point producer at scripts/android/capture_simulated_peripheral_evidence.py for the component.",
                )
            )
            continue
        if "capture_simulated_peripheral_evidence.py" not in producer:
            findings.append(
                Finding(
                    f"peripheral_producer_not_canonical:{component}",
                    "blocker",
                    "simulated peripheral entry does not use the canonical capture driver",
                    producer,
                    "Use scripts/android/capture_simulated_peripheral_evidence.py so logs include command provenance and fail-closed status.",
                )
            )
        entries.append(
            {
                "id": component,
                "evidence": evidence,
                "producer": producer,
                "required_markers": markers,
            }
        )
    missing = sorted(REQUIRED_COMPONENTS - seen)
    for component in missing:
        findings.append(
            Finding(
                f"missing_required_peripheral:{component}",
                "blocker",
                "AOSP completion gate omits a required simulated phone peripheral",
                component,
                "Add this peripheral to required_simulated_peripherals with archived PASS evidence.",
            )
        )
    return entries


def check_log(component: str, path: Path, markers: list[str], findings: list[Finding]) -> None:
    if not path.is_file():
        findings.append(
            Finding(
                f"missing_peripheral_evidence:{component}",
                "blocker",
                "simulated peripheral evidence log is missing",
                rel(path),
                "Run the adb-backed peripheral probe after Android boots and archive the PASS log.",
            )
        )
        return
    text = read_text(path)
    for marker in REQUIRED_LOG_PROVENANCE:
        expected = marker + component if marker.endswith("component=") else marker
        if expected not in text:
            findings.append(
                Finding(
                    f"peripheral_log_provenance_missing:{component}",
                    "blocker",
                    "simulated peripheral probe log is missing required capture provenance",
                    f"{rel(path)} missing {expected}",
                    "Regenerate this log with scripts/android/capture_simulated_peripheral_evidence.py against a booted adb device.",
                )
            )
    canonical_probe = CANONICAL_PROBES.get(component)
    if canonical_probe and canonical_probe not in text:
        findings.append(
            Finding(
                f"peripheral_log_not_canonical_probe:{component}",
                "blocker",
                "simulated peripheral probe log was not captured with the canonical adb probe",
                f"{rel(path)} missing {canonical_probe}",
                "Regenerate this log with the default capture path rather than an ELIZA_*_SIM_COMMAND override.",
            )
        )
    if "SELECTED_ADB_SERIAL=<none>" in text:
        findings.append(
            Finding(
                f"peripheral_log_no_adb_target:{component}",
                "blocker",
                "simulated peripheral probe log did not select a ready adb target",
                rel(path),
                "Boot Cuttlefish/Android until `adb devices` reports exactly one device, or pass --adb-serial explicitly.",
            )
        )
    if "ADB_SERIAL=" not in text and "SELECTED_ADB_SERIAL=" not in text:
        findings.append(
            Finding(
                f"peripheral_log_adb_target_missing:{component}",
                "blocker",
                "simulated peripheral probe log does not record the adb target identity",
                rel(path),
                "Regenerate this log with scripts/android/capture_simulated_peripheral_evidence.py so ADB target provenance is archived.",
            )
        )
    if "eliza-evidence: status=FAIL" in text or "RESULT=1" in text:
        findings.append(
            Finding(
                f"peripheral_evidence_failed:{component}",
                "blocker",
                "simulated peripheral probe log records a failure",
                rel(path),
                "Fix the underlying probe or product wiring until this log records RESULT=0 and status=PASS.",
            )
        )
    if "eliza-evidence: status=BLOCKED" in text or "RESULT=2" in text:
        findings.append(
            Finding(
                f"peripheral_evidence_blocked:{component}",
                "blocker",
                "simulated peripheral probe log is blocked",
                rel(path),
                "Boot the Android target with ADB available and capture a PASS probe for this component.",
            )
        )
    if "RESULT=0" not in text:
        findings.append(
            Finding(
                f"peripheral_result_not_pass:{component}",
                "blocker",
                "simulated peripheral probe log does not record RESULT=0",
                rel(path),
                "Replace the archived log with a successful probe transcript.",
            )
        )
    if "eliza-evidence: status=PASS" not in text:
        findings.append(
            Finding(
                f"peripheral_status_not_pass:{component}",
                "blocker",
                "simulated peripheral probe log does not record status=PASS",
                rel(path),
                "Capture a passing adb-backed probe log with a PASS evidence status.",
            )
        )
    proof_lines = [
        line.strip()
        for line in text.splitlines()
        if line.strip() and not line.startswith("MISSING_MARKERS=")
    ]
    for marker in markers:
        if not any(
            line == marker or (marker.endswith("=") and line.startswith(marker))
            for line in proof_lines
        ):
            findings.append(
                Finding(
                    f"peripheral_marker_missing:{component}",
                    "blocker",
                    "simulated peripheral probe log is missing a required proof marker",
                    f"{rel(path)} missing {marker}",
                    "Update the product/probe path so the archived log contains every required marker.",
                )
            )


def check_source_contradictions(findings: list[Finding]) -> None:
    launch_text = read_text(LAUNCH_CVD) if LAUNCH_CVD.is_file() else ""
    ai_soc_text = read_text(ELIZA_AI_SOC_README) if ELIZA_AI_SOC_README.is_file() else ""
    cuttlefish_text = read_text(CUTTLEFISH_E1_README) if CUTTLEFISH_E1_README.is_file() else ""

    add_if(
        findings,
        "--enable_wifi=false" in launch_text,
        "peripheral_capture_probe_wifi_disabled",
        "Cuttlefish launcher disables Wi-Fi while Wi-Fi PASS evidence is required",
        rel(LAUNCH_CVD),
        "Enable Wi-Fi for the evidence run or document and gate the exact alternate network proof path.",
        blocker_dependency="repo_artifact_generation",
    )
    add_if(
        findings,
        "no audio HAL" in ai_soc_text
        and "no microphone" in ai_soc_text
        and "no speaker" in ai_soc_text,
        "aosp_chip_product_declares_no_audio_hal",
        "eliza_ai_soc product documents no audio/microphone/speaker support while audio evidence is required",
        rel(ELIZA_AI_SOC_README),
        "Add the audio HAL/config path or keep audio evidence outside any readiness claim.",
        blocker_dependency="repo_artifact_generation",
    )
    missing_hal_phrase = "Add camera/audio/radio/GNSS/NFC/bluetooth/wifi HALs".lower()
    add_if(
        findings,
        missing_hal_phrase in cuttlefish_text.lower(),
        "cuttlefish_e1_missing_phone_hals",
        "cuttlefish_e1 overlay still documents missing phone HAL coverage",
        rel(CUTTLEFISH_E1_README),
        "Update the overlay/product wiring and documentation once required phone HAL evidence is captured.",
        blocker_dependency="repo_artifact_generation",
    )


def components_from_findings(findings: list[Finding]) -> list[str]:
    components: set[str] = set()
    for finding in findings:
        if ":" not in finding.code:
            continue
        _, component = finding.code.split(":", 1)
        if component in REQUIRED_COMPONENTS:
            components.add(component)
    return sorted(components)


def next_command_plan(findings: list[Finding]) -> list[dict[str, object]]:
    if not findings:
        return []
    components = components_from_findings(findings)
    plan: list[dict[str, object]] = []
    if components:
        plan.append(
            {
                "id": "capture_android_simulated_peripheral_evidence",
                "scope": "host_adb",
                "claim_boundary": "operator_live_capture_commands_only_not_runtime_evidence",
                "commands": [
                    "adb devices",
                    (
                        f"{CAPTURE_SCRIPT} "
                        + " ".join(f"--adb-connect {address}" for address in ADB_CONNECT_CANDIDATES)
                        + " "
                        + " ".join(components)
                    ),
                    RECHECK_COMMAND,
                ],
                "components": components,
                "requires": [
                    "exactly one booted Android/Cuttlefish target or explicit adb serial",
                    "canonical peripheral probe scripts available in sw/aosp-device/peripherals",
                    "phone HAL/product wiring enabled for the requested components",
                ],
            }
        )
    if any(
        finding.code
        in {
            "peripheral_capture_probe_wifi_disabled",
            "aosp_chip_product_declares_no_audio_hal",
            "cuttlefish_e1_missing_phone_hals",
        }
        for finding in findings
    ):
        plan.append(
            {
                "id": "repair_android_peripheral_product_wiring",
                "scope": "repo_aosp",
                "claim_boundary": "repo_product_wiring_commands_only_not_runtime_evidence",
                "commands": [
                    "python3 packages/chip/scripts/check_android_simulated_peripheral_evidence.py --json-only",
                ],
                "requires": [
                    "product README/launch script updates that match captured phone HAL evidence",
                ],
            }
        )
    return plan


def payload(findings: list[Finding], evidence: dict[str, Any]) -> dict[str, Any]:
    blockers = [finding for finding in findings if finding.severity == "blocker"]
    dependency_counts: dict[str, int] = {}
    for finding in blockers:
        dependency_counts[finding.blocker_dependency] = (
            dependency_counts.get(finding.blocker_dependency, 0) + 1
        )
    command_plan = next_command_plan(findings)
    return {
        "schema": SCHEMA,
        "status": "pass" if not blockers else "blocked",
        "claim_boundary": CLAIM_BOUNDARY,
        **FALSE_CLAIM_FLAGS,
        "generated_utc": utc_now(),
        "summary": {
            "blockers": len(blockers),
            "findings": len(findings),
            "blocker_dependency_counts": dependency_counts,
            "next_command_batch_count": len(command_plan),
        },
        "blocker_dependency_counts": dependency_counts,
        "findings": [asdict(finding) for finding in findings],
        "next_command_plan": command_plan,
        "evidence": evidence,
    }


def run_check(args: argparse.Namespace) -> dict[str, Any]:
    del args
    findings: list[Finding] = []
    data = load_gate(findings)
    entries = peripheral_entries(data, findings) if data else []
    for entry in entries:
        check_log(
            str(entry["id"]),
            ROOT / str(entry["evidence"]),
            list(entry["required_markers"]),
            findings,
        )
    check_source_contradictions(findings)
    evidence = {
        "required_components": sorted(REQUIRED_COMPONENTS),
        "configured_components": sorted(str(entry["id"]) for entry in entries),
        "gate": rel(GATE_YAML),
    }
    return payload(findings, evidence)


def write_report(report: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def print_summary(report: dict[str, Any]) -> None:
    print(f"STATUS: {str(report['status']).upper()} android.simulated_peripheral_evidence")
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
