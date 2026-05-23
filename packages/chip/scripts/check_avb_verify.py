#!/usr/bin/env python3
"""Gate for the E1 AVB vbmeta verifier (fw/avb/).

Writes an eliza.gate_status.v1 report to build/reports/avb_verify.json. PASS
requires, in order:

  1. Every referenced source/doc exists on disk. No source => BLOCKED, not PASS.
  2. ``make -C fw/avb run`` generates the vbmeta vectors (make_vbmeta.py,
     python `cryptography` Ed25519), builds the verifier against the shared
     fw/boot-rom/secure crypto, and runs the host KAT + negative suite. The
     positive vbmeta MUST verify and every negative MUST be rejected with the
     exact avb_result code; the run ends with "AVB vbmeta verify test PASS".
  3. ``make -C fw/avb target`` cross-compiles the verifier freestanding for
     riscv64-unknown-elf, proving it builds for the RoT target.

This is the E1 Ed25519 AVB profile (SHA-256(header||aux) signed with Ed25519,
reusing the boot-ROM key-ladder primitives), not libavb-RSA. The gate is backed
by executable evidence, not self-assertion.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

CHIP_ROOT = Path(__file__).resolve().parents[1]
AVB_DIR = CHIP_ROOT / "fw/avb"
HOST_BIN = CHIP_ROOT / "build/avb/test_avb_verify"
REPORT_PATH = CHIP_ROOT / "build/reports/avb_verify.json"
GATE = "avb-verify"
BLOCKER_ID = "avb_verify_check_failed"

EVIDENCE_PATHS = [
    "docs/security/avb-a-b-ota.md",
    "docs/security/boot-image-format.md",
    "fw/avb/avb_verify.c",
    "fw/avb/avb_verify.h",
    "fw/avb/Makefile",
    "fw/avb/tests/make_vbmeta.py",
    "fw/avb/tests/test_kat.c",
    "fw/avb/tests/run_tests.sh",
]

PASS_LINE = "AVB vbmeta verify test PASS"


def _toolchain_env() -> dict[str, str]:
    """Prepend the native toolchain bins so riscv64-unknown-elf-gcc, host gcc,
    and the cryptography venv resolve even when tools/env.sh was not sourced."""
    env = os.environ.copy()
    extra = [
        CHIP_ROOT / ".venv/bin",
        CHIP_ROOT / "external/oss-cad-suite/bin",
        CHIP_ROOT / "external/deb-tools/bin",
        CHIP_ROOT / "external/xpack-riscv/bin",
        CHIP_ROOT / "tools/bin",
    ]
    prefix = os.pathsep.join(str(p) for p in extra if p.is_dir())
    if prefix:
        env["PATH"] = f"{prefix}{os.pathsep}{env.get('PATH', '')}"
    return env


def _make(target: str) -> tuple[bool, str, str]:
    proc = subprocess.run(
        ["make", "-C", str(AVB_DIR), target],
        cwd=CHIP_ROOT,
        capture_output=True,
        text=True,
        env=_toolchain_env(),
    )
    ok = proc.returncode == 0
    detail = "ok" if ok else (proc.stderr.strip() or proc.stdout.strip())[-900:]
    return ok, detail, proc.stdout


def run_host_test() -> tuple[bool, str]:
    ok, detail, _ = _make("host")
    if not ok:
        return False, f"host build failed: {detail}"
    proc = subprocess.run(
        [str(HOST_BIN), str(CHIP_ROOT / "build/avb")],
        cwd=CHIP_ROOT,
        capture_output=True,
        text=True,
        env=_toolchain_env(),
    )
    lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
    last = lines[-1] if lines else ""
    if proc.returncode != 0:
        return False, f"test exited {proc.returncode}: {last}"
    if last != PASS_LINE:
        return False, f"unexpected terminal line: {last!r}"
    passes = sum(1 for ln in lines if ln.startswith("PASS "))
    fails = sum(1 for ln in lines if ln.startswith("FAIL "))
    if fails:
        return False, f"{fails} check(s) failed"
    return True, f"{passes} checks passed; '{PASS_LINE}'"


def run_target_build() -> tuple[bool, str]:
    ok, detail, _ = _make("target")
    if not ok:
        return False, f"riscv64 freestanding build failed: {detail}"
    objs = sorted((CHIP_ROOT / "build/avb").glob("*.rv64.o"))
    if not objs:
        return False, "no riscv64 objects produced"
    return True, f"{len(objs)} freestanding riscv64 object(s) built"


def main() -> int:
    now = datetime.now(UTC).isoformat()
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)

    missing = [p for p in EVIDENCE_PATHS if not (CHIP_ROOT / p).exists()]
    if missing:
        report: dict[str, object] = {
            "schema": "eliza.gate_status.v1",
            "gate": GATE,
            "status": "BLOCKED",
            "blocker_id": BLOCKER_ID,
            "blocker_reason": "missing source/doc: " + ", ".join(missing),
            "evidence_paths": [],
            "as_of": now,
            "subsystem": "security",
        }
        REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n")
        print(f"BLOCKED: missing {missing}", file=sys.stderr)
        return 1

    checks = []
    host_ok, host_detail = run_host_test()
    checks.append(
        {
            "id": "host_vbmeta_kat_and_negative_suite",
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
        "algorithm_profile": "E1_SHA256_ED25519",
        "claim_boundary": (
            "AVB vbmeta verification is real and KAT-validated for the E1 "
            "Ed25519 profile: the libavb vbmeta image header and "
            "hash/hashtree/chain/property descriptor formats are parsed with "
            "bounds checks, the auth block is verified as SHA-256(header||aux) "
            "signed by Ed25519 (RFC 8032) reusing the boot-ROM constant-time "
            "primitives, the AVB key A pubkey is pinned by SHA-256 (the AVB "
            "analogue of the OPNPHN01 key ladder), rollback_index is checked "
            "against an OTP floor input, and a positive image plus tampered, "
            "wrong-key, bad-magic, rollback-downgrade, truncated-aux, and "
            "corrupted-hash-descriptor negatives are decided correctly. This "
            "is NOT libavb-RSA compatible and makes no such claim. Scope is "
            "vbmeta VERIFICATION only: on-device AVB enforcement in a booted "
            "Android image is gated on the AOSP boot lane, and full A/B OTA "
            "apply/recovery is not implemented here. The OTP rollback fuses and "
            "the silicon RoT crypto that supply the verifier's trust inputs are "
            "hardware-gated; no production verified-boot claim follows from "
            "host/sim evidence alone."
        ),
        "summary": {
            "check_count": len(checks),
            "passing_check_count": sum(1 for c in checks if c["status"] == "pass"),
            "failures": failures,
            "release_claim_allowed": False,
        },
        "checks": checks,
    }
    REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n")

    if passed:
        print(f"PASS: AVB vbmeta verify gate ({len(checks)} checks); report {REPORT_PATH}")
        return 0
    print(f"BLOCKED: {'; '.join(failures)}", file=sys.stderr)
    for c in checks:
        if c["status"] != "pass":
            print(f"  - {c['id']}: {c['detail']}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
