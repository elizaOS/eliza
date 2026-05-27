#!/usr/bin/env python3
"""Regression-test fail-closed release gates for known prototype gaps."""

from __future__ import annotations

import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class Check:
    name: str
    command: list[str]
    expected_codes: set[int]
    required_tokens: tuple[str, ...]
    forbidden_tokens: tuple[str, ...] = ()
    env: dict[str, str] | None = None


def run_check(check: Check) -> list[str]:
    env = os.environ.copy()
    if check.env:
        env.update(check.env)

    proc = subprocess.run(
        check.command,
        cwd=REPO,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    output = proc.stdout
    failures: list[str] = []

    if proc.returncode not in check.expected_codes:
        failures.append(
            f"{check.name}: expected exit {sorted(check.expected_codes)}, got {proc.returncode}"
        )

    for token in check.required_tokens:
        if token not in output:
            failures.append(f"{check.name}: missing output token {token!r}")

    for token in check.forbidden_tokens:
        if token in output:
            failures.append(f"{check.name}: forbidden output token present {token!r}")

    if failures:
        print(f"FAIL {check.name}")
        print(output[-4000:])
        return failures

    print(f"PASS {check.name}")
    return []


def main() -> int:
    checks = [
        Check(
            name="baseline pipeline remains green",
            command=[sys.executable, "scripts/pipeline_check.py"],
            expected_codes={0},
            required_tokens=("Pipeline artifact check passed.",),
        ),
        Check(
            name="baseline mvp status remains reportable",
            command=[sys.executable, "scripts/check_mvp_status.py"],
            expected_codes={0},
            required_tokens=("STATUS SUBSYSTEM", "BLOCK"),
        ),
        Check(
            name="minimum Linux plus NPU target reports blocked without external boot proof",
            command=[sys.executable, "scripts/check_minimum_linux_npu_target.py"],
            expected_codes={0},
            required_tokens=("STATUS: BLOCKED minimum_linux_npu_target",),
        ),
        Check(
            name="minimum Linux plus NPU strict gate blocks missing boot proof",
            command=[sys.executable, "scripts/check_minimum_linux_npu_target.py", "--strict"],
            expected_codes={2},
            required_tokens=("STATUS: BLOCKED minimum_linux_npu_target",),
        ),
        Check(
            name="linux boot artifact strict gate blocks placeholder evidence",
            command=[sys.executable, "scripts/check_linux_boot_artifacts.py", "--require-pass"],
            expected_codes={2},
            required_tokens=("linux boot artifacts: BLOCKED",),
        ),
        Check(
            name="local NPU ML smoke proof regenerates deterministic evidence",
            command=[sys.executable, "scripts/check_mvp_npu_ml_evidence.py", "--run"],
            expected_codes={0},
            required_tokens=("STATUS: PASS mvp.npu_ml_smoke",),
        ),
        Check(
            name="product release blocks unfinished hardware evidence",
            command=[sys.executable, "scripts/product_check.py", "--release"],
            expected_codes={1},
            required_tokens=("product release check failed", "KiCad release blockers"),
        ),
        Check(
            name="SOTA parity strict audit blocks until full phone evidence exists",
            command=[sys.executable, "scripts/check_sota_parity_audit.py", "--strict"],
            expected_codes={2},
            required_tokens=("STATUS: BLOCKED sota_parity",),
        ),
        Check(
            name="software bsp evidence blocks missing external boot and Android logs",
            command=[sys.executable, "scripts/check_software_bsp.py", "all", "--require-evidence"],
            expected_codes={1},
            required_tokens=(
                "aosp BSP BLOCKED",
                "cuttlefish_riscv64_smoke.log",
                "u-boot BSP BLOCKED",
            ),
        ),
        Check(
            name="cpu ap evidence blocks missing production boot proof",
            command=[sys.executable, "scripts/check_cpu_ap_evidence.py", "--require-evidence"],
            expected_codes={1},
            required_tokens=("STATUS: BLOCKED cpu_ap.linux_evidence",),
        ),
        Check(
            name="renode strict blocks when renode is unavailable",
            command=["scripts/run_renode.sh", "--check"],
            expected_codes={2},
            required_tokens=("STATUS: BLOCKED renode.check", "Renode executable missing"),
            env={
                "PATH": "/usr/bin:/bin",
                "REQUIRE_RENODE": "1",
                "ELIZA_RENODE_USE_REPO_TOOLS": "0",
                "RENODE_STATUS_REPORT": "build/renode/unavailable-test-status.json",
            },
        ),
        Check(
            name="benchmark strict blocks missing calibrated assets",
            command=[
                sys.executable,
                "benchmarks/run_benchmarks.py",
                "run",
                "--metadata",
                "benchmarks/metadata/strict-blocked-template.json",
                "--strict-missing",
                "--report-id",
                "strict-release-gate-test",
            ],
            expected_codes={1, 2},
            required_tokens=("blocked", "missing"),
            forbidden_tokens=("schema error", "metadata validation failed"),
        ),
    ]

    failures: list[str] = []
    for check in checks:
        failures.extend(run_check(check))

    if failures:
        print("Strict release gate regression failed:")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    print("strict release gate regression passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
