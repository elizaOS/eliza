#!/usr/bin/env python3
"""W7 secure-boot negative-evidence harness.

Regenerates OPNPHN01 images, drives the spec-correct verifier
(opnphn.verify_image / opnphn.evaluate_debug_unlock) over every required
rejection case plus a positive control, and writes machine-checkable
transcripts to tests/security/negative/transcripts/.

Exit non-zero if ANY expected-reject case is accepted, if the positive control
is rejected, or if any case halts with the wrong code. This is the negative
evidence required by tee-plan/02-root-of-trust.md §8 (W7) and threat-model
M1/M2/M8.

Reproduce:
    cd packages/chip && source tools/env.sh
    python3 tests/security/negative/run.py
"""

from __future__ import annotations

import json
import sys
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import opnphn as M  # noqa: E402  (sibling module; run from its own dir)
from ed25519_ref import Ed25519PrivateKey, backend_name

HERE = Path(__file__).resolve().parent
TRANSCRIPT_DIR = HERE / "transcripts"

# Deterministic, clearly-non-production test keys (32-byte seeds).
ROOT_SEED = b"E1-ROT-W7-ROOT-TEST-KEY-SEED-001"
WRONG_SEED = b"E1-ROT-W7-WRONG-SIGNER-KEY-SEED1"
DEBUG_SEED = b"E1-ROT-W7-DEBUG-AUTH-KEY-SEED-01"
WRONG_DEBUG_SEED = b"E1-ROT-W7-WRONG-DEBUG-KEY-SEED-1"

DEVICE_UID = bytes.fromhex("0011223344556677889900aa")  # 12 B
DEBUG_NONCE = bytes.fromhex("a1a2a3a4b1b2b3b4c1c2c3c4d1d2d3d4")  # 16 B
DEBUG_CAPS = 0x0000_0007


@dataclass
class Case:
    name: str
    description: str
    mitigation: str
    expect_accept: bool
    expect_halt: int
    run: Callable[[], M.HaltRecord]


def _root_builder() -> M.ImageBuilder:
    return M.ImageBuilder(Ed25519PrivateKey(ROOT_SEED))


def _root_otp(**overrides) -> M.Otp:
    root_hash = M.sha256(_root_builder().pubkey)
    base = dict(
        root_key_hash=root_hash,
        lifecycle_state=M.LC_LOCKED,
        rollback={0: 4},
        revoked_key_bitmap=0,
        boot_counter=7,
        debug_auth_pubkey_hash=M.sha256(Ed25519PrivateKey(DEBUG_SEED).public_bytes()),
        debug_disable=0,
    )
    base.update(overrides)
    return M.Otp(**base)


def _good_header(**overrides) -> M.Header:
    base = dict(
        image_type=0,
        rollback_index=5,
        rollback_slot=0,
        key_id=1,
        flags=0,
        min_lifecycle_state=M.LC_LOCKED,
    )
    base.update(overrides)
    return M.Header(**base)


PAYLOAD = b"E1 BL1 production payload \x90\x90\x90" + bytes(range(256)) * 4


# --- Positive control --------------------------------------------------------


def case_positive() -> M.HaltRecord:
    img = _root_builder().build(PAYLOAD, header=_good_header())
    return M.verify_image(img, _root_otp())


# --- (a) unsigned image ------------------------------------------------------


def case_unsigned() -> M.HaltRecord:
    img = _root_builder().build(PAYLOAD, header=_good_header(), sign=False)
    return M.verify_image(img, _root_otp())


# --- (b) tampered payload (flip a byte after signing) ------------------------


def case_tampered_payload() -> M.HaltRecord:
    img = bytearray(_root_builder().build(PAYLOAD, header=_good_header()))
    # Flip a byte inside the payload region; header.payload_sha256 still
    # matches the ORIGINAL payload, so the SHA-256 check fires first.
    img[M.HEADER_LEN + 10] ^= 0xFF
    return M.verify_image(bytes(img), _root_otp())


# --- (c) wrong signing key ---------------------------------------------------


def case_wrong_key() -> M.HaltRecord:
    # Signed by an unauthorized key; its pubkey is embedded so the signature
    # itself verifies, but SHA-256(pubkey) != OTP.root_key_hash.
    wrong = M.ImageBuilder(Ed25519PrivateKey(WRONG_SEED))
    img = wrong.build(PAYLOAD, header=_good_header())
    return M.verify_image(img, _root_otp())


# --- (d) corrupt header: bad magic and bad version ---------------------------


def case_corrupt_magic() -> M.HaltRecord:
    img = bytearray(_root_builder().build(PAYLOAD, header=_good_header()))
    img[0] = ord("X")  # break "OPNPHN01"
    return M.verify_image(bytes(img), _root_otp())


def case_corrupt_version() -> M.HaltRecord:
    hdr = _good_header()
    hdr.header_version = 99
    img = _root_builder().build(PAYLOAD, header=hdr)
    return M.verify_image(img, _root_otp())


# --- (e) rollback downgrade (rollback_index < OTP slot) ----------------------


def case_rollback_downgrade() -> M.HaltRecord:
    # OTP slot 0 programmed to 4; image presents index 2.
    hdr = _good_header(rollback_index=2, rollback_slot=0)
    img = _root_builder().build(PAYLOAD, header=hdr)
    return M.verify_image(img, _root_otp(rollback={0: 4}))


# --- (f) revoked key_id ------------------------------------------------------


def case_revoked_key_id() -> M.HaltRecord:
    # Image signed by the genuine root key but its key_id is revoked in OTP.
    hdr = _good_header(key_id=3)
    img = _root_builder().build(PAYLOAD, header=hdr)
    return M.verify_image(img, _root_otp(revoked_key_bitmap=(1 << 3)))


# --- (g) lifecycle below min_lifecycle_state ---------------------------------


def case_lifecycle_below_min() -> M.HaltRecord:
    # Production image (min=LOCKED) on a DEV unit.
    hdr = _good_header(min_lifecycle_state=M.LC_LOCKED)
    img = _root_builder().build(PAYLOAD, header=hdr)
    return M.verify_image(img, _root_otp(lifecycle_state=M.LC_DEV))


# --- (h) debug-locked device: unlock denial + key erasure --------------------


def case_debug_locked_denied() -> M.HaltRecord:
    # LOCKED device, debugger presents a correctly-signed challenge with the
    # authorized debug key — must STILL be denied (no direct unlock on LOCKED).
    otp = _root_otp(lifecycle_state=M.LC_LOCKED)
    debug_key = Ed25519PrivateKey(DEBUG_SEED)
    msg = M.build_debug_auth_msg(DEVICE_UID, DEBUG_NONCE, DEBUG_CAPS)
    sig = debug_key.sign(msg)
    return M.evaluate_debug_unlock(
        otp,
        device_uid=DEVICE_UID,
        nonce=DEBUG_NONCE,
        caps=DEBUG_CAPS,
        auth_signature=sig,
        auth_pubkey=debug_key.public_bytes(),
    )


def case_debug_rma_wipe_incomplete() -> M.HaltRecord:
    # RMA entry but key-erasure (rma_wipe_done) not yet complete: debug must be
    # denied until secrets are scrubbed (debug-policy.md §5 key erasure).
    otp = _root_otp(lifecycle_state=M.LC_RMA, rma_wipe_done=False)
    debug_key = Ed25519PrivateKey(DEBUG_SEED)
    msg = M.build_debug_auth_msg(DEVICE_UID, DEBUG_NONCE, DEBUG_CAPS)
    sig = debug_key.sign(msg)
    return M.evaluate_debug_unlock(
        otp,
        device_uid=DEVICE_UID,
        nonce=DEBUG_NONCE,
        caps=DEBUG_CAPS,
        auth_signature=sig,
        auth_pubkey=debug_key.public_bytes(),
    )


def case_debug_wrong_auth_key() -> M.HaltRecord:
    # RMA with wipe done, but the unlock challenge is signed by the WRONG key:
    # signature must fail (M8 chained debug-auth).
    otp = _root_otp(lifecycle_state=M.LC_RMA, rma_wipe_done=True)
    wrong = Ed25519PrivateKey(WRONG_DEBUG_SEED)
    msg = M.build_debug_auth_msg(DEVICE_UID, DEBUG_NONCE, DEBUG_CAPS)
    sig = wrong.sign(msg)
    return M.evaluate_debug_unlock(
        otp,
        device_uid=DEVICE_UID,
        nonce=DEBUG_NONCE,
        caps=DEBUG_CAPS,
        auth_signature=sig,
        auth_pubkey=wrong.public_bytes(),
    )


CASES: list[Case] = [
    Case(
        "positive_control",
        "Valid production-signed BL1 on a LOCKED unit at rollback index 5.",
        "M1/M2 positive control",
        expect_accept=True,
        expect_halt=M.HALT_NONE,
        run=case_positive,
    ),
    Case(
        "unsigned_image",
        "Image with a zeroed signature blob (no valid Ed25519 signature).",
        "M1",
        expect_accept=False,
        expect_halt=M.HALT_SIGNATURE_FAILURE,
        run=case_unsigned,
    ),
    Case(
        "tampered_payload",
        "One payload byte flipped after signing; header hash unchanged.",
        "M1",
        expect_accept=False,
        expect_halt=M.HALT_PAYLOAD_SHA256_MISMATCH,
        run=case_tampered_payload,
    ),
    Case(
        "wrong_signing_key",
        "Validly signed by an unauthorized key whose hash != OTP root.",
        "M1",
        expect_accept=False,
        expect_halt=M.HALT_PUBKEY_HASH_NOT_ROOT,
        run=case_wrong_key,
    ),
    Case(
        "corrupt_header_bad_magic",
        "Header magic corrupted (not OPNPHN01).",
        "M1",
        expect_accept=False,
        expect_halt=M.HALT_MAGIC_MISMATCH,
        run=case_corrupt_magic,
    ),
    Case(
        "corrupt_header_bad_version",
        "Header version unsupported (99).",
        "M1",
        expect_accept=False,
        expect_halt=M.HALT_HEADER_VERSION_UNSUPPORTED,
        run=case_corrupt_version,
    ),
    Case(
        "rollback_downgrade",
        "rollback_index (2) < OTP rollback slot value (4).",
        "M2",
        expect_accept=False,
        expect_halt=M.HALT_ROLLBACK_DOWNGRADE,
        run=case_rollback_downgrade,
    ),
    Case(
        "revoked_key_id",
        "Genuine root signature but key_id (3) is set in revoked bitmap.",
        "M1",
        expect_accept=False,
        expect_halt=M.HALT_KEY_ID_REVOKED,
        run=case_revoked_key_id,
    ),
    Case(
        "lifecycle_below_min",
        "Production image (min=LOCKED) on a DEV-lifecycle unit.",
        "M1/lifecycle",
        expect_accept=False,
        expect_halt=M.HALT_LIFECYCLE_BELOW_MIN,
        run=case_lifecycle_below_min,
    ),
    Case(
        "debug_locked_unlock_denied",
        "LOCKED unit denies debug unlock even with a valid signed challenge.",
        "M8",
        expect_accept=False,
        expect_halt=M.HALT_DEBUG_LOCKED_NO_UNLOCK,
        run=case_debug_locked_denied,
    ),
    Case(
        "debug_rma_wipe_incomplete",
        "RMA entry denies debug until key erasure (rma_wipe_done) completes.",
        "M8/M12",
        expect_accept=False,
        expect_halt=M.HALT_DEBUG_RMA_WIPE_INCOMPLETE,
        run=case_debug_rma_wipe_incomplete,
    ),
    Case(
        "debug_wrong_auth_key",
        "RMA debug-auth challenge signed by an unauthorized key is rejected.",
        "M8",
        expect_accept=False,
        expect_halt=M.HALT_DEBUG_AUTH_SIGNATURE_FAILURE,
        run=case_debug_wrong_auth_key,
    ),
]


def main() -> int:
    TRANSCRIPT_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.now(UTC).isoformat()
    print(f"ed25519 backend: {backend_name()}")
    results = []
    failures = []

    for case in CASES:
        record = case.run()
        accepted = record.accepted
        halt_ok = record.code == case.expect_halt
        decision_ok = accepted == case.expect_accept
        passed = halt_ok and decision_ok
        if not passed:
            failures.append(case.name)

        transcript = {
            "schema": "eliza.secure_boot_negative_transcript.v1",
            "case": case.name,
            "description": case.description,
            "mitigation": case.mitigation,
            "expect_accept": case.expect_accept,
            "expect_halt_code": case.expect_halt,
            "expect_halt_name": M.HALT_CODE_NAMES[case.expect_halt],
            "observed_accept": accepted,
            "observed_halt_code": record.code,
            "observed_halt_name": record.code_name,
            "halt_record_hex": record.to_hex(),
            "halt_record_len": M.HALT_RECORD_LEN,
            "result": "PASS" if passed else "FAIL",
            "as_of": now,
        }
        path = TRANSCRIPT_DIR / f"{case.name}.json"
        path.write_text(json.dumps(transcript, indent=2) + "\n")
        results.append(transcript)

        flag = "OK " if passed else "BAD"
        verb = "ACCEPT" if accepted else f"REJECT/{record.code_name}"
        print(f"[{flag}] {case.name:34s} -> {verb}")

    summary = {
        "schema": "eliza.secure_boot_negative_transcript_index.v1",
        "as_of": now,
        "case_count": len(CASES),
        "passing_count": len(CASES) - len(failures),
        "failures": failures,
        "transcripts": [r["case"] for r in results],
        "halt_record_contract": {
            "magic": "HALT",
            "record_version": M.HALT_RECORD_VERSION,
            "length_bytes": M.HALT_RECORD_LEN,
            "halt_codes": {v: k for k, v in M.HALT_CODE_NAMES.items()},
        },
    }
    (TRANSCRIPT_DIR / "index.json").write_text(json.dumps(summary, indent=2) + "\n")

    if failures:
        print(f"\nFAIL: {len(failures)} case(s) wrong: {', '.join(failures)}", file=sys.stderr)
        return 1
    print(f"\nPASS: {len(CASES)} cases, all decisions and halt codes correct.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
