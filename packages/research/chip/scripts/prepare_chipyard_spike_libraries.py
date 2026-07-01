#!/usr/bin/env python3
"""Prepare repo-local Spike/FESVR libraries for the Chipyard Verilator harness."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECKOUT = Path(os.environ.get("CHIPYARD_CHECKOUT", ROOT / "external/chipyard"))
SPIKE = CHECKOUT / "toolchains/riscv-tools/riscv-isa-sim"
BUILD = SPIKE / "build"
PREFIX = Path(os.environ.get("RISCV", ROOT / "tools"))
JOBS = os.environ.get("CHIPYARD_SPIKE_JOBS", os.environ.get("NPROC", "2"))

ARCHIVES = (
    "libfesvr.a",
    "libriscv.a",
    "libdisasm.a",
    "libfdt.a",
    "libsoftfloat.a",
    "libcustomext.a",
)
MERGED_ARCHIVES = ("libdisasm.a", "libfdt.a", "libsoftfloat.a", "libcustomext.a")
EXCLUDED_RISCV_OBJECTS = ("remote_bitbang.o", "sim.o", "interactive.o")
HEADER_DIRS = ("fesvr", "riscv", "fdt", "softfloat", "debug_rom")
GENERATED_RISCV_HEADERS = ("config.h", "insn_list.h")


def run(command: list[str], *, cwd: Path | None = None) -> None:
    subprocess.run(command, cwd=cwd, check=True)


def copy_headers() -> None:
    include = PREFIX / "include"
    for header_dir in HEADER_DIRS:
        source_dir = SPIKE / header_dir
        destination_dir = include / header_dir
        if not source_dir.is_dir():
            raise SystemExit(f"missing Spike header directory: {source_dir}")
        destination_dir.mkdir(parents=True, exist_ok=True)
        for source in source_dir.glob("*.h"):
            shutil.copy2(source, destination_dir / source.name)

    riscv_include = include / "riscv"
    riscv_include.mkdir(parents=True, exist_ok=True)
    for header in GENERATED_RISCV_HEADERS:
        source = BUILD / header
        if not source.is_file():
            raise SystemExit(f"missing generated Spike header: {source}")
        shutil.copy2(source, riscv_include / source.name)


def merge_archive_objects(target: Path, archives: tuple[str, ...]) -> None:
    with tempfile.TemporaryDirectory() as temp:
        tempdir = Path(temp)
        object_paths: list[Path] = []
        for archive_name in archives:
            archive_dir = tempdir / archive_name
            archive_dir.mkdir()
            archive = PREFIX / "lib" / archive_name
            run(["ar", "x", str(archive)], cwd=archive_dir)
            for member in sorted(archive_dir.glob("*.o")):
                object_paths.append(member)
        if object_paths:
            run(["ar", "rcs", str(target), *(str(path) for path in object_paths)])


def main() -> int:
    if not SPIKE.is_dir():
        raise SystemExit(
            "missing Chipyard riscv-isa-sim checkout; run scripts/bootstrap_chipyard.sh"
        )

    BUILD.mkdir(parents=True, exist_ok=True)
    makefile = BUILD / "Makefile"
    if not makefile.is_file():
        configure = SPIKE / "configure"
        if not configure.is_file():
            raise SystemExit(f"missing Spike configure script: {configure}")
        run(
            [
                str(configure),
                f"--prefix={PREFIX}",
                "--with-boost=no",
                "--with-boost-asio=no",
                "--with-boost-regex=no",
            ],
            cwd=BUILD,
        )

    run(["make", "-C", str(BUILD), "-j", JOBS, *ARCHIVES])

    libdir = PREFIX / "lib"
    libdir.mkdir(parents=True, exist_ok=True)
    for archive_name in ARCHIVES:
        source = BUILD / archive_name
        if not source.is_file():
            raise SystemExit(f"missing built Spike archive: {source}")
        shutil.copy2(source, libdir / archive_name)

    copy_headers()

    riscv_archive = libdir / "libriscv.a"
    for object_name in EXCLUDED_RISCV_OBJECTS:
        run(["ar", "d", str(riscv_archive), object_name])
    merge_archive_objects(riscv_archive, MERGED_ARCHIVES)

    print(f"STATUS: PASS chipyard.spike_libraries - installed under {PREFIX}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
