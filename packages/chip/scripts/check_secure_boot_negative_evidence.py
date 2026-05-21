#!/usr/bin/env python3
"""Gate: secure-boot negative-evidence transcripts (W7).

Fail-closed audit of the rejection transcripts produced by
tests/security/negative/run.py. PASS only if:

  - every required rejection case has a transcript with result==PASS and the
    correct fail-closed halt code,
  - the positive control transcript exists and is ACCEPTED,
  - every halt record is the contracted 32 bytes ("HALT" magic).

Writes build/reports/secure_boot_negative_evidence.json in the
eliza.gate_status.v1 shape. Exits non-zero on any failure.

This realizes the tee-plan/02-root-of-trust.md §8 W7 gate
(boot-security-chain-contract-check negative-evidence requirement) and the
threat-model M1/M2/M8 negative evidence.

Usage:
    python3 scripts/check_secure_boot_negative_evidence.py
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from pathlib import Path

CHIP_ROOT = Path(__file__).resolve().parents[1]
TRANSCRIPT_DIR = CHIP_ROOT / "tests/security/negative/transcripts"
REPORT_PATH = CHIP_ROOT / "build/reports/secure_boot_negative_evidence.json"

GATE = "secure-boot-negative-evidence"
BLOCKER_ID = "secure_boot_negative_evidence_missing"

# Required transcripts: case name -> expected halt-record name.
# Mirrors the W7 deliverable list (a)-(h) plus the positive control. Renaming
# a case here without regenerating transcripts must fail the gate, not pass it.
REQUIRED_REJECTIONS: dict[str, str] = {
    "unsigned_image": "SIGNATURE_FAILURE",
    "tampered_payload": "PAYLOAD_SHA256_MISMATCH",
    "wrong_signing_key": "PUBKEY_HASH_NOT_ROOT",
    "corrupt_header_bad_magic": "MAGIC_MISMATCH",
    "corrupt_header_bad_version": "HEADER_VERSION_UNSUPPORTED",
    "rollback_downgrade": "ROLLBACK_DOWNGRADE",
    "revoked_key_id": "KEY_ID_REVOKED",
    "lifecycle_below_min": "LIFECYCLE_BELOW_MIN",
    "debug_locked_unlock_denied": "DEBUG_LOCKED_NO_UNLOCK",
    "debug_rma_wipe_incomplete": "DEBUG_RMA_WIPE_INCOMPLETE",
    "debug_wrong_auth_key": "DEBUG_AUTH_SIGNATURE_FAILURE",
}
POSITIVE_CONTROL = "positive_control"
HALT_RECORD_LEN = 32
HALT_MAGIC = "HALT"


def _load(case: str) -> dict | None:
    path = TRANSCRIPT_DIR / f"{case}.json"
    if not path.is_file():
        return None
    return json.loads(path.read_text())


def audit() -> tuple[list[dict], list[str]]:
    checks: list[dict] = []
    failures: list[str] = []

    def fail(case: str, msg: str) -> None:
        failures.append(f"{case}: {msg}")

    # Positive control must exist and be accepted.
    pos = _load(POSITIVE_CONTROL)
    if pos is None:
        fail(POSITIVE_CONTROL, "transcript missing")
        checks.append({"id": POSITIVE_CONTROL, "status": "fail", "detail": "missing"})
    else:
        ok = (
            pos.get("observed_accept") is True
            and pos.get("result") == "PASS"
            and pos.get("observed_halt_name") == "ACCEPT"
        )
        if not ok:
            fail(POSITIVE_CONTROL, "positive control not accepted")
        checks.append(
            {
                "id": POSITIVE_CONTROL,
                "status": "pass" if ok else "fail",
                "observed": pos.get("observed_halt_name"),
            }
        )

    for case, expected_halt in REQUIRED_REJECTIONS.items():
        t = _load(case)
        if t is None:
            fail(case, "transcript missing")
            checks.append({"id": case, "status": "fail", "detail": "missing"})
            continue
        problems = []
        if t.get("observed_accept") is not False:
            problems.append("image was ACCEPTED (must reject)")
        if t.get("observed_halt_name") != expected_halt:
            problems.append(
                f"halt {t.get('observed_halt_name')!r} != expected {expected_halt!r}"
            )
        if t.get("result") != "PASS":
            problems.append(f"result={t.get('result')}")
        rec = t.get("halt_record_hex", "")
        if not (isinstance(rec, str) and len(rec) == HALT_RECORD_LEN * 2):
            problems.append("halt record not 32 bytes")
        elif bytes.fromhex(rec)[:4] != HALT_MAGIC.encode():
            problems.append("halt record missing HALT magic")
        if problems:
            for p in problems:
                fail(case, p)
        checks.append(
            {
                "id": case,
                "status": "pass" if not problems else "fail",
                "expected_halt": expected_halt,
                "observed_halt": t.get("observed_halt_name"),
            }
        )

    return checks, failures


def main() -> int:
    now = datetime.now(UTC).isoformat()
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)

    if not TRANSCRIPT_DIR.is_dir():
        report: dict[str, object] = {
            "schema": "eliza.gate_status.v1",
            "gate": GATE,
            "status": "BLOCKED",
            "blocker_id": BLOCKER_ID,
            "blocker_reason": (
                "no transcripts; run python3 tests/security/negative/run.py first"
            ),
            "evidence_paths": [],
            "as_of": now,
            "subsystem": "security",
        }
        REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n")
        print(f"BLOCKED: {report['blocker_reason']}", file=sys.stderr)
        return 1

    checks, failures = audit()
    passed = not failures
    evidence = sorted(
        str(p.relative_to(CHIP_ROOT)) for p in TRANSCRIPT_DIR.glob("*.json")
    )
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": GATE,
        "status": "PASS" if passed else "BLOCKED",
        "blocker_id": None if passed else BLOCKER_ID,
        "blocker_reason": None if passed else "; ".join(failures),
        "evidence_paths": evidence,
        "as_of": now,
        "subsystem": "security",
        "claim_boundary": (
            "secure-boot reference rejection transcripts only; not silicon "
            "secure-boot evidence. The shared accept/reject contract is "
            "docs/security/boot-image-format.md (the RTL/firmware verifier must "
            "produce identical halt codes)."
        ),
        "summary": {
            "required_rejection_count": len(REQUIRED_REJECTIONS),
            "positive_control": POSITIVE_CONTROL,
            "check_count": len(checks),
            "passing_check_count": sum(1 for c in checks if c["status"] == "pass"),
            "failures": failures,
        },
        "checks": checks,
    }
    REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n")

    if passed:
        print(f"PASS: {len(checks)} negative-evidence checks; report {REPORT_PATH}")
        return 0
    print(f"BLOCKED: {len(failures)} failure(s):", file=sys.stderr)
    for f in failures:
        print(f"  - {f}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
