#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class PreserveFile:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.saved: bytes | None = None
        self.existed = False

    def __enter__(self) -> None:
        self.existed = self.path.exists()
        if self.existed:
            self.saved = self.path.read_bytes()

    def __exit__(self, exc_type, exc, tb) -> None:
        if self.existed and self.saved is not None:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_bytes(self.saved)
        elif self.path.exists():
            self.path.unlink()


def run_script(script: str, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    merged = os.environ.copy()
    merged.update(env)
    return subprocess.run(
        [str(ROOT / script)],
        cwd=ROOT,
        env=merged,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )


def load_result(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def test_jetstream_rejects_empty_engine_directory() -> None:
    result_path = ROOT / "benchmarks/results/cpu/jetstream/result.json"
    engine_dir = ROOT / "external/v8-riscv64"
    if engine_dir.exists():
        raise AssertionError(f"test expects no pre-existing {engine_dir}")
    with PreserveFile(result_path):
        engine_dir.mkdir(parents=True)
        try:
            proc = run_script("scripts/run_jetstream.sh", {"E1_JETSTREAM_ENGINE_BIN": ""})
            result = load_result(result_path)
        finally:
            shutil.rmtree(engine_dir)
    if proc.returncode != 0:
        raise AssertionError(proc.stdout)
    reason = result.get("reason", "")
    if "no executable JS engine RISC-V build available" not in reason:
        raise AssertionError(result)
    print("PASS JetStream rejects empty engine directory")


def test_jetstream_accepts_explicit_engine_before_dut_gate() -> None:
    result_path = ROOT / "benchmarks/results/cpu/jetstream/result.json"
    with tempfile.TemporaryDirectory() as tmp, PreserveFile(result_path):
        engine = Path(tmp) / "d8"
        engine.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        engine.chmod(0o755)
        proc = run_script(
            "scripts/run_jetstream.sh",
            {"E1_JETSTREAM_ENGINE_BIN": str(engine), "E1_JETSTREAM_DUT": ""},
        )
        result = load_result(result_path)
    if proc.returncode != 0:
        raise AssertionError(proc.stdout)
    if "E1_JETSTREAM_DUT not set" not in result.get("reason", ""):
        raise AssertionError(result)
    print("PASS JetStream explicit engine reaches DUT gate")


def test_spec_fake_install_reaches_target_runner_or_llvm_gate() -> None:
    result_path = ROOT / "benchmarks/results/cpu/spec/result.json"
    with tempfile.TemporaryDirectory() as tmp, PreserveFile(result_path):
        spec = Path(tmp) / "spec"
        (spec / "bin").mkdir(parents=True)
        runcpu = spec / "bin/runcpu"
        runcpu.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        runcpu.chmod(0o755)
        (spec / "version.txt").write_text("SPEC CPU2017 v1.1.9\n", encoding="utf-8")
        proc = run_script(
            "scripts/run_spec.sh",
            {"SPEC_DIR": str(spec), "E1_SPEC_DUT": "verilator"},
        )
        result = load_result(result_path)
    if proc.returncode != 0:
        raise AssertionError(proc.stdout)
    reason = result.get("reason", "")
    if (
        "no target runner is implemented yet" not in reason
        and "pinned LLVM RISC-V clang absent" not in reason
    ):
        raise AssertionError(result)
    if "compiler agent's pinned LLVM" in reason:
        raise AssertionError(result)
    print("PASS SPEC skeleton reports current concrete blocker")


def main() -> None:
    test_jetstream_rejects_empty_engine_directory()
    test_jetstream_accepts_explicit_engine_before_dut_gate()
    test_spec_fake_install_reaches_target_runner_or_llvm_gate()


if __name__ == "__main__":
    main()
