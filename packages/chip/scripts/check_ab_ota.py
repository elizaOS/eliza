#!/usr/bin/env python3
"""Gate for the E1 A/B slot + OTA apply + recovery logic (fw/avb/).

Writes an eliza.gate_status.v1 report to build/reports/ab_ota.json. PASS
requires, in order:

  1. Every referenced source/doc exists on disk. No source => BLOCKED, not PASS.
  2. ``make -C fw/avb run-abota`` builds the A/B + OTA host harness against the
     real avb_verify gate and the shared boot-ROM crypto, generates the A/B/OTA
     vbmeta vectors (make_ab_images.py, python `cryptography` Ed25519), and runs
     every slot/OTA/rollback/recovery case. The terminal line must be
     "AB/OTA test PASS" with zero FAILs.
  3. ``make -C fw/avb target-abota`` cross-compiles ab_slot.c and ota_apply.c
     freestanding for riscv64-unknown-elf, proving they build for the RoT target.

This proves the slot state machine, OTA apply-to-inactive, automatic rollback on
try-exhaustion, anti-rollback (downgrade rejected pre-write), tamper/wrong-key
rejection, and the both-slots-bad -> recovery -> fail-closed-halt path. The
partition store is a software model; the real flash/UFS write path and on-device
fastboot/update-engine integration remain documented follow-ons. The gate is
backed by executable evidence, not self-assertion.
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
ABOTA_BIN = CHIP_ROOT / "build/avb/test_ab_ota"
REPORT_PATH = CHIP_ROOT / "build/reports/ab_ota.json"
GATE = "ab-ota"
BLOCKER_ID = "ab_ota_check_failed"

EVIDENCE_PATHS = [
    "docs/security/avb-a-b-ota.md",
    "docs/security/boot-image-format.md",
    "fw/avb/avb_verify.c",
    "fw/avb/avb_verify.h",
    "fw/avb/ab_slot.c",
    "fw/avb/ab_slot.h",
    "fw/avb/ota_apply.c",
    "fw/avb/ota_apply.h",
    "fw/avb/Makefile",
    "fw/avb/tests/make_ab_images.py",
    "fw/avb/tests/test_ab_ota.c",
    "fw/avb/tests/run_tests.sh",
]

PASS_LINE = "AB/OTA test PASS"

# Every slot/OTA/rollback/recovery case the harness must decide. Each must
# appear as a "PASS <substring>" line; any matching FAIL fails the gate.
REQUIRED_CASES = [
    "(a) select picks slot A",
    "(b) OTA to B applies",
    "(b) select picks new slot B",
    "(b) success pins B",
    "(b) OTP rollback floor advanced to OTA index",
    "(c) AUTO-ROLLBACK: select reverts to known-good slot A",
    "(d) DOWNGRADE rejected pre-write",
    "(d) downgrade reason is AVB_ERR_ROLLBACK",
    "(e) TAMPERED vbmeta rejected pre-write",
    "(e) WRONG-KEY vbmeta rejected pre-write",
    "(f) both slots bad -> RECOVERY selected",
    "(f) no bootable slot at all -> NO_BOOTABLE_SLOT (halt)",
    "(f) corrupt recovery -> NO_BOOTABLE_SLOT (fail-closed)",
]


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
    ok, detail, _ = _make("host-abota")
    if not ok:
        return False, f"host build failed: {detail}"
    proc = subprocess.run(
        [str(ABOTA_BIN), str(CHIP_ROOT / "build/avb")],
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
    fails = sum(1 for ln in lines if ln.startswith("FAIL "))
    if fails:
        return False, f"{fails} check(s) failed"
    passed = {ln[len("PASS "):] for ln in lines if ln.startswith("PASS ")}
    missing = [c for c in REQUIRED_CASES if c not in passed]
    if missing:
        return False, "missing required cases: " + "; ".join(missing)
    return True, f"{len(passed)} checks passed; all {len(REQUIRED_CASES)} required cases present; '{PASS_LINE}'"


def run_target_build() -> tuple[bool, str]:
    ok, detail, _ = _make("target-abota")
    if not ok:
        return False, f"riscv64 freestanding build failed: {detail}"
    objs = [
        CHIP_ROOT / "build/avb/ab_slot.rv64.o",
        CHIP_ROOT / "build/avb/ota_apply.rv64.o",
    ]
    missing = [o.name for o in objs if not o.exists()]
    if missing:
        return False, f"missing riscv64 objects: {missing}"
    return True, f"{len(objs)} freestanding riscv64 object(s) built (ab_slot, ota_apply)"


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
    checks.append({
        "id": "host_ab_ota_slot_rollback_recovery_suite",
        "status": "pass" if host_ok else "fail",
        "detail": host_detail,
    })

    target_ok, target_detail = run_target_build()
    checks.append({
        "id": "riscv64_freestanding_build",
        "status": "pass" if target_ok else "fail",
        "detail": target_detail,
    })

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
            "The A/B slot state machine, OTA apply-to-inactive-slot, automatic "
            "rollback, and recovery selection are real and host-tested, layered "
            "on the KAT-validated E1 Ed25519 vbmeta verifier (no fakes — slot "
            "acceptance and OTA staging gate on avb_verify returning AVB_OK). "
            "Proven: highest-priority bootable verifying slot is selected; an "
            "OTA to the inactive slot is verified BEFORE any write and armed "
            "with a finite try budget so a bad image auto-reverts; a "
            "rollback-index downgrade is rejected pre-write (AVB_ERR_ROLLBACK); "
            "a tampered or wrong-key OTA vbmeta is rejected; a slot that "
            "exhausts its tries without mark_successful is marked unbootable and "
            "selection reverts to the known-good slot; mark_successful pins the "
            "slot and advances the OTP rollback floor monotonically; both slots "
            "unbootable selects the verified recovery image, and an "
            "unavailable/corrupt recovery fails closed with no bootable slot. "
            "SCOPE: the partition store is a software model. The physical "
            "flash/UFS block write, the atomic bootloader-message commit, and "
            "the on-device fastboot/update-engine + download/staging integration "
            "are driver/platform follow-ons. The OTP rollback fuses and the "
            "silicon RoT crypto that supply the trust inputs are hardware-gated; "
            "no production verified-boot/OTA claim follows from host evidence "
            "alone."
        ),
        "summary": {
            "check_count": len(checks),
            "passing_check_count": sum(1 for c in checks if c["status"] == "pass"),
            "required_case_count": len(REQUIRED_CASES),
            "failures": failures,
            "release_claim_allowed": False,
        },
        "checks": checks,
    }
    REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n")

    if passed:
        print(f"PASS: A/B + OTA gate ({len(checks)} checks); report {REPORT_PATH}")
        return 0
    print(f"BLOCKED: {'; '.join(failures)}", file=sys.stderr)
    for c in checks:
        if c["status"] != "pass":
            print(f"  - {c['id']}: {c['detail']}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
