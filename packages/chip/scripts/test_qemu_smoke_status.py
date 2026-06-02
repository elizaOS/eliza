#!/usr/bin/env python3
"""Unit tests for scripts/run_qemu.sh status reporting.

The tests use fake RISC-V compiler and QEMU executables so the repo can verify
PASS/BLOCKED/FAIL behavior without installing external packages.
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUN_QEMU = ROOT / "scripts/run_qemu.sh"
QEMU_ELF = ROOT / "build/qemu/e1_qemu_firmware.elf"
QEMU_LOG = ROOT / "build/reports/qemu_smoke.log"
QEMU_MANIFEST = ROOT / "build/reports/qemu_smoke.manifest"
QEMU_OS_ATTEMPT_LOG = ROOT / "build/reports/qemu_os_boot_attempt.log"
QEMU_OS_ATTEMPT_MANIFEST = ROOT / "build/reports/qemu_os_boot_attempt.json"


def write_executable(path: Path, text: str) -> None:
    path.write_text(text)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def link_host_tools(bindir: Path, *names: str) -> None:
    for name in names:
        host_tool = shutil.which(name)
        if host_tool is None:
            raise AssertionError(f"missing host tool required by test: {name}")
        (bindir / name).symlink_to(host_tool)


def run_check(env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    merged = os.environ.copy()
    merged.update(env)
    return subprocess.run(
        [str(RUN_QEMU), "--check"],
        cwd=ROOT,
        env=merged,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )


def run_os_check(
    env: dict[str, str], extra_args: list[str] | None = None
) -> subprocess.CompletedProcess[str]:
    merged = os.environ.copy()
    merged.update(env)
    command = [str(RUN_QEMU), "--check-os"]
    if extra_args:
        command.extend(extra_args)
    return subprocess.run(
        command,
        cwd=ROOT,
        env=merged,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )


def assert_contains(text: str, expected: str) -> None:
    if expected not in text:
        raise AssertionError(f"missing {expected!r} in output:\n{text}")


def test_missing_toolchain_is_non_strict_blocked() -> None:
    result = run_check({"RISCV_CC": "definitely-missing-riscv-cc", "REQUIRE_QEMU": "0"})
    if result.returncode != 0:
        raise AssertionError(
            f"expected non-strict blocked check to exit 0, got {result.returncode}\n{result.stdout}"
        )
    assert_contains(result.stdout, "STATUS: PASS qemu.semantic")
    assert_contains(result.stdout, "STATUS: BLOCKED qemu.build")
    assert_contains(result.stdout, "STATUS: BLOCKED qemu.check")


def test_missing_toolchain_is_strict_blocked() -> None:
    result = run_check({"RISCV_CC": "definitely-missing-riscv-cc", "REQUIRE_QEMU": "1"})
    if result.returncode != 2:
        raise AssertionError(
            f"expected strict blocked check to exit 2, got {result.returncode}\n{result.stdout}"
        )
    assert_contains(result.stdout, "STATUS: BLOCKED qemu.check")


def test_build_failure_is_fail() -> None:
    with tempfile.TemporaryDirectory() as td:
        bindir = Path(td)
        cc = bindir / "fake-riscv-gcc"
        write_executable(
            cc,
            "#!/bin/sh\necho fake compiler failure >&2\nexit 1\n",
        )
        result = run_check({"RISCV_CC": str(cc)})
    if result.returncode != 1:
        raise AssertionError(
            f"expected build failure to exit 1, got {result.returncode}\n{result.stdout}"
        )
    assert_contains(result.stdout, "STATUS: FAIL qemu.build")


def test_autodetected_clang_without_lld_is_blocked() -> None:
    with tempfile.TemporaryDirectory() as td:
        bindir = Path(td)
        link_host_tools(bindir, "cat", "dirname", "grep", "mkdir", "rm", "rmdir", "sh")
        clang = bindir / "clang"
        write_executable(
            clang,
            "#!/bin/sh\n"
            'case "$*" in\n'
            "  *-fuse-ld=lld*) echo 'clang: error: invalid linker name in argument' >&2; exit 1 ;;\n"
            "  *) exit 0 ;;\n"
            "esac\n",
        )
        result = run_check(
            {
                "PATH": str(bindir),
                "RISCV_CC": "",
                "RISCV_CLANG_CANDIDATES": "clang",
                "REQUIRE_QEMU": "0",
                "ELIZA_RUN_QEMU_DISABLE_REPO_TOOLS": "1",
            }
        )
    if result.returncode != 0:
        raise AssertionError(
            f"expected missing lld to be non-strict BLOCKED, got {result.returncode}\n{result.stdout}"
        )
    assert_contains(result.stdout, "STATUS: PASS qemu.semantic")
    assert_contains(result.stdout, "STATUS: BLOCKED qemu.build")


def test_fake_toolchain_and_qemu_pass() -> None:
    QEMU_ELF.unlink(missing_ok=True)
    with tempfile.TemporaryDirectory() as td:
        bindir = Path(td)
        cc = bindir / "fake-riscv-gcc"
        qemu = bindir / "qemu-system-riscv64"
        write_executable(
            cc,
            "#!/bin/sh\n"
            "out=\n"
            'while [ "$#" -gt 0 ]; do\n'
            '  if [ "$1" = "-o" ]; then shift; out=$1; fi\n'
            "  shift || true\n"
            "done\n"
            '[ -n "$out" ] || exit 1\n'
            'mkdir -p "$(dirname "$out")"\n'
            "printf 'fake elf\\n' > \"$out\"\n",
        )
        write_executable(
            qemu,
            "#!/bin/sh\nprintf 'eliza e1 qemu\\n'\n",
        )
        result = run_check(
            {
                "RISCV_CC": str(cc),
                "PATH": f"{bindir}:{os.environ['PATH']}",
                "QEMU_SMOKE_SECONDS": "1",
            }
        )
    if result.returncode != 0:
        raise AssertionError(
            f"expected fake executable smoke to pass, got {result.returncode}\n{result.stdout}"
        )
    assert_contains(result.stdout, "STATUS: PASS qemu.build")
    assert_contains(result.stdout, "STATUS: PASS qemu.run")
    assert_contains(result.stdout, "STATUS: PASS qemu.check")
    assert_contains(QEMU_LOG.read_text(errors="ignore"), "eliza e1 qemu")
    manifest = QEMU_MANIFEST.read_text(errors="ignore")
    assert_contains(manifest, "status=PASS")
    assert_contains(manifest, "check=qemu.run")
    assert_contains(manifest, "evidence_kind=qemu-executable-transcript")
    assert_contains(manifest, "phone_claim_allowed=false")
    assert_contains(manifest, "release_claim_allowed=false")
    assert_contains(manifest, "hardware_boot_claim_allowed=false")
    assert_contains(manifest, "silicon_evidence_claim_allowed=false")
    assert_contains(manifest, "linux_boot_claim_allowed=false")
    assert_contains(manifest, "banner=eliza e1 qemu")


def test_os_boot_check_blocks_without_payloads() -> None:
    result = run_os_check(
        {"PATH": os.environ["PATH"]},
        ["--linux-kernel", "/no/such/eliza/Image", "--initrd", "/no/such/eliza/initrd"],
    )
    if result.returncode != 2:
        raise AssertionError(
            f"expected OS boot preflight to block without payloads, got {result.returncode}\n{result.stdout}"
        )
    assert_contains(result.stdout, "STATUS: PASS qemu.semantic")
    assert_contains(result.stdout, "STATUS: BLOCKED qemu.os_boot")
    assert_contains(result.stdout, "Linux kernel Image")
    assert_contains(result.stdout, "initrd/rootfs image")
    assert_contains(result.stdout, "qemu_os_boot_attempt.log")
    attempt = (
        QEMU_OS_ATTEMPT_LOG.read_text(errors="ignore") if QEMU_OS_ATTEMPT_LOG.is_file() else ""
    )
    assert_contains(attempt, "status=BLOCKED")
    assert_contains(attempt, "check=qemu.os_boot")
    assert_contains(attempt, "kernel=/no/such/eliza/Image")
    assert_contains(attempt, "kernel_sha256=missing")
    assert_contains(attempt, "initrd=/no/such/eliza/initrd")
    assert_contains(attempt, "initrd_sha256=missing")
    manifest = json.loads(QEMU_OS_ATTEMPT_MANIFEST.read_text())
    if manifest["schema"] != "eliza.qemu_virt_os_boot_attempt.v1":
        raise AssertionError(f"unexpected OS attempt schema: {manifest}")
    if manifest["claim_boundary"] != "qemu_virt_reference_only_not_e1_chip_rtl":
        raise AssertionError(f"unexpected OS attempt claim boundary: {manifest}")
    for key in (
        "phone_claim_allowed",
        "release_claim_allowed",
        "hardware_boot_claim_allowed",
        "silicon_evidence_claim_allowed",
        "linux_boot_claim_allowed",
    ):
        if manifest.get(key) is not False:
            raise AssertionError(f"{key} must be false in OS attempt manifest: {manifest}")
    if manifest["status"] != "BLOCKED":
        raise AssertionError(f"unexpected OS attempt status: {manifest}")
    if manifest["kernel"] != "/no/such/eliza/Image":
        raise AssertionError(f"unexpected OS attempt kernel field: {manifest}")
    if manifest["initrd"] != "/no/such/eliza/initrd":
        raise AssertionError(f"unexpected OS attempt payload fields: {manifest}")


def test_os_boot_check_fails_on_kernel_panic() -> None:
    with tempfile.TemporaryDirectory() as td:
        bindir = Path(td) / "bin"
        bindir.mkdir()
        qemu = bindir / "qemu-system-riscv64"
        kernel = Path(td) / "Image"
        initrd = Path(td) / "rootfs.cpio"
        kernel.write_text("kernel placeholder\n")
        initrd.write_text("initrd placeholder\n")
        write_executable(
            qemu,
            "#!/bin/sh\n"
            "printf '[    0.10] Run /init as init process\\n'\n"
            "printf '[    0.11] Kernel panic - not syncing: No working init found\\n'\n",
        )
        result = run_os_check(
            {
                "PATH": f"{bindir}:{os.environ['PATH']}",
                "QEMU_OS_BOOT_SECONDS": "1",
            },
            ["--linux-kernel", str(kernel), "--initrd", str(initrd)],
        )
    if result.returncode != 1:
        raise AssertionError(
            f"expected kernel panic OS boot to fail, got {result.returncode}\n{result.stdout}"
        )
    assert_contains(result.stdout, "STATUS: FAIL qemu.os_boot")
    assert_contains(result.stdout, "kernel panic")
    manifest = json.loads(QEMU_OS_ATTEMPT_MANIFEST.read_text())
    if manifest["status"] != "FAIL":
        raise AssertionError(f"unexpected OS attempt status: {manifest}")


def test_os_boot_check_passes_with_payloads_and_init_marker() -> None:
    with tempfile.TemporaryDirectory() as td:
        bindir = Path(td) / "bin"
        bindir.mkdir()
        qemu = bindir / "qemu-system-riscv64"
        kernel = Path(td) / "Image"
        initrd = Path(td) / "rootfs.cpio"
        dtb = Path(td) / "virt.dtb"
        kernel.write_text("kernel placeholder\n")
        initrd.write_text("initrd placeholder\n")
        dtb.write_text("dtb placeholder\n")
        write_executable(
            qemu,
            "#!/bin/sh\n"
            "printf '[    0.10] Freeing unused kernel memory\\n'\n"
            "printf '[    0.11] Run /init as init process\\n'\n"
            "printf 'Debian GNU/Linux installer\\n'\n",
        )
        result = run_os_check(
            {
                "PATH": f"{bindir}:{os.environ['PATH']}",
                "QEMU_OS_BOOT_SECONDS": "1",
            },
            [
                "--linux-kernel",
                str(kernel),
                "--initrd",
                str(initrd),
                "--dtb",
                str(dtb),
            ],
        )
    if result.returncode != 0:
        raise AssertionError(
            f"expected payload-present OS boot to pass, got {result.returncode}\n{result.stdout}"
        )
    assert_contains(result.stdout, "STATUS: PASS qemu.semantic")
    assert_contains(result.stdout, "STATUS: PASS qemu.os_boot")
    assert_contains(result.stdout, "qemu_os_boot_attempt.log")
    transcript = QEMU_OS_ATTEMPT_LOG.read_text(errors="ignore")
    assert_contains(transcript, "Run /init as init process")
    assert_contains(transcript, "Debian GNU/Linux installer")
    manifest = json.loads(QEMU_OS_ATTEMPT_MANIFEST.read_text())
    if manifest["status"] != "PASS":
        raise AssertionError(f"unexpected OS attempt status: {manifest}")
    assert_contains(manifest["generated_utc"], "+00:00")
    if manifest["claim_boundary"] != "qemu_virt_reference_only_not_e1_chip_rtl":
        raise AssertionError(f"unexpected OS attempt claim boundary: {manifest}")
    if manifest["kernel"] != str(kernel):
        raise AssertionError(f"unexpected OS attempt kernel field: {manifest}")
    if manifest["initrd"] != str(initrd):
        raise AssertionError(f"unexpected OS attempt initrd field: {manifest}")
    if manifest["dtb"] != str(dtb):
        raise AssertionError(f"unexpected OS attempt dtb field: {manifest}")
    if manifest["transcript"] != "build/reports/qemu_os_boot_attempt.log":
        raise AssertionError(f"unexpected OS attempt transcript field: {manifest}")


def main() -> int:
    tests = [
        test_missing_toolchain_is_non_strict_blocked,
        test_missing_toolchain_is_strict_blocked,
        test_build_failure_is_fail,
        test_autodetected_clang_without_lld_is_blocked,
        test_fake_toolchain_and_qemu_pass,
        test_os_boot_check_blocks_without_payloads,
        test_os_boot_check_fails_on_kernel_panic,
        test_os_boot_check_passes_with_payloads_and_init_marker,
    ]
    saved = QEMU_ELF.read_bytes() if QEMU_ELF.is_file() else None
    saved_log = QEMU_LOG.read_bytes() if QEMU_LOG.is_file() else None
    saved_manifest = QEMU_MANIFEST.read_bytes() if QEMU_MANIFEST.is_file() else None
    saved_os_attempt_log = (
        QEMU_OS_ATTEMPT_LOG.read_bytes() if QEMU_OS_ATTEMPT_LOG.is_file() else None
    )
    saved_os_attempt_manifest = (
        QEMU_OS_ATTEMPT_MANIFEST.read_bytes() if QEMU_OS_ATTEMPT_MANIFEST.is_file() else None
    )
    try:
        for test in tests:
            test()
            print(f"PASS {test.__name__}")
    finally:
        if saved is None:
            QEMU_ELF.unlink(missing_ok=True)
        else:
            QEMU_ELF.parent.mkdir(parents=True, exist_ok=True)
            QEMU_ELF.unlink(missing_ok=True)
            QEMU_ELF.write_bytes(saved)
        if saved_log is None:
            QEMU_LOG.unlink(missing_ok=True)
        else:
            QEMU_LOG.parent.mkdir(parents=True, exist_ok=True)
            QEMU_LOG.write_bytes(saved_log)
        if saved_manifest is None:
            QEMU_MANIFEST.unlink(missing_ok=True)
        else:
            QEMU_MANIFEST.parent.mkdir(parents=True, exist_ok=True)
            QEMU_MANIFEST.write_bytes(saved_manifest)
        if saved_os_attempt_log is None:
            QEMU_OS_ATTEMPT_LOG.unlink(missing_ok=True)
        else:
            QEMU_OS_ATTEMPT_LOG.parent.mkdir(parents=True, exist_ok=True)
            QEMU_OS_ATTEMPT_LOG.write_bytes(saved_os_attempt_log)
        if saved_os_attempt_manifest is None:
            QEMU_OS_ATTEMPT_MANIFEST.unlink(missing_ok=True)
        else:
            QEMU_OS_ATTEMPT_MANIFEST.parent.mkdir(parents=True, exist_ok=True)
            QEMU_OS_ATTEMPT_MANIFEST.write_bytes(saved_os_attempt_manifest)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
