#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
GATE = ROOT / "docs/project/aosp-simulator-completion-gate.yaml"
REQUIRED_FALSE_CLAIM_FLAGS = (
    "claim_allowed",
    "release_claim_allowed",
    "phone_runtime_claim_allowed",
    "android_boot_claim_allowed",
    "simulator_completion_claim_allowed",
    "production_readiness_claim_allowed",
)


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def load_yaml(path: Path, errors: list[str]) -> dict[str, Any]:
    if not path.is_file():
        errors.append(f"missing gate file: {rel(path)}")
        return {}
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        errors.append(f"{rel(path)} must be a YAML mapping")
        return {}
    return data


def load_json(path: Path, blockers: list[str]) -> dict[str, Any]:
    if not path.is_file():
        blockers.append(f"missing report: {rel(path)}")
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        blockers.append(f"{rel(path)} is invalid JSON: {exc}")
        return {}
    if not isinstance(data, dict):
        blockers.append(f"{rel(path)} must contain a JSON object")
        return {}
    return data


def numeric_gt(
    target: dict[str, Any],
    baseline: dict[str, Any],
    key: str,
    errors: list[str],
    *,
    allow_equal: bool = False,
) -> None:
    left = target.get(key)
    right = baseline.get(key)
    if not isinstance(left, int | float) or not isinstance(right, int | float):
        errors.append(f"spec {key} must be numeric in target and baseline")
        return
    if allow_equal:
        if left < right:
            errors.append(f"target {key}={left} must be at least baseline {right}")
    elif left <= right:
        errors.append(f"target {key}={left} must outperform baseline {right}")


def check_spec_floor(data: dict[str, Any], errors: list[str]) -> None:
    baseline = data.get("pinephone_pro_baseline")
    target = data.get("eliza_target_floor")
    if not isinstance(baseline, dict) or not isinstance(target, dict):
        errors.append("gate must define pinephone_pro_baseline and eliza_target_floor")
        return
    if baseline.get("source_url") != "https://pine64.org/devices/pinephone_pro/":
        errors.append("PinePhone Pro baseline must cite the official PINE64 device page")
    for key in (
        "cpu_cores",
        "cpu_max_ghz",
        "gpu_cores",
        "gpu_max_mhz",
        "ram_gb",
        "storage_gb",
        "display_inches",
        "display_pixels",
        "rear_camera_mp",
        "front_camera_mp",
        "wifi_generation",
        "bluetooth_version",
        "cellular_generation",
        "battery_mah",
        "charging_watts",
    ):
        numeric_gt(target, baseline, key, errors)
    for key in ("expandable_storage_tb", "usb_major_version"):
        numeric_gt(target, baseline, key, errors, allow_equal=True)


def check_false_claim_flags(data: dict[str, Any], errors: list[str]) -> None:
    for key in REQUIRED_FALSE_CLAIM_FLAGS:
        if data.get(key) is not False:
            errors.append(f"{key} must be false")


def require_text_markers(
    path: Path,
    markers: list[str],
    blockers: list[str],
    *,
    status_prefixes: tuple[str, ...] = ("eliza-evidence",),
) -> None:
    if not path.is_file():
        blockers.append(f"missing evidence: {rel(path)}")
        return
    text = path.read_text(encoding="utf-8", errors="replace")
    forbidden_markers = (
        "eliza-evidence: status=FAIL",
        "eliza-evidence: status=BLOCKED",
        "status=FAIL",
        "status=BLOCKED",
        "STATUS: FAIL",
        "STATUS: BLOCKED",
        "RESULT=1",
        "RESULT=2",
        "RESULT=127",
    )
    for marker in forbidden_markers:
        if marker in text:
            blockers.append(f"{rel(path)} contains forbidden failure marker: {marker}")
    if "RESULT=0" not in text:
        blockers.append(f"{rel(path)} missing marker: RESULT=0")
    if not any(f"{prefix}: status=PASS" in text for prefix in status_prefixes):
        blockers.append(f"{rel(path)} missing PASS status marker")
    for marker in markers:
        if marker not in text:
            blockers.append(f"{rel(path)} missing marker: {marker}")


def require_json_markers(path: Path, markers: list[str], blockers: list[str]) -> None:
    if not path.is_file():
        blockers.append(f"missing evidence: {rel(path)}")
        return
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        blockers.append(f"{rel(path)} is invalid JSON: {exc}")
        return
    if not isinstance(data, dict):
        blockers.append(f"{rel(path)} must contain a JSON object")
        return
    status = str(data.get("status", "")).upper()
    result = data.get("result")
    if status in {"FAIL", "FAILED", "BLOCKED"}:
        blockers.append(f"{rel(path)} contains forbidden JSON status: {status}")
    if result not in (0, "0"):
        blockers.append(f"{rel(path)} requires JSON result=0")
    if status != "PASS":
        blockers.append(f"{rel(path)} requires JSON status=PASS")
    text = json.dumps(data, indent=2, sort_keys=True)
    for marker in markers:
        if marker not in text:
            blockers.append(f"{rel(path)} missing marker: {marker}")


def require_evidence_markers(path: Path, markers: list[str], blockers: list[str]) -> None:
    if path.suffix == ".json":
        require_json_markers(path, markers, blockers)
        return
    require_text_markers(path, markers, blockers)


def check_mvp_report(data: dict[str, Any], blockers: list[str]) -> None:
    required_reports = data.get("required_reports", {})
    if not isinstance(required_reports, dict):
        blockers.append("required_reports must be a mapping")
        return
    mvp_path = ROOT / str(required_reports.get("mvp_simulator", ""))
    mvp = load_json(mvp_path, blockers)
    if not mvp:
        return
    for key in (
        "on_chip_os_boot_claim",
        "reference_android_os_boot_claim",
        "npu_ml_smoke_claim",
        "integrated_linux_npu_ml_claim",
        "minimum_linux_npu_target_claim",
    ):
        if mvp.get(key) is not True:
            blockers.append(f"{rel(mvp_path)} requires {key}=true")
    if mvp.get("status") != "pass":
        blockers.append(f"{rel(mvp_path)} requires status=pass")


def check_android_report(data: dict[str, Any], blockers: list[str]) -> None:
    required_reports = data.get("required_reports", {})
    if not isinstance(required_reports, dict):
        return
    path = ROOT / str(required_reports.get("android_sim_boot", ""))
    report = load_json(path, blockers)
    if report and report.get("status") != "pass":
        blockers.append(f"{rel(path)} requires status=pass")


def check_android_evidence(data: dict[str, Any], blockers: list[str]) -> None:
    values = data.get("required_android_evidence")
    if not isinstance(values, list):
        blockers.append("required_android_evidence must be a list")
        return
    for item in values:
        if isinstance(item, str):
            require_evidence_markers(ROOT / item, [], blockers)
        else:
            blockers.append("required_android_evidence entries must be paths")


def check_android_marker_evidence(data: dict[str, Any], blockers: list[str]) -> None:
    values = data.get("required_android_marker_evidence")
    if values is None:
        return
    if not isinstance(values, list):
        blockers.append("required_android_marker_evidence must be a list")
        return
    seen: set[str] = set()
    for item in values:
        if not isinstance(item, dict):
            blockers.append("required_android_marker_evidence entries must be mappings")
            continue
        ident = item.get("id")
        evidence = item.get("evidence")
        markers = item.get("required_markers")
        if not isinstance(ident, str) or not ident:
            blockers.append("required_android_marker_evidence entry missing id")
            continue
        if ident in seen:
            blockers.append(f"{ident}: duplicate required_android_marker_evidence id")
        seen.add(ident)
        if not isinstance(evidence, str):
            blockers.append(f"{ident}: missing evidence path")
            continue
        if not isinstance(markers, list) or not all(isinstance(marker, str) for marker in markers):
            blockers.append(f"{ident}: required_markers must be a string list")
            continue
        require_evidence_markers(ROOT / evidence, markers, blockers)


def check_peripherals(data: dict[str, Any], blockers: list[str]) -> None:
    values = data.get("required_simulated_peripherals")
    if not isinstance(values, list):
        blockers.append("required_simulated_peripherals must be a list")
        return
    seen: set[str] = set()
    for item in values:
        if not isinstance(item, dict):
            blockers.append("required_simulated_peripherals entries must be mappings")
            continue
        component = item.get("id")
        evidence = item.get("evidence")
        markers = item.get("required_markers")
        if not isinstance(component, str) or not component:
            blockers.append("simulated peripheral entry missing id")
            continue
        seen.add(component)
        if not isinstance(evidence, str):
            blockers.append(f"{component}: missing evidence path")
            continue
        if not isinstance(markers, list) or not all(isinstance(marker, str) for marker in markers):
            blockers.append(f"{component}: required_markers must be a string list")
            continue
        require_text_markers(ROOT / evidence, markers, blockers)
    for required in {
        "rear_camera",
        "front_camera",
        "microphone",
        "speakers",
        "wifi",
        "bluetooth",
        "cellular_5g_lte",
    }:
        if required not in seen:
            blockers.append(f"missing required simulated peripheral: {required}")


def check_npu_tasks(data: dict[str, Any], blockers: list[str]) -> None:
    tasks = data.get("required_npu_tasks")
    if not isinstance(tasks, list):
        blockers.append("required_npu_tasks must be a list")
        return
    for task in tasks:
        if not isinstance(task, dict):
            blockers.append("required_npu_tasks entries must be mappings")
            continue
        name = str(task.get("name", "<unnamed>"))
        transcript = task.get("transcript")
        report = task.get("report")
        if isinstance(transcript, str):
            markers = task.get("markers", [])
            if not isinstance(markers, list) or not all(
                isinstance(marker, str) for marker in markers
            ):
                blockers.append(f"{name}: markers must be a string list")
            else:
                require_text_markers(
                    ROOT / transcript,
                    markers,
                    blockers,
                    status_prefixes=("eliza-evidence",),
                )
        if isinstance(report, str):
            report_path = ROOT / report
            payload = load_json(report_path, blockers)
            if payload and payload.get("status") != "pass":
                blockers.append(f"{rel(report_path)} requires status=pass")


def main() -> int:
    errors: list[str] = []
    blockers: list[str] = []
    data = load_yaml(GATE, errors)
    if data:
        if data.get("schema") != "eliza.aosp_simulator_completion_gate.v1":
            errors.append("completion gate schema mismatch")
        if "not implementation evidence" not in str(data.get("claim_boundary", "")):
            errors.append("claim boundary must say the gate is not implementation evidence")
        check_false_claim_flags(data, errors)
        check_spec_floor(data, errors)
        check_mvp_report(data, blockers)
        check_android_report(data, blockers)
        check_android_evidence(data, blockers)
        check_android_marker_evidence(data, blockers)
        check_peripherals(data, blockers)
        check_npu_tasks(data, blockers)

    if errors:
        print("AOSP simulator completion gate failed:")
        for error in errors:
            print(f"  - {error}")
        return 1
    if blockers:
        print("AOSP simulator completion gate BLOCKED:")
        for blocker in blockers:
            print(f"  - {blocker}")
        return 2
    print("AOSP simulator completion gate passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
