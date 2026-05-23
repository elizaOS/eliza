#!/usr/bin/env python3
"""Tests for Chipyard Linux payload locator semantics."""

from __future__ import annotations

import json
import os
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/locate_chipyard_linux_payload.py"


def write_fake_riscv_elf(path: Path, *, opensbi: bool = True, linux: bool = True) -> None:
    header = bytearray(64)
    header[:4] = b"\x7fELF"
    header[4] = 2  # ELF64
    header[5] = 1  # little endian
    header[6] = 1
    struct.pack_into(
        "<HHIQQQIHHHHHH", header, 16, 2, 0xF3, 1, 0x80000000, 0, 0, 0, 64, 0, 0, 0, 0, 0
    )
    markers: list[bytes] = []
    if opensbi:
        markers.append(b"OpenSBI\n")
    if linux:
        markers.append(b"Linux version test\n")
    body = b"".join(markers)
    path.write_bytes(bytes(header) + body)


def run_locator(
    path: Path,
    *,
    require: bool = True,
    require_preferred: bool = False,
) -> subprocess.CompletedProcess[str]:
    env = {key: value for key, value in os.environ.items() if key != "CHIPYARD_LINUX_BINARY"}
    command = [
        sys.executable,
        str(SCRIPT),
        "--no-defaults",
        "--candidate",
        str(path),
        "--json",
    ]
    if require:
        command.append("--require")
    if require_preferred:
        command.append("--require-preferred")
    return subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        capture_output=True,
        env=env,
    )


def test_locator_accepts_riscv_opensbi_elf() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        payload = Path(tmpdir) / "payload.elf"
        write_fake_riscv_elf(payload)
        result = run_locator(payload)
        if result.returncode != 0:
            raise AssertionError(result.stdout + result.stderr)
        manifest = json.loads(result.stdout)
        if manifest["status"] != "pass":
            raise AssertionError(result.stdout)
        if manifest["selected_payload"] != str(payload):
            raise AssertionError(result.stdout)
        if manifest["selected_payload_role"] != "custom":
            raise AssertionError(result.stdout)


def test_locator_rejects_opensbi_without_linux_marker() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        payload = Path(tmpdir) / "payload.elf"
        write_fake_riscv_elf(payload, linux=False)
        result = run_locator(payload)
        if result.returncode == 0:
            raise AssertionError("locator accepted payload without Linux marker")
        manifest = json.loads(result.stdout)
        if manifest["status"] != "blocked":
            raise AssertionError(result.stdout)


def test_locator_rejects_linux_without_firmware_marker() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        payload = Path(tmpdir) / "payload.elf"
        write_fake_riscv_elf(payload, opensbi=False)
        env = {key: value for key, value in os.environ.items() if key != "CHIPYARD_LINUX_BINARY"}
        result = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--no-defaults",
                "--candidate",
                str(payload),
                "--candidate",
                str(Path(tmpdir) / "missing.elf"),
                "--json",
                "--require",
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
            env=env,
        )
        if result.returncode == 0:
            raise AssertionError("locator accepted payload without OpenSBI marker")
        manifest = json.loads(result.stdout)
        if manifest["status"] != "blocked":
            raise AssertionError(result.stdout)
        if "Build one with:" not in "\n".join(manifest["errors"]):
            raise AssertionError(result.stdout)


def test_locator_can_require_preferred_linux_smoke_payload() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        payload = Path(tmpdir) / "payload.elf"
        write_fake_riscv_elf(payload)
        result = run_locator(payload, require_preferred=True)
        if result.returncode == 0:
            raise AssertionError("locator accepted custom payload as preferred linux smoke payload")
        manifest = json.loads(result.stdout)
        if manifest["status"] != "pass":
            raise AssertionError(result.stdout)
        if manifest["selected_payload_preferred_for_linux_smoke"]:
            raise AssertionError(result.stdout)
        if "Preferred eliza-e1-linux-smoke nodisk payload" not in "\n".join(
            manifest["errors"]
        ):
            raise AssertionError(result.stdout)


def main() -> int:
    test_locator_accepts_riscv_opensbi_elf()
    test_locator_rejects_opensbi_without_linux_marker()
    test_locator_rejects_linux_without_firmware_marker()
    test_locator_can_require_preferred_linux_smoke_payload()
    print("chipyard linux payload locator tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
