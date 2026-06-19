#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = Path(os.environ.get("MVP_SIMULATOR_REPORT", ROOT / "build/reports/mvp_simulator.json"))
REQUIRED_STEPS = {
    "local_rtl_sim_ladder",
    "chipyard_generated_ap",
    "qemu_firmware_smoke",
    "renode_firmware_smoke",
    "qemu_os_boot",
    "cpu_ap_linux_evidence",
    "chipyard_verilator_preflight",
    "chipyard_payload_path",
    "chipyard_verilator_linux_attempt",
    "chipyard_verilator_linux_smoke",
    "npu_ml_smoke",
    "android_sim_boot",
    "android_sim_report_check",
}
REQUIRED_ON_CHIP_BOOT_STEPS = {
    "cpu_ap_linux_evidence",
    "chipyard_verilator_preflight",
    "chipyard_generated_ap",
    "chipyard_payload_path",
    "chipyard_verilator_linux_attempt",
    "chipyard_verilator_linux_smoke",
}
FALSE_CLAIM_FLAGS = {
    "phone_claim_allowed",
    "release_claim_allowed",
    "fabrication_claim_allowed",
    "phone_performance_claim_allowed",
    "hardware_boot_claim_allowed",
    "production_readiness_claim_allowed",
}


def display_path(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def main() -> int:
    if not REPORT.is_file():
        print(f"MVP simulator check blocked: missing {display_path(REPORT)}")
        print("Next step: python3 scripts/run_mvp_simulator.py")
        return 2
    try:
        data = json.loads(REPORT.read_text())
    except json.JSONDecodeError as exc:
        print(f"MVP simulator check failed: invalid JSON report: {exc}")
        return 1

    errors: list[str] = []
    if data.get("schema") != "eliza.mvp_simulator.v1":
        errors.append("schema mismatch")
    if data.get("status") not in {"pass", "blocked", "fail"}:
        errors.append("status must be pass, blocked, or fail")
    boundary = data.get("claim_boundary", "")
    if "not a fabrication or phone-class performance claim" not in boundary:
        errors.append(
            "claim boundary must separate simulator MVP from fabrication/performance claims"
        )
    if "OS on our chip may be claimed only when on_chip_os_boot_claim is true" not in boundary:
        errors.append(
            "claim boundary must restrict our-chip OS boot claims to generated AP evidence"
        )
    if (
        "minimum Linux+NPU target may be claimed only when minimum_linux_npu_target_claim is true"
        not in boundary
    ):
        errors.append("claim boundary must restrict minimum Linux+NPU target claims")
    if data.get("strongest_attempted") != "os_boot":
        errors.append("strongest_attempted must record os_boot")
    if not isinstance(data.get("os_boot_claim"), bool):
        errors.append("os_boot_claim must be bool")
    if not isinstance(data.get("on_chip_os_boot_claim"), bool):
        errors.append("on_chip_os_boot_claim must be bool")
    if not isinstance(data.get("reference_qemu_virt_os_boot_claim"), bool):
        errors.append("reference_qemu_virt_os_boot_claim must be bool")
    if not isinstance(data.get("reference_android_os_boot_claim"), bool):
        errors.append("reference_android_os_boot_claim must be bool")
    if data.get("qemu_virt_reference_only") is not True:
        errors.append("qemu_virt_reference_only must be true")
    if data.get("renode_reference_only") is not True:
        errors.append("renode_reference_only must be true")
    if data.get("os_boot_claim") != data.get("on_chip_os_boot_claim"):
        errors.append("os_boot_claim must remain an alias for on_chip_os_boot_claim")
    if not isinstance(data.get("npu_ml_smoke_claim"), bool):
        errors.append("npu_ml_smoke_claim must be bool")
    if not isinstance(data.get("integrated_linux_npu_ml_claim"), bool):
        errors.append("integrated_linux_npu_ml_claim must be bool")
    if not isinstance(data.get("minimum_linux_npu_target_claim"), bool):
        errors.append("minimum_linux_npu_target_claim must be bool")
    for flag in sorted(FALSE_CLAIM_FLAGS):
        if data.get(flag) is not False:
            errors.append(f"{flag} must be false")
    if data.get("minimum_linux_npu_target_claim") != (
        bool(data.get("on_chip_os_boot_claim"))
        and bool(data.get("npu_ml_smoke_claim"))
        and bool(data.get("integrated_linux_npu_ml_claim"))
    ):
        errors.append(
            "minimum_linux_npu_target_claim must require on-chip OS boot, NPU smoke, and integrated Linux NPU markers"
        )
    if not isinstance(data.get("best_executable_evidence"), str):
        errors.append("best_executable_evidence must be string")
    if data.get("best_executable_evidence") in {
        "qemu_os_boot",
        "qemu_firmware_smoke",
        "renode_firmware_smoke",
        "android_sim_boot",
        "android_sim_report_check",
    }:
        errors.append(
            "best_executable_evidence must not name reference-only QEMU/Renode/Android results"
        )
    if not isinstance(data.get("best_reference_evidence"), str):
        errors.append("best_reference_evidence must be string")
    if data.get("best_executable_tier") not in {
        "os_boot",
        "os_prereq",
        "firmware_smoke",
        "npu_ml",
        "rtl_sim",
        "none",
    }:
        errors.append("best_executable_tier is invalid")
    if data.get("best_reference_tier") not in {
        "os_boot",
        "firmware_smoke",
        "none",
    }:
        errors.append("best_reference_tier is invalid")
    if not isinstance(data.get("remaining_blockers"), list):
        errors.append("remaining_blockers must be list")
    if not isinstance(data.get("blockers_to_on_chip_os_boot"), list):
        errors.append("blockers_to_on_chip_os_boot must be list")
    if not isinstance(data.get("blockers_to_minimum_linux_npu_target"), list):
        errors.append("blockers_to_minimum_linux_npu_target must be list")
    if not isinstance(data.get("failures"), list):
        errors.append("failures must be list")

    results = data.get("results")
    if not isinstance(results, list) or not results:
        errors.append("results must be a non-empty list")
        results = []
    seen = {item.get("name") for item in results if isinstance(item, dict)}
    missing = sorted(REQUIRED_STEPS - seen)
    if missing:
        errors.append("report missing required steps: " + ", ".join(missing))
    for index, item in enumerate(results):
        if not isinstance(item, dict):
            errors.append(f"results[{index}] must be an object")
            continue
        if item.get("status") not in {"pass", "blocked", "fail"}:
            errors.append(f"results[{index}] status is invalid")
        if item.get("tier") not in {"os_boot", "os_prereq", "firmware_smoke", "npu_ml", "rtl_sim"}:
            errors.append(f"results[{index}] tier is invalid")
        if item.get("scope") not in {
            "qemu_virt_reference",
            "renode_reference",
            "android_reference",
            "our_chip_prereq",
            "our_chip_os_boot",
            "our_chip_npu_ml_local",
            "our_chip_rtl_sim",
        }:
            errors.append(f"results[{index}] scope is invalid")
        if not isinstance(item.get("claim"), str) or not item["claim"]:
            errors.append(f"results[{index}] claim must be non-empty string")
        if not isinstance(item.get("command"), list) or not item["command"]:
            errors.append(f"results[{index}] command must be a non-empty list")
        if not isinstance(item.get("returncode"), int):
            errors.append(f"results[{index}] returncode must be int")
    if data.get("on_chip_os_boot_claim") is True and not any(
        isinstance(item, dict)
        and item.get("scope") == "our_chip_os_boot"
        and item.get("status") == "pass"
        for item in results
    ):
        errors.append("on_chip_os_boot_claim true without passing our-chip OS boot result")
    if data.get("on_chip_os_boot_claim") is True:
        passing = {
            str(item.get("name"))
            for item in results
            if isinstance(item, dict) and item.get("status") == "pass"
        }
        missing_required = sorted(REQUIRED_ON_CHIP_BOOT_STEPS - passing)
        if missing_required:
            errors.append(
                "on_chip_os_boot_claim true without passing required chip/AP steps: "
                + ", ".join(missing_required)
            )
    if data.get("reference_qemu_virt_os_boot_claim") is True and not any(
        isinstance(item, dict)
        and item.get("name") == "qemu_os_boot"
        and item.get("scope") == "qemu_virt_reference"
        and item.get("status") == "pass"
        for item in results
    ):
        errors.append("reference_qemu_virt_os_boot_claim true without passing qemu_os_boot")
    if data.get("on_chip_os_boot_claim") is False:
        passing_required_steps = {
            str(item.get("name"))
            for item in results
            if isinstance(item, dict)
            and item.get("status") == "pass"
            and str(item.get("name")) in REQUIRED_ON_CHIP_BOOT_STEPS
        }
        blocker_names = {
            item.get("name")
            for item in data.get("blockers_to_on_chip_os_boot", [])
            if isinstance(item, dict)
        }
        missing_blockers = (
            REQUIRED_ON_CHIP_BOOT_STEPS
            - passing_required_steps
            - {str(name) for name in blocker_names}
        )
        if missing_blockers:
            errors.append(
                "blockers_to_on_chip_os_boot missing: " + ", ".join(sorted(missing_blockers))
            )
    if (
        data.get("minimum_linux_npu_target_claim") is False
        and data.get("integrated_linux_npu_ml_claim") is False
    ):
        blocker_names = {
            item.get("name")
            for item in data.get("blockers_to_minimum_linux_npu_target", [])
            if isinstance(item, dict)
        }
        if "integrated_linux_npu_ml_transcript" not in blocker_names:
            errors.append(
                "blockers_to_minimum_linux_npu_target missing integrated_linux_npu_ml_transcript"
            )

    if errors:
        print("MVP simulator check failed:")
        for error in errors:
            print(f"  - {error}")
        return 1

    status = data.get("status")
    if status == "pass":
        print("MVP simulator check passed")
        return 0
    if status == "blocked":
        print("MVP simulator check blocked")
        if data.get("on_chip_os_boot_claim") is False:
            print("  on_chip_os_boot_claim: false")
            print("  blockers_to_on_chip_os_boot:")
            for item in data.get("blockers_to_on_chip_os_boot", []):
                if isinstance(item, dict):
                    print(f"    - {item.get('name')}: {item.get('detail', 'blocked')}")
        if data.get("minimum_linux_npu_target_claim") is False:
            print("  minimum_linux_npu_target_claim: false")
            print("  blockers_to_minimum_linux_npu_target:")
            for item in data.get("blockers_to_minimum_linux_npu_target", []):
                if isinstance(item, dict):
                    print(f"    - {item.get('name')}: {item.get('detail', 'blocked')}")
        for item in results:
            if item.get("status") == "blocked":
                print(f"  - {item.get('name')}: blocked")
        return 2
    print("MVP simulator check failed")
    for item in results:
        if item.get("status") == "fail":
            print(f"  - {item.get('name')}: failed")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
