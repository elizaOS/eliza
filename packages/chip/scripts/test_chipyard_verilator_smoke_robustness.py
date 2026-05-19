#!/usr/bin/env python3
"""Robustness tests for generated Chipyard Verilator smoke recovery."""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import check_chipyard_verilator_linux_smoke as smoke  # noqa: E402


def test_partial_generated_driver_dir_is_repairable_blocker() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        old_values = (
            smoke.GENERATED_CONFIG_DIR,
            smoke.GENERATED_DRIVER_DIR,
            smoke.GENERATED_DRIVER_MAKEFILE,
            smoke.GENERATED_FILELISTS,
            smoke.GENERATED_SIMULATOR,
        )
        try:
            smoke.GENERATED_CONFIG_DIR = (
                tmp / "generated-src" / "chipyard.harness.TestHarness.ElizaRocketConfig"
            )
            smoke.GENERATED_DRIVER_DIR = (
                smoke.GENERATED_CONFIG_DIR / "chipyard.harness.TestHarness.ElizaRocketConfig"
            )
            smoke.GENERATED_DRIVER_MAKEFILE = smoke.GENERATED_DRIVER_DIR / "VTestDriver.mk"
            smoke.GENERATED_FILELISTS = (smoke.GENERATED_CONFIG_DIR / "sim_files.f",)
            smoke.GENERATED_SIMULATOR = tmp / "simulator-chipyard.harness-ElizaRocketConfig"
            smoke.GENERATED_DRIVER_DIR.mkdir(parents=True)

            blockers = smoke.generated_path_blockers()
            joined = "\n".join(blockers)
            if "partial generated Verilator" not in joined:
                raise AssertionError(f"expected partial generated blocker, got {blockers}")

            status = smoke.repair_stale_generated_paths()
            if status != 0:
                raise AssertionError(f"expected repair status 0, got {status}")
            if smoke.GENERATED_CONFIG_DIR.exists():
                raise AssertionError("expected generated config directory to be removed")
        finally:
            (
                smoke.GENERATED_CONFIG_DIR,
                smoke.GENERATED_DRIVER_DIR,
                smoke.GENERATED_DRIVER_MAKEFILE,
                smoke.GENERATED_FILELISTS,
                smoke.GENERATED_SIMULATOR,
            ) = old_values


def test_zero_byte_driver_outputs_are_repairable_blockers() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        old_values = (
            smoke.GENERATED_CONFIG_DIR,
            smoke.GENERATED_DRIVER_DIR,
            smoke.GENERATED_DRIVER_MAKEFILE,
            smoke.GENERATED_FILELISTS,
            smoke.GENERATED_SIMULATOR,
        )
        try:
            smoke.GENERATED_CONFIG_DIR = (
                tmp / "generated-src" / "chipyard.harness.TestHarness.ElizaRocketConfig"
            )
            smoke.GENERATED_DRIVER_DIR = (
                smoke.GENERATED_CONFIG_DIR / "chipyard.harness.TestHarness.ElizaRocketConfig"
            )
            smoke.GENERATED_DRIVER_MAKEFILE = smoke.GENERATED_DRIVER_DIR / "VTestDriver.mk"
            smoke.GENERATED_FILELISTS = (smoke.GENERATED_CONFIG_DIR / "sim_files.f",)
            smoke.GENERATED_SIMULATOR = tmp / "simulator-chipyard.harness-ElizaRocketConfig"
            smoke.GENERATED_DRIVER_DIR.mkdir(parents=True)
            smoke.GENERATED_DRIVER_MAKEFILE.write_text("VM_PREFIX = /tmp/tool\n", encoding="utf-8")
            (smoke.GENERATED_DRIVER_DIR / "VTestDriver__ALL.a").write_bytes(b"")

            blockers = smoke.generated_path_blockers()
            joined = "\n".join(blockers)
            if "zero-byte model artifacts" not in joined:
                raise AssertionError(f"expected zero-byte generated blocker, got {blockers}")
        finally:
            (
                smoke.GENERATED_CONFIG_DIR,
                smoke.GENERATED_DRIVER_DIR,
                smoke.GENERATED_DRIVER_MAKEFILE,
                smoke.GENERATED_FILELISTS,
                smoke.GENERATED_SIMULATOR,
            ) = old_values


def test_log_metadata_records_attempt_and_closed_transcript() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        old_log = smoke.LOG
        try:
            smoke.LOG = tmp / "verilator-linux-smoke.log"
            smoke.LOG.write_text(
                "\n".join(
                    [
                        "eliza-evidence: attempt=2",
                        "eliza-evidence: clean_generated=1",
                        "eliza-evidence: raw_transcript_begin",
                        "build output",
                        "eliza-evidence: raw_transcript_end",
                        "eliza-evidence: exit_code=2",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            metadata = smoke.parse_log_metadata()
            if metadata["attempt"] != "2":
                raise AssertionError(f"expected attempt metadata, got {metadata}")
            if metadata["clean_generated"] != "1":
                raise AssertionError(f"expected clean metadata, got {metadata}")
            if metadata["raw_transcript_closed"] is not True:
                raise AssertionError(f"expected closed transcript, got {metadata}")
        finally:
            smoke.LOG = old_log


def test_simulator_artifact_validation_requires_executable_candidate() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        old_candidates = smoke.SIMULATOR_CANDIDATES
        try:
            missing = tmp / "missing-simulator"
            smoke.SIMULATOR_CANDIDATES = (missing,)
            metadata = smoke.simulator_artifact_metadata()
            blockers = smoke.simulator_artifact_blockers(metadata)
            if "missing generated simulator artifact" not in "\n".join(blockers):
                raise AssertionError(f"expected missing simulator blocker, got {blockers}")

            simulator = tmp / "simulator-chipyard.harness-ElizaRocketConfig"
            simulator.write_bytes(b"\x7fELF" + bytes([2, 1, 1]) + bytes(9) + b"\x02\x00\x3e\x00")
            simulator.chmod(0o755)
            smoke.SIMULATOR_CANDIDATES = (simulator,)
            metadata = smoke.simulator_artifact_metadata()
            blockers = smoke.simulator_artifact_blockers(metadata)
            if blockers:
                raise AssertionError(f"expected executable simulator artifact, got {blockers}")
            candidate = metadata["candidates"][0]
            if candidate["elf_machine"] != "x86_64":
                raise AssertionError(f"expected x86_64 ELF metadata, got {candidate}")
            if not candidate["sha256"]:
                raise AssertionError(f"expected simulator sha256, got {candidate}")
        finally:
            smoke.SIMULATOR_CANDIDATES = old_candidates


def test_progress_classifies_sifive_uart_tx_full_poll() -> None:
    progress = smoke.classify_smoke_progress(
        log_text="eliza-evidence: raw_transcript_begin\n",
        instruction_trace={
            "bootrom_to_payload_handoff": True,
            "last_symbol": "sifive_uart_putc",
        },
        log_metadata={"raw_transcript_closed": True},
    )
    if progress["stage"] != "payload_uart_tx_full_poll":
        raise AssertionError(f"expected UART TX poll stage, got {progress}")
    if "TXDATA full-bit" not in progress["next_step"]:
        raise AssertionError(f"expected TXDATA guidance, got {progress}")


def main() -> int:
    tests = (
        test_partial_generated_driver_dir_is_repairable_blocker,
        test_zero_byte_driver_outputs_are_repairable_blockers,
        test_log_metadata_records_attempt_and_closed_transcript,
        test_simulator_artifact_validation_requires_executable_candidate,
        test_progress_classifies_sifive_uart_tx_full_poll,
    )
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
