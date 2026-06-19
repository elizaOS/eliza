#!/usr/bin/env python3
"""Regression tests for evidence provenance sanitizers."""

from __future__ import annotations

from pathlib import Path

from provenance_sanitize import ROOT, sanitize_host_local_paths, sanitize_log_file


def test_sanitize_host_local_paths_preserves_repo_relative_context() -> None:
    raw = "\n".join(
        [
            f"{ROOT}/verify/cocotb/integration/Makefile.opensbi-cva6-boot",
            f"{ROOT}/external/cva6/cva6/core/raw_checker.sv:50:41:",
            "/tmp/eliza-boot/sim.log",
        ]
    )

    sanitized = sanitize_host_local_paths(raw)

    assert "/home/" not in sanitized
    assert "/tmp/" not in sanitized
    assert "packages/chip/verify/cocotb/integration/Makefile.opensbi-cva6-boot" in sanitized
    assert "packages/chip/external/cva6/cva6/core/raw_checker.sv:50:41:" in sanitized
    assert "<host-tmp>/sim.log" in sanitized


def test_sanitize_log_file_rewrites_in_place(tmp_path: Path) -> None:
    log = tmp_path / "gate.log"
    log.write_text(f"include {ROOT}/.venv/lib/python3.12/site-packages/cocotb\n")

    sanitized = sanitize_log_file(log)

    assert sanitized == log.read_text()
    assert "/home/" not in sanitized
    assert "packages/chip/.venv/lib/python3.12/site-packages/cocotb" in sanitized


def test_sanitize_log_file_replaces_read_only_file_when_directory_is_writable(
    tmp_path: Path,
) -> None:
    log = tmp_path / "readonly.log"
    log.write_text(f"include {ROOT}/build/out\n")
    log.chmod(0o444)
    try:
        sanitized = sanitize_log_file(log)
    finally:
        log.chmod(0o644)

    assert sanitized == log.read_text()
    assert "/home/" not in sanitized
    assert "packages/chip/build/out" in sanitized


if __name__ == "__main__":
    test_sanitize_host_local_paths_preserves_repo_relative_context()
    from tempfile import TemporaryDirectory

    with TemporaryDirectory() as raw:
        test_sanitize_log_file_rewrites_in_place(Path(raw))
    with TemporaryDirectory() as raw:
        test_sanitize_log_file_replaces_read_only_file_when_directory_is_writable(Path(raw))
    print("provenance sanitizer tests passed")
