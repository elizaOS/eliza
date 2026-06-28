#!/usr/bin/env python3
"""Unit tests for scripts/run_renode.sh status reporting."""

from __future__ import annotations

import json
import os
import stat
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUN_RENODE = ROOT / "scripts/run_renode.sh"
RENODE_ELF = ROOT / "build/qemu/e1_qemu_firmware.elf"
RENODE_LOG = ROOT / "build/reports/renode_smoke.log"
RENODE_MANIFEST = ROOT / "build/reports/renode_smoke.manifest"
RENODE_ATTEMPT_LOG = ROOT / "build/renode/eliza_e1_uart.transcript"
RENODE_JSON = ROOT / "build/renode/eliza_e1_smoke.json"
BANNER = "eliza e1 qemu"


def write_executable(path: Path, text: str) -> None:
    path.write_text(text)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def write_renode_test_double(path: Path) -> None:
    write_executable(
        path,
        "#!/bin/sh\n"
        'if [ "$1" = "--version" ]; then printf \'Renode test double 0.0\\n\'; exit 0; fi\n'
        "printf 'Renode started but no banner appeared\\n'\n",
    )


def write_renode_banner_test_double(path: Path) -> None:
    write_executable(
        path,
        "#!/bin/sh\n"
        'if [ "$1" = "--version" ]; then printf \'Renode test double 0.0\\n\'; exit 0; fi\n'
        f"printf '{BANNER}\\n'\n",
    )


def write_firmware_fixture() -> None:
    RENODE_ELF.parent.mkdir(parents=True, exist_ok=True)
    RENODE_ELF.write_text("unit-test elf placeholder\n")


def run_script(args: list[str], env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    merged = os.environ.copy()
    merged.update(env)
    return subprocess.run(
        [str(RUN_RENODE), *args],
        cwd=ROOT,
        env=merged,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )


def run_check(env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return run_script(["--check"], env)


def assert_contains(text: str, expected: str) -> None:
    if expected not in text:
        raise AssertionError(f"missing {expected!r} in output:\n{text}")


def assert_false_claim_flags(report: dict) -> None:
    for key in (
        "phone_claim_allowed",
        "release_claim_allowed",
        "hardware_boot_claim_allowed",
        "silicon_evidence_claim_allowed",
        "linux_boot_claim_allowed",
    ):
        if report.get(key) is not False:
            raise AssertionError(f"{key} must be false in Renode status report: {report}")


def test_missing_renode_is_non_strict_blocked() -> None:
    result = run_check(
        {"PATH": "/usr/bin:/bin", "REQUIRE_RENODE": "0", "ELIZA_RENODE_USE_REPO_TOOLS": "0"}
    )
    if result.returncode != 0:
        raise AssertionError(
            f"expected non-strict blocked check to exit 0, got {result.returncode}\n{result.stdout}"
        )
    assert_contains(result.stdout, "STATUS: PASS renode.semantic")
    assert_contains(result.stdout, "STATUS: BLOCKED renode.run")
    assert_contains(result.stdout, "STATUS: BLOCKED renode.check")
    assert_contains(result.stdout, "Renode install/preflight")
    assert_contains(result.stdout, "Renode executable missing: command -v renode failed")
    assert_contains(result.stdout, "version unavailable because renode --version could not run")
    assert_contains(result.stdout, "scripts/run_qemu.sh --build-firmware")
    assert_contains(result.stdout, "make renode-check")
    assert_false_claim_flags(json.loads((ROOT / "build/renode/eliza_e1_status.json").read_text()))


def test_missing_renode_is_strict_blocked() -> None:
    result = run_check(
        {"PATH": "/usr/bin:/bin", "REQUIRE_RENODE": "1", "ELIZA_RENODE_USE_REPO_TOOLS": "0"}
    )
    if result.returncode != 2:
        raise AssertionError(
            f"expected strict blocked check to exit 2, got {result.returncode}\n{result.stdout}"
        )
    assert_contains(result.stdout, "STATUS: BLOCKED renode.run")
    assert_contains(result.stdout, "Renode executable missing: command -v renode failed")


def test_transcript_intake_blocks_without_renode() -> None:
    with tempfile.TemporaryDirectory() as td:
        transcript = Path(td) / "renode.log"
        transcript.write_text(f"Renode serial analyzer\n{BANNER}\n")
        result = run_script(
            ["--check", "--transcript", str(transcript)],
            {"PATH": "/usr/bin:/bin", "ELIZA_RENODE_USE_REPO_TOOLS": "0"},
        )
    if result.returncode != 2:
        raise AssertionError(
            f"expected transcript intake without renode to exit 2, got {result.returncode}\n{result.stdout}"
        )
    assert_contains(result.stdout, "STATUS: PASS renode.semantic")
    assert_contains(result.stdout, "STATUS: BLOCKED renode.transcript")
    assert_contains(result.stdout, "cannot intake transcript without a local renode executable")


def test_transcript_intake_blocks_without_firmware() -> None:
    with tempfile.TemporaryDirectory() as td:
        bindir = Path(td) / "bin"
        bindir.mkdir()
        renode = bindir / "renode"
        write_renode_test_double(renode)
        RENODE_ELF.unlink(missing_ok=True)
        transcript = Path(td) / "renode.log"
        transcript.write_text(f"Renode serial analyzer\n{BANNER}\n")
        result = run_script(
            ["--check", "--transcript", str(transcript)],
            {"PATH": f"{bindir}:/usr/bin:/bin", "ELIZA_RENODE_USE_REPO_TOOLS": "0"},
        )
    if result.returncode != 2:
        raise AssertionError(
            f"expected transcript intake without firmware to exit 2, got {result.returncode}\n{result.stdout}"
        )
    assert_contains(result.stdout, "STATUS: PASS renode.semantic")
    assert_contains(result.stdout, "STATUS: BLOCKED renode.transcript")
    assert_contains(result.stdout, "run scripts/run_qemu.sh --build-firmware first")


def test_renode_with_firmware_fails_without_banner() -> None:
    with tempfile.TemporaryDirectory() as td:
        bindir = Path(td)
        renode = bindir / "renode"
        write_renode_test_double(renode)
        write_firmware_fixture()
        # Provide a valid QEMU transcript so the equivalence check passes;
        # the failure should come from Renode not printing the banner.
        qemu_log = Path(td) / "qemu_smoke.log"
        qemu_log.write_text(f"fake qemu output\n{BANNER}\n")
        result = run_check(
            {
                "PATH": f"{bindir}:/usr/bin:/bin",
                "REQUIRE_RENODE": "0",
                "RENODE_SMOKE_SECONDS": "1",
                "ELIZA_RENODE_USE_REPO_TOOLS": "0",
                "RENODE_QEMU_TRANSCRIPT": str(qemu_log),
            }
        )
    if result.returncode != 1:
        raise AssertionError(
            f"expected bounded Renode run without banner to exit 1, got {result.returncode}\n{result.stdout}"
        )
    assert_contains(result.stdout, "STATUS: PASS renode.semantic")
    assert_contains(result.stdout, "STATUS: PASS renode.preflight")
    assert_contains(result.stdout, "STATUS: FAIL renode.run")
    assert_contains(result.stdout, "build/renode/eliza_e1_uart.transcript")


def test_renode_with_firmware_and_banner_passes() -> None:
    with tempfile.TemporaryDirectory() as td:
        bindir = Path(td)
        renode = bindir / "renode"
        write_renode_banner_test_double(renode)
        write_firmware_fixture()
        # Provide a valid QEMU transcript so the equivalence check passes.
        qemu_log = Path(td) / "qemu_smoke.log"
        qemu_log.write_text(f"fake qemu output\n{BANNER}\n")
        result = run_check(
            {
                "PATH": f"{bindir}:/usr/bin:/bin",
                "REQUIRE_RENODE": "0",
                "RENODE_SMOKE_SECONDS": "1",
                "ELIZA_RENODE_USE_REPO_TOOLS": "0",
                "RENODE_QEMU_TRANSCRIPT": str(qemu_log),
            }
        )
    if result.returncode != 0:
        raise AssertionError(
            f"expected bounded Renode run with banner to exit 0, got {result.returncode}\n{result.stdout}"
        )
    assert_contains(result.stdout, "STATUS: PASS renode.transcript")
    assert_contains(result.stdout, "STATUS: PASS renode.check")
    assert_false_claim_flags(json.loads((ROOT / "build/renode/eliza_e1_status.json").read_text()))
    assert_contains(RENODE_ATTEMPT_LOG.read_text(errors="ignore"), BANNER)
    manifest = RENODE_JSON.read_text(errors="ignore")
    assert_contains(manifest, '"exit_code": 0')
    assert_contains(manifest, '"observed_banner": "eliza e1 qemu"')
    assert_contains(manifest, '"transcript": "build/renode/eliza_e1_uart.transcript"')


def test_invalid_transcript_fails_closed() -> None:
    with tempfile.TemporaryDirectory() as td:
        bindir = Path(td) / "bin"
        bindir.mkdir()
        renode = bindir / "renode"
        write_renode_test_double(renode)
        write_firmware_fixture()
        transcript = Path(td) / "renode.log"
        transcript.write_text("Renode started but no banner appeared\n")
        result = run_script(
            ["--check", "--transcript", str(transcript)],
            {"PATH": f"{bindir}:/usr/bin:/bin", "ELIZA_RENODE_USE_REPO_TOOLS": "0"},
        )
    if result.returncode != 1:
        raise AssertionError(
            f"expected invalid transcript to exit 1, got {result.returncode}\n{result.stdout}"
        )
    assert_contains(result.stdout, "STATUS: PASS renode.semantic")
    assert_contains(result.stdout, "STATUS: FAIL renode.transcript")


def test_empty_transcript_fails_closed_before_preflight() -> None:
    with tempfile.TemporaryDirectory() as td:
        transcript = Path(td) / "renode.log"
        transcript.write_text("")
        result = run_script(["--check", "--transcript", str(transcript)], {"PATH": "/usr/bin:/bin"})
    if result.returncode != 1:
        raise AssertionError(
            f"expected empty transcript to exit 1, got {result.returncode}\n{result.stdout}"
        )
    assert_contains(result.stdout, "STATUS: PASS renode.semantic")
    assert_contains(result.stdout, "STATUS: FAIL renode.transcript")
    assert_contains(result.stdout, "transcript is empty")


def test_valid_transcript_intake_archives_manifest() -> None:
    with tempfile.TemporaryDirectory() as td:
        bindir = Path(td) / "bin"
        bindir.mkdir()
        renode = bindir / "renode"
        write_renode_test_double(renode)
        write_firmware_fixture()
        transcript = Path(td) / "renode.log"
        transcript.write_text(f"Renode serial analyzer\n{BANNER}\n")
        result = run_script(
            ["--check", "--transcript", str(transcript)],
            {"PATH": f"{bindir}:/usr/bin:/bin", "ELIZA_RENODE_USE_REPO_TOOLS": "0"},
        )
    if result.returncode != 0:
        raise AssertionError(
            f"expected valid transcript intake to exit 0, got {result.returncode}\n{result.stdout}"
        )
    assert_contains(result.stdout, "STATUS: PASS renode.transcript")
    assert_contains(result.stdout, "STATUS: PASS renode.manifest")
    assert_contains(result.stdout, "STATUS: PASS renode.run")
    assert_contains(result.stdout, "STATUS: PASS renode.check")
    if not RENODE_LOG.is_file() or BANNER not in RENODE_LOG.read_text(errors="ignore"):
        raise AssertionError("expected archived Renode transcript to contain banner")
    manifest = RENODE_MANIFEST.read_text(errors="ignore") if RENODE_MANIFEST.is_file() else ""
    assert_contains(manifest, "status=PASS")
    assert_contains(manifest, "check=renode.run")
    assert_contains(manifest, "evidence_kind=renode-executable-transcript")
    assert_contains(manifest, "sha256=")
    assert_contains(manifest, f"banner={BANNER}")
    assert_contains(manifest, "banner_contract=sim/renode/expected_serial_banner.txt")
    assert_contains(manifest, "firmware=build/qemu/e1_qemu_firmware.elf")
    assert_contains(manifest, "firmware_sha256=")
    assert_contains(manifest, "renode_version=Renode test double 0.0")


def main() -> int:
    tests = [
        test_missing_renode_is_non_strict_blocked,
        test_missing_renode_is_strict_blocked,
        test_transcript_intake_blocks_without_renode,
        test_transcript_intake_blocks_without_firmware,
        test_renode_with_firmware_fails_without_banner,
        test_renode_with_firmware_and_banner_passes,
        test_invalid_transcript_fails_closed,
        test_empty_transcript_fails_closed_before_preflight,
        test_valid_transcript_intake_archives_manifest,
    ]
    saved = RENODE_ELF.read_bytes() if RENODE_ELF.is_file() else None
    saved_log = RENODE_LOG.read_bytes() if RENODE_LOG.is_file() else None
    saved_manifest = RENODE_MANIFEST.read_bytes() if RENODE_MANIFEST.is_file() else None
    saved_attempt_log = RENODE_ATTEMPT_LOG.read_bytes() if RENODE_ATTEMPT_LOG.is_file() else None
    try:
        for test in tests:
            test()
            print(f"PASS {test.__name__}")
    finally:
        if saved is None:
            RENODE_ELF.unlink(missing_ok=True)
        else:
            RENODE_ELF.parent.mkdir(parents=True, exist_ok=True)
            RENODE_ELF.write_bytes(saved)
        if saved_log is None:
            RENODE_LOG.unlink(missing_ok=True)
        else:
            RENODE_LOG.parent.mkdir(parents=True, exist_ok=True)
            RENODE_LOG.write_bytes(saved_log)
        if saved_manifest is None:
            RENODE_MANIFEST.unlink(missing_ok=True)
        else:
            RENODE_MANIFEST.parent.mkdir(parents=True, exist_ok=True)
            RENODE_MANIFEST.write_bytes(saved_manifest)
        if saved_attempt_log is None:
            RENODE_ATTEMPT_LOG.unlink(missing_ok=True)
        else:
            RENODE_ATTEMPT_LOG.parent.mkdir(parents=True, exist_ok=True)
            RENODE_ATTEMPT_LOG.write_bytes(saved_attempt_log)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
