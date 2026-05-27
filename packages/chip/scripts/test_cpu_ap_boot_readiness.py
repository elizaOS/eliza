#!/usr/bin/env python3
"""Focused tests for the CPU/AP boot-readiness aggregate gate."""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import check_chipyard_generated_linux_contract as generated_contract  # noqa: E402
import check_cpu_ap_boot_readiness as readiness  # noqa: E402


def assert_contains(text: str, expected: str) -> None:
    if expected not in text:
        raise AssertionError(f"missing {expected!r} in {text!r}")


def test_build_report_is_fail_closed() -> None:
    report = readiness.build_report()
    if report["errors"] and report["status"] != "fail":
        raise AssertionError("errors must dominate status")
    if not report["errors"] and report["blockers"] and report["status"] != "blocked":
        raise AssertionError("blockers must produce blocked status")
    if not report["errors"] and not report["blockers"] and report["status"] != "pass":
        raise AssertionError("clean report must pass")


def test_report_schema_and_next_commands_are_machine_readable() -> None:
    report = readiness.build_report()
    if report["schema"] != "eliza.cpu_ap_boot_readiness.v1":
        raise AssertionError("schema drifted")
    if report["claim_boundary"] != "readiness_gate_only_no_boot_evidence_created":
        raise AssertionError("claim boundary drifted")
    if report["status"] not in {"pass", "blocked", "fail"}:
        raise AssertionError(f"unexpected status: {report['status']}")

    commands = "\n".join(blocker["next"] for blocker in report["blockers"])
    if report["blockers"]:
        for token in (
            "run_chipyard_eliza_linux_smoke.sh",
            "CHIPYARD_LINUX_BINARY=",
        ):
            assert_contains(commands, token)


def test_generated_dts_uart_token_matches_current_generated_ap() -> None:
    if readiness.REQUIRED_DTS_TOKENS["uart"] != "serial@10001000":
        raise AssertionError(readiness.REQUIRED_DTS_TOKENS)

    report = readiness.build_report()
    for error in report["errors"]:
        if "generated DTS missing uart" in error:
            raise AssertionError(error)


def test_generated_bootrom_dtb_words_are_reconstructed_little_endian() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        fir = Path(tmpdir) / "bootrom.fir"
        fir.write_text(
            "\n".join(
                [
                    "connect rom[0], UInt<64>(0h0102030405060708)",
                    "connect rom[1], UInt<64>(0h100f0000edfe0dd0)",
                ]
            ),
            encoding="utf-8",
        )
        image = generated_contract.bootrom_bytes_from_fir(fir)
    if image[:8] != bytes.fromhex("0807060504030201"):
        raise AssertionError(f"expected little-endian ROM word reconstruction, got {image[:8]!r}")
    if generated_contract.DTB_MAGIC not in image:
        raise AssertionError("expected reconstructed image to expose DTB magic")


def main() -> int:
    for test in (
        test_build_report_is_fail_closed,
        test_report_schema_and_next_commands_are_machine_readable,
        test_generated_dts_uart_token_matches_current_generated_ap,
        test_generated_bootrom_dtb_words_are_reconstructed_little_endian,
    ):
        test()
        print(f"PASS {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
