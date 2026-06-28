# Secure-boot negative evidence (W7) + RoT TeeEvidence fixture (W8)

This directory is the negative-evidence half of the E1 Root-of-Trust secure
boot proof required by
[`docs/security/tee-plan/02-root-of-trust.md`](../../../docs/security/tee-plan/02-root-of-trust.md)
§8 (W7/W8) and the threat-model mitigations M1 (chained signature), M2
(rollback), M8 (debug auth). A passing positive boot alone is insufficient: the
secure-boot claim is gated on reproducible *rejection* transcripts for every
fail-closed condition.

## What this proves

For each required condition the spec-correct verifier REJECTS with the correct
halt code and emits the contracted 32-byte halt record, and a positive control
ACCEPTS a valid image:

| Case | Condition | Halt code | Mitigation |
|---|---|---|---|
| `positive_control` | valid production-signed BL1 | `ACCEPT` | control |
| `unsigned_image` | zeroed signature blob | `SIGNATURE_FAILURE` | M1 |
| `tampered_payload` | one payload byte flipped post-sign | `PAYLOAD_SHA256_MISMATCH` | M1 |
| `wrong_signing_key` | valid sig, key hash != OTP root | `PUBKEY_HASH_NOT_ROOT` | M1 |
| `corrupt_header_bad_magic` | magic != `OPNPHN01` | `MAGIC_MISMATCH` | M1 |
| `corrupt_header_bad_version` | unsupported `header_version` | `HEADER_VERSION_UNSUPPORTED` | M1 |
| `rollback_downgrade` | `rollback_index` < OTP slot | `ROLLBACK_DOWNGRADE` | M2 |
| `revoked_key_id` | `key_id` set in OTP revoked bitmap | `KEY_ID_REVOKED` | M1 |
| `lifecycle_below_min` | prod image on a DEV unit | `LIFECYCLE_BELOW_MIN` | M1 |
| `debug_locked_unlock_denied` | LOCKED unit, valid challenge | `DEBUG_LOCKED_NO_UNLOCK` | M8 |
| `debug_rma_wipe_incomplete` | RMA before key erasure | `DEBUG_RMA_WIPE_INCOMPLETE` | M8/M12 |
| `debug_wrong_auth_key` | RMA challenge wrong key | `DEBUG_AUTH_SIGNATURE_FAILURE` | M8 |

## Shared contract (decoupled from firmware)

The images and verifier here are built against the **spec**
([`docs/security/boot-image-format.md`](../../../docs/security/boot-image-format.md),
[`debug-policy.md`](../../../docs/security/debug-policy.md)), not against the
mask-ROM firmware under `fw/boot-rom/secure/`. The shared contract is the spec:
the RTL/firmware verifier (`fw/boot-rom/secure/verify.c` + `ed25519_ct.c`, W2)
**must produce identical accept/reject decisions and identical halt codes** for
the same image + OTP state. When that firmware lands, drive it with the images
emitted here and assert byte-identical halt records.

Crypto is real, not faked. `ed25519_ref.py` selects, in order, the
`cryptography` (OpenSSL) backend, the `nacl` (libsodium) backend, or the bundled
pure-Python RFC 8032 reference (`ed25519_pure.py`, validated against the RFC
8032 §7.1 test vector). A wrong key or a flipped byte therefore produces a
genuine signature failure. SHA-256 uses `hashlib` (FIPS 180-4), matching
`fw/boot-rom/secure/sha256.c`.

### 32-byte halt record layout

Little-endian, 32 bytes (`opnphn.HaltRecord`):

```
0x00  4  halt_magic    ASCII "HALT"
0x04  2  record_version (=1)
0x06  2  halt_code      (HALT_* in opnphn.py)
0x08  4  image_type     from the rejected header (0 if unreadable)
0x0C  4  boot_counter   OTP anti-replay binding
0x10 16  detail         code-specific (observed/expected indices, key_id)
```

## Reproduce

```bash
cd packages/chip && source tools/env.sh
tests/security/negative/run.sh          # everything below, fail-closed

# or individually:
python3 tests/security/negative/run.py                       # transcripts -> transcripts/
python3 tests/security/negative/gen_evidence.py              # W8 fixture
python3 scripts/check_secure_boot_negative_evidence.py       # W7 gate
python3 scripts/check_tee_attestation_evidence.py \
    docs/spec-db/tee-attestation-evidence.e1-rot.json        # W8 gate
```

`run.py` exits non-zero if any expected-reject case is accepted, the positive
control is rejected, or any observed halt code is wrong. The gate
`scripts/check_secure_boot_negative_evidence.py` writes
`build/reports/secure_boot_negative_evidence.json` in the `eliza.gate_status.v1`
shape and PASSes only when every required transcript is present with the correct
fail-closed code and the positive control passes.

## Files

- `opnphn.py` — OPNPHN01 image builder + fail-closed verifier + OTP/debug model;
  halt-record and halt-code contract.
- `ed25519_ref.py` / `ed25519_pure.py` — Ed25519 backends (real crypto +
  RFC 8032 fallback).
- `run.py` — drives all cases, writes `transcripts/*.json` + `transcripts/index.json`.
- `gen_evidence.py` — emits the W8 `docs/spec-db/tee-attestation-evidence.e1-rot.json`.
- `run.sh` — one-shot regenerate + run both gates.
