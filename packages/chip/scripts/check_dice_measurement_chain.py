#!/usr/bin/env python3
"""Gate for the E1 DICE measurement chain (W6, fw/dice/).

Writes an eliza.gate_status.v1 report to
build/reports/gate-dice-measurement-chain-check.json. PASS requires, in order:

  1. Every referenced source exists on disk (cdi.{c,h}, ed25519_sign.{c,h},
     tests/test_cdi_chain.c, the two docs). No source => BLOCKED, not PASS.
  2. ``make -C fw/dice host`` compiles the ladder + KAT test clean
     (-Wall -Wextra -Werror -Wconversion).
  3. The host test runs and exits 0 with the terminal line
     "DICE CDI chain test PASS" (HKDF/HMAC/Ed25519 KATs + CDI determinism +
     tamper divergence + DeviceID/Alias derivation).
  4. ``make -C fw/dice target`` cross-compiles the freestanding
     riscv64-unknown-elf objects, proving the ladder builds for the RoT target.

This replaces the prior self-asserting report that referenced source files
which did not exist on disk. The gate is now backed by executable evidence.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

CHIP_ROOT = Path(__file__).resolve().parents[1]
DICE_DIR = CHIP_ROOT / "fw/dice"
HOST_BIN = CHIP_ROOT / "build/dice/test_cdi_chain"
REPORT_PATH = CHIP_ROOT / "build/reports/gate-dice-measurement-chain-check.json"
GATE = "dice-measurement-chain-check"
BLOCKER_ID = "dice_measurement_chain_check_failed"

EVIDENCE_PATHS = [
    "docs/sw/security/dice-chain.md",
    "docs/sw/security/dice-rot-binding.md",
    "fw/dice/cdi.c",
    "fw/dice/cdi.h",
    "fw/dice/ed25519_sign.c",
    "fw/dice/ed25519_sign.h",
    "fw/dice/tests/test_cdi_chain.c",
]

PASS_LINE = "DICE CDI chain test PASS"

FALSE_CLAIM_FLAGS = {
    "release_claim_allowed": False,
    "hardware_uds_claim_allowed": False,
    "silicon_entropy_claim_allowed": False,
    "provisioned_identity_claim_allowed": False,
    "secure_boot_release_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}


def _toolchain_env() -> dict[str, str]:
    """Prepend the native cross-toolchain bins so riscv64-unknown-elf-gcc and
    host gcc resolve even when tools/env.sh was not sourced."""
    env = os.environ.copy()
    extra = [
        CHIP_ROOT / "external/oss-cad-suite/bin",
        CHIP_ROOT / "external/deb-tools/bin",
        CHIP_ROOT / "external/xpack-riscv/bin",
    ]
    prefix = os.pathsep.join(str(p) for p in extra if p.is_dir())
    if prefix:
        env["PATH"] = f"{prefix}{os.pathsep}{env.get('PATH', '')}"
    return env


def _make(target: str) -> tuple[bool, str]:
    proc = subprocess.run(
        ["make", "-C", str(DICE_DIR), target],
        cwd=CHIP_ROOT,
        capture_output=True,
        text=True,
        env=_toolchain_env(),
    )
    ok = proc.returncode == 0
    detail = "ok" if ok else (proc.stderr.strip() or proc.stdout.strip())[-700:]
    return ok, detail


def run_host_test() -> tuple[bool, str]:
    ok, detail = _make("host")
    if not ok:
        return False, f"host build failed: {detail}"
    proc = subprocess.run(
        [str(HOST_BIN)],
        cwd=CHIP_ROOT,
        capture_output=True,
        text=True,
        env=_toolchain_env(),
    )
    out = proc.stdout.strip()
    last = out.splitlines()[-1] if out else ""
    if proc.returncode != 0:
        return False, f"test exited {proc.returncode}: {last}"
    if last != PASS_LINE:
        return False, f"unexpected terminal line: {last!r}"
    passes = sum(1 for ln in out.splitlines() if ln.startswith("PASS "))
    return True, f"{passes} checks passed; '{PASS_LINE}'"


def run_target_build() -> tuple[bool, str]:
    ok, detail = _make("target")
    if not ok:
        return False, f"riscv64 freestanding build failed: {detail}"
    objs = sorted((CHIP_ROOT / "build/dice").glob("*.rv64.o"))
    if not objs:
        return False, "no riscv64 objects produced"
    return True, f"{len(objs)} freestanding riscv64 object(s) built"


def main() -> int:
    report: dict[str, Any]
    now = datetime.now(UTC).isoformat()
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)

    missing = [p for p in EVIDENCE_PATHS if not (CHIP_ROOT / p).exists()]
    if missing:
        report = {
            "schema": "eliza.gate_status.v1",
            "gate": GATE,
            "status": "BLOCKED",
            "blocker_id": BLOCKER_ID,
            "blocker_reason": "missing source/doc: " + ", ".join(missing),
            "evidence_paths": [],
            "as_of": now,
            "subsystem": "security",
            **FALSE_CLAIM_FLAGS,
        }
        REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n")
        print(f"BLOCKED: missing {missing}", file=sys.stderr)
        return 1

    checks = []
    host_ok, host_detail = run_host_test()
    checks.append(
        {
            "id": "host_kat_and_chain_test",
            "status": "pass" if host_ok else "fail",
            "detail": host_detail,
        }
    )

    target_ok, target_detail = run_target_build()
    checks.append(
        {
            "id": "riscv64_freestanding_build",
            "status": "pass" if target_ok else "fail",
            "detail": target_detail,
        }
    )

    failures = [c["id"] for c in checks if c["status"] != "pass"]
    passed = not failures

    report = {
        "schema": "eliza.gate_status.v1",
        "gate": GATE,
        "status": "PASS" if passed else "BLOCKED",
        "blocker_id": None if passed else BLOCKER_ID,
        "blocker_reason": None if passed else "; ".join(failures),
        "evidence_paths": EVIDENCE_PATHS,
        "as_of": now,
        "subsystem": "security",
        **FALSE_CLAIM_FLAGS,
        "claim_boundary": (
            "DICE CDI ladder software is real and KAT-validated (HKDF-SHA256 vs "
            "RFC 5869, HMAC-SHA256 vs RFC 4231, Ed25519 deterministic sign vs "
            "RFC 8032 7.1 TEST 1) and builds freestanding for riscv64. The "
            "hardware UDS source (SRAM-PUF / OTP via the OpenTitan-class key "
            "manager) is RTL-side and is a physical silicon-entropy dependency; "
            "see docs/sw/security/dice-rot-binding.md."
        ),
        "summary": {
            "check_count": len(checks),
            "passing_check_count": sum(1 for c in checks if c["status"] == "pass"),
            "failures": failures,
        },
        "checks": checks,
    }
    REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n")

    if passed:
        print(f"PASS: DICE measurement chain gate ({len(checks)} checks); report {REPORT_PATH}")
        return 0
    print(f"BLOCKED: {'; '.join(failures)}", file=sys.stderr)
    for c in checks:
        if c["status"] != "pass":
            print(f"  - {c['id']}: {c['detail']}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
