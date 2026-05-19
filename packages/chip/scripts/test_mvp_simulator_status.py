#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECK = ROOT / "scripts/check_mvp_simulator.py"
REPORT = ROOT / "build/reports/mvp_simulator.status-test.json"

BOUNDARY = (
    "Simulator MVP separates qemu-virt/Renode/Android reference evidence from OS "
    "running on generated Eliza AP/e1-chip RTL. qemu_os_boot may be claimed "
    "only as reference_qemu_virt_os_boot_claim. Renode smoke is renode_reference_only "
    "unless a generated e1-chip hardware model and transcript are archived. OS "
    "on our chip may be claimed only when on_chip_os_boot_claim is true from "
    "generated AP/Linux evidence; qemu-virt, Renode, and Android simulator evidence "
    "do not satisfy that claim. The minimum Linux+NPU target may be claimed only "
    "when minimum_linux_npu_target_claim is true from one generated-AP Linux "
    "transcript that also contains the e1 NPU ML smoke PASS markers; local NPU "
    "runtime smoke alone does not satisfy the integrated target. It is not a "
    "fabrication or phone-class performance claim."
)


def run_check() -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["MVP_SIMULATOR_REPORT"] = str(REPORT)
    return subprocess.run(
        ["python3", str(CHECK)],
        cwd=ROOT,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def write_report(payload: dict) -> None:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")


def base_result(name: str, status: str, scope: str, tier: str) -> dict:
    return {
        "name": name,
        "tier": tier,
        "scope": scope,
        "claim": f"{name} claim",
        "command": ["true"],
        "status": status,
        "returncode": 0 if status == "pass" else 2,
        "elapsed_seconds": 0.01,
        "log_tail": [],
    }


def required_results() -> list[dict]:
    return [
        base_result("local_rtl_sim_ladder", "pass", "our_chip_rtl_sim", "rtl_sim"),
        base_result("qemu_firmware_smoke", "pass", "qemu_virt_reference", "firmware_smoke"),
        base_result("renode_firmware_smoke", "pass", "renode_reference", "firmware_smoke"),
        base_result("qemu_os_boot", "blocked", "qemu_virt_reference", "os_boot"),
        base_result("android_sim_boot", "blocked", "android_reference", "os_boot"),
        base_result("android_sim_report_check", "blocked", "android_reference", "os_boot"),
        base_result("cpu_ap_linux_evidence", "blocked", "our_chip_prereq", "os_prereq"),
        base_result("chipyard_verilator_preflight", "blocked", "our_chip_prereq", "os_prereq"),
        base_result("chipyard_generated_ap", "blocked", "our_chip_prereq", "os_prereq"),
        base_result("chipyard_payload_path", "blocked", "our_chip_prereq", "os_prereq"),
        base_result("chipyard_verilator_linux_attempt", "blocked", "our_chip_os_boot", "os_boot"),
        base_result("chipyard_verilator_linux_smoke", "blocked", "our_chip_os_boot", "os_boot"),
        base_result("npu_ml_smoke", "pass", "our_chip_npu_ml_local", "npu_ml"),
    ]


def report_payload(*, status: str = "blocked", on_chip: bool = False) -> dict:
    results = required_results()
    blockers = [
        {
            "name": "cpu_ap_linux_evidence",
            "tier": "os_prereq",
            "detail": "blocked",
            "next_command": "python3 scripts/check_cpu_ap_evidence.py --require-evidence",
        },
        {
            "name": "chipyard_payload_path",
            "tier": "os_prereq",
            "detail": "blocked",
            "next_command": "python3 scripts/check_chipyard_payload_path.py",
        },
        {
            "name": "chipyard_verilator_linux_smoke",
            "tier": "os_boot",
            "detail": "blocked",
            "next_command": "python3 scripts/check_chipyard_verilator_linux_smoke.py",
        },
    ]
    if on_chip:
        for item in results:
            if item["name"] == "chipyard_verilator_linux_smoke":
                item["status"] = "pass"
                item["returncode"] = 0
        blockers = []
    minimum_blockers = list(blockers)
    if not on_chip:
        minimum_blockers.append(
            {
                "name": "integrated_linux_npu_ml_transcript",
                "tier": "npu_ml",
                "detail": "missing generated-AP Linux/NPU transcript",
                "next_command": "python3 scripts/run_mvp_simulator.py",
            }
        )
    return {
        "schema": "eliza.mvp_simulator.v1",
        "status": status,
        "strongest_attempted": "os_boot",
        "best_executable_evidence": "chipyard_verilator_linux_smoke"
        if on_chip
        else "local_rtl_sim_ladder",
        "best_executable_tier": "os_boot" if on_chip else "rtl_sim",
        "best_reference_evidence": "qemu_firmware_smoke",
        "best_reference_tier": "firmware_smoke",
        "os_boot_claim": on_chip,
        "on_chip_os_boot_claim": on_chip,
        "reference_qemu_virt_os_boot_claim": False,
        "reference_android_os_boot_claim": False,
        "npu_ml_smoke_claim": True,
        "integrated_linux_npu_ml_claim": on_chip,
        "minimum_linux_npu_target_claim": on_chip,
        "qemu_virt_reference_only": True,
        "renode_reference_only": True,
        "blockers_to_on_chip_os_boot": blockers,
        "blockers_to_minimum_linux_npu_target": minimum_blockers,
        "remaining_blockers": blockers,
        "failures": [],
        "claim_boundary": BOUNDARY,
        "results": results,
    }


def assert_contains(text: str, expected: str) -> None:
    if expected not in text:
        raise AssertionError(f"missing {expected!r} in output:\n{text}")


def test_blocked_report_is_valid() -> None:
    write_report(report_payload())
    result = run_check()
    if result.returncode != 2:
        raise AssertionError(f"expected blocked report, got {result.returncode}\n{result.stdout}")
    assert_contains(result.stdout, "MVP simulator check blocked")
    assert_contains(result.stdout, "on_chip_os_boot_claim: false")


def test_false_on_chip_claim_is_rejected() -> None:
    payload = report_payload(status="pass", on_chip=True)
    for item in payload["results"]:
        if item["name"] == "chipyard_verilator_linux_smoke":
            item["status"] = "blocked"
            item["returncode"] = 2
    write_report(payload)
    result = run_check()
    if result.returncode != 1:
        raise AssertionError(
            f"expected false claim rejection, got {result.returncode}\n{result.stdout}"
        )
    assert_contains(
        result.stdout, "on_chip_os_boot_claim true without passing our-chip OS boot result"
    )


def test_on_chip_pass_report_is_valid() -> None:
    write_report(report_payload(status="pass", on_chip=True))
    result = run_check()
    if result.returncode != 0:
        raise AssertionError(f"expected pass report, got {result.returncode}\n{result.stdout}")
    assert_contains(result.stdout, "MVP simulator check passed")


def test_qemu_boot_cannot_be_best_executable_evidence() -> None:
    payload = report_payload()
    payload["best_executable_evidence"] = "qemu_os_boot"
    payload["best_executable_tier"] = "os_boot"
    payload["reference_qemu_virt_os_boot_claim"] = True
    for item in payload["results"]:
        if item["name"] == "qemu_os_boot":
            item["status"] = "pass"
            item["returncode"] = 0
    write_report(payload)
    result = run_check()
    if result.returncode != 1:
        raise AssertionError(
            f"expected qemu best-evidence rejection, got {result.returncode}\n{result.stdout}"
        )
    assert_contains(
        result.stdout,
        "best_executable_evidence must not name reference-only QEMU/Renode/Android results",
    )


def main() -> int:
    with tempfile.TemporaryDirectory() as td:
        global REPORT
        REPORT = Path(td) / "mvp_simulator.json"
        for test in (
            test_blocked_report_is_valid,
            test_false_on_chip_claim_is_rejected,
            test_on_chip_pass_report_is_valid,
            test_qemu_boot_cannot_be_best_executable_evidence,
        ):
            test()
            print(f"PASS {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
