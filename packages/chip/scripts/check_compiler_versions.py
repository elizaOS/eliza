#!/usr/bin/env python3
"""Record and validate the e1 compiler toolchain version surface.

This script extends `scripts/record_tool_versions.sh`'s host-tool inventory
with compiler-specific evidence:

  - LLVM stage 2 clang `--version`.
  - LLVM stage 2 lld `--version`.
  - llvm-bolt `--version`.
  - IREE iree-compile `--version`.
  - Pinned LLVM/IREE SHAs from the pin manifests.
  - LLVM minimum-release floor (llvm-21) enforced.

Output is written to `build/reports/compiler/compiler-versions.json` with
schema `eliza.compiler_versions.v1`.

Status terms (printed as `STATUS: <status> compiler.<stage>`).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
STAGE2 = REPO_ROOT / "build/llvm-stage2"
IREE_INSTALL = REPO_ROOT / "build/iree/install"
LLVM_PIN = REPO_ROOT / "compiler/llvm-build/llvm-pin.json"
IREE_PIN = REPO_ROOT / "compiler/iree-eliza-npu/iree-pin.json"
EXECUTORCH_PIN = REPO_ROOT / "compiler/executorch-eliza/executorch-pin.json"
NPU_ABI_HEADER = REPO_ROOT / "compiler/iree-eliza-npu/runtime/eliza_npu_runtime.h"

REPORT_DIR = REPO_ROOT / "build/reports/compiler"
REPORT_PATH = REPORT_DIR / "compiler-versions.json"
SCHEMA = "eliza.compiler_versions.v1"
LLVM_FLOOR_MAJOR = 21


def emit(status: str, stage: str, detail: str = "") -> None:
    if detail:
        print(f"STATUS: {status} compiler.{stage} — {detail}")
    else:
        print(f"STATUS: {status} compiler.{stage}")


def run_version(binary: Path) -> str | None:
    if not binary.exists():
        return None
    try:
        return subprocess.run(
            [str(binary), "--version"],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        ).stdout.strip()
    except subprocess.SubprocessError:
        return None


def parse_llvm_major(version_string: str | None) -> int | None:
    if not version_string:
        return None
    m = re.search(r"version\s+(\d+)", version_string)
    if not m:
        return None
    return int(m.group(1))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--strict", action="store_true", help="exit non-zero on BLOCKED entries")
    args = parser.parse_args()

    REPORT_DIR.mkdir(parents=True, exist_ok=True)

    clang_version = run_version(STAGE2 / "bin/clang")
    lld_version = run_version(STAGE2 / "bin/ld.lld")
    bolt_version = run_version(STAGE2 / "bin/llvm-bolt")
    iree_version = run_version(IREE_INSTALL / "bin/iree-compile")

    llvm_pin: dict = {}
    iree_pin: dict = {}
    executorch_pin: dict = {}
    if LLVM_PIN.exists():
        llvm_pin = json.loads(LLVM_PIN.read_text())
    if IREE_PIN.exists():
        iree_pin = json.loads(IREE_PIN.read_text())
    if EXECUTORCH_PIN.exists():
        executorch_pin = json.loads(EXECUTORCH_PIN.read_text())

    npu_abi_hash: str | None = None
    if NPU_ABI_HEADER.exists():
        npu_abi_hash = hashlib.sha256(NPU_ABI_HEADER.read_bytes()).hexdigest()

    def pin_sha(pin: dict) -> str | None:
        upstream = pin.get("upstream") or {}
        if not isinstance(upstream, dict):
            return None
        sha = upstream.get("commit_sha")
        return sha if isinstance(sha, str) else None

    llvm_major = parse_llvm_major(clang_version)
    record: dict[str, object] = {
        "schema": SCHEMA,
        "llvm": {
            "clang_version": clang_version,
            "lld_version": lld_version,
            "bolt_version": bolt_version,
            "stage2_dir": str(STAGE2),
            "pin_sha": pin_sha(llvm_pin),
            "major": llvm_major,
            "minimum_floor": LLVM_FLOOR_MAJOR,
        },
        "iree": {
            "iree_compile_version": iree_version,
            "install_dir": str(IREE_INSTALL),
            "pin_sha": pin_sha(iree_pin),
        },
        "executorch": {
            "pin_sha": pin_sha(executorch_pin),
        },
        "npu_abi": {
            "header": str(NPU_ABI_HEADER),
            "sha256": npu_abi_hash,
            "purpose": (
                "single hash for the C ABI consumed by IREE codegen; drift "
                "against compiler/runtime/e1_npu_runtime.py or rtl/npu/e1_npu.sv "
                "is caught by compiler/iree-eliza-npu/tests/test_runtime_mmio_parity.py"
            ),
        },
    }
    REPORT_PATH.write_text(json.dumps(record, indent=2, sort_keys=True))

    blocked = False
    if clang_version is None:
        emit("BLOCKED", "clang", "stage 2 not built")
        blocked = True
    else:
        emit("PASS", "clang", clang_version.splitlines()[0])
        if llvm_major is not None and llvm_major < LLVM_FLOOR_MAJOR:
            emit("FAIL", "llvm_floor", f"clang major {llvm_major} < floor {LLVM_FLOOR_MAJOR}")
            return 1

    if lld_version is None:
        emit("BLOCKED", "lld")
        blocked = True
    else:
        emit("PASS", "lld", lld_version.splitlines()[0])

    if bolt_version is None:
        emit("BLOCKED", "bolt")
        blocked = True
    else:
        emit("PASS", "bolt", bolt_version.splitlines()[0])

    if iree_version is None:
        emit("BLOCKED", "iree")
        blocked = True
    else:
        emit("PASS", "iree", iree_version.splitlines()[0])

    return 2 if (args.strict and blocked) else 0


if __name__ == "__main__":
    sys.exit(main())
