#!/usr/bin/env python3
"""Focused tests for the CPU/AP boot-readiness aggregate gate."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import check_cpu_ap_boot_readiness as readiness  # noqa: E402


def assert_contains(text: str, expected: str) -> None:
    if expected not in text:
        raise AssertionError(f"missing {expected!r} in {text!r}")


def test_overall_status_is_fail_closed() -> None:
    if readiness.overall_status(["error"], []) != "fail":
        raise AssertionError("errors must dominate status")
    if readiness.overall_status([], [{"gate": "g", "detail": "d", "next": "n"}]) != "blocked":
        raise AssertionError("blockers must produce blocked status")
    if readiness.overall_status([], []) != "pass":
        raise AssertionError("clean report must pass")


def test_reference_simulators_do_not_satisfy_generated_ap_boot() -> None:
    status = readiness.reference_sim_status()
    if status["qemu_virt"]["satisfies_generated_ap_boot"] is not False:
        raise AssertionError("QEMU virt must remain reference-only")
    if status["renode_qemu_virt"]["satisfies_generated_ap_boot"] is not False:
        raise AssertionError("Renode qemu-virt must remain reference-only")


def test_report_schema_and_next_commands_are_machine_readable() -> None:
    report = readiness.build_report()
    if report["schema"] != "eliza.cpu_ap_boot_readiness.v1":
        raise AssertionError("schema drifted")
    if report["claim_boundary"] != "readiness_gate_only_no_boot_evidence_created":
        raise AssertionError("claim boundary drifted")
    if report["status"] not in {"pass", "blocked", "fail"}:
        raise AssertionError(f"unexpected status: {report['status']}")

    commands = "\n".join(report["next_commands"])
    for token in (
        "check_chipyard_generated_linux_contract.py",
        "locate_chipyard_linux_payload.py",
        "run_chipyard_eliza_linux_smoke.sh",
        "capture_chipyard_linux_evidence.sh",
    ):
        assert_contains(commands, token)


def main() -> int:
    for test in (
        test_overall_status_is_fail_closed,
        test_reference_simulators_do_not_satisfy_generated_ap_boot,
        test_report_schema_and_next_commands_are_machine_readable,
    ):
        test()
        print(f"PASS {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
