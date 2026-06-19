# Boot Image Format and Key Ladder

Status: implemented in firmware with host/sim evidence; silicon integration
hardware-gated. The OPNPHN01 container, the Ed25519 + SHA-256 signature path,
and the key ladder below are implemented in the mask-ROM verifier
(`fw/boot-rom/secure/verify.c`) and the PMC verifier
(`fw/pmc/src/secure_boot.c`), exercised by host known-answer tests
(`fw/boot-rom/secure/tests/`) and reproducible negative-evidence transcripts
(`tests/security/negative/`). Silicon RoT integration — the OTP macro, key
manager, and on-die entropy that supply the verifier's trust inputs — remains
hardware-gated; no production secure-boot claim follows from host/sim evidence
alone.

## 1. Algorithms

| Purpose | Algorithm | Justification |
|---|---|---|
| Image signature | Ed25519 (RFC 8032) | Small public keys (32 B) and signatures (64 B) fit OTP and SPI overhead budgets; deterministic — no RNG required in ROM; no patent encumbrance; constant-time reference implementations are short and audit-friendly; widely deployed (OpenSSH, libsodium, Tor, AVB optional). |
| Image hash | SHA-256 | Required by AVB; broad HW/SW support; sufficient for v0 collision resistance. |
| Key-hash storage | SHA-256 truncated to 256 bits in OTP | Matches AVB vbmeta rollback-protected key descriptor format. |
| Optional intermediate KDF | HKDF-SHA-256 | For deriving per-stage authentication keys from a single offline root. |

RSA-PSS-3072 is NOT used in v0: larger keys (384 B public, 384 B signature)
inflate OTP and SPI overhead, and ROM verification code is larger and harder
to audit. ECDSA P-256 is NOT used because it requires per-signature RNG,
which complicates ROM correctness.

## 2. Signed image container

```
+-------------------------------+
| header (256 B, see 2.1)       |
+-------------------------------+
| payload (image_size B)        |
+-------------------------------+
| signature_blob (96 B)         |
+-------------------------------+
```

### 2.1 Header (256 B, little-endian)

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0x00 | 8 | magic | ASCII OPNPHN01 |
| 0x08 | 4 | header_version | =1 |
| 0x0C | 4 | image_type | 0=bootloader, 1=recovery, 2=vbmeta, 3=vendor_boot |
| 0x10 | 8 | image_size | bytes in payload |
| 0x18 | 4 | rollback_index | monotonic per image_type |
| 0x1C | 4 | rollback_slot | index into OTP rollback bank |
| 0x20 | 4 | key_id | which authorized key signed this image |
| 0x24 | 4 | flags | bit0=allow_dev, bit1=allow_mfg |
| 0x28 | 32 | payload_sha256 | hash of payload bytes |
| 0x48 | 32 | next_stage_pubkey_hash | SHA-256 of next-stage public key (key-ladder pin) |
| 0x68 | 4 | min_lifecycle_state | image refuses to run below this state |
| 0x6C | 148 | reserved | zero-filled, included in signature |

### 2.2 Signature blob (96 B)

| Offset | Size | Field |
|---|---|---|
| 0x00 | 32 | pubkey (Ed25519) |
| 0x20 | 64 | signature over (header || payload) |

ROM enforces: SHA-256(pubkey) == OTP.root_key_hash for the first stage, then
each stage enforces SHA-256(next_stage_pubkey) == header.next_stage_pubkey_hash
loaded from the previous stage. This implements the key ladder.

## 3. Key ladder

```
OTP.root_key_hash   -->   Root Ed25519 key (R)   [offline air-gapped HSM]
                                |
                                | signs
                                v
                          AVB / Stage-1 key (A)  -- signs -->  bootloader (BL1, BL2)
                                |
                                v
                          Vendor key set (V0..Vn) -- signs --> vendor partitions
                                |
                                v
                          OTA payload key (O)    -- signs -->  OTA streams
```

- Root key (R): offline HSM only. Signs A and revocation list. Used once per
  product lifetime per re-key event. See `key-ceremony.md`.
- AVB key (A): online HSM. Signs vbmeta and bootloader stages.
- Vendor keys (V): online HSM, scoped per vendor partition.
- OTA key (O): online HSM, rotates per release train.

Revocation: each non-root key carries a key_id. OTP holds an 8-bit
revoked_key_bitmap — programming a bit revokes that key_id. ROM refuses any
image whose key_id is revoked, even if signature verifies.

## 4. Rollback indices

- Each image_type owns one rollback slot in OTP.
- Slot value is the count of programmed monotonic fuses (unary encoding).
- Image accepted only if header.rollback_index >= OTP.rollback[slot].
- After successful boot, bootloader programs additional fuses until
  OTP.rollback[slot] == header.rollback_index.

| Slot | image_type | width (fuses) |
|---|---|---|
| 0 | bootloader (BL1) | 32 |
| 1 | bootloader (BL2) | 32 |
| 2 | vbmeta | 32 |
| 3 | recovery | 16 |
| 4 | vendor_boot | 16 |

See `otp-fuse-map.md` for physical fuse allocation.

## 5. Lifecycle states

Lifecycle is stored as a one-hot fuse field; transitions are one-way.

| State | Code | Description | Debug | OTA | Fastboot flash |
|---|---|---|---|---|---|
| BLANK | 0b0000_0001 | Untrimmed die from foundry. | Full | n/a | n/a |
| DEV | 0b0000_0010 | Engineering bring-up. Accepts dev-signed images (flag allow_dev=1). | Full | dev-keys | yes |
| MFG | 0b0000_0100 | Factory provisioning. Accepts mfg-signed images. | Auth required | mfg-keys | yes (gated) |
| LOCKED | 0b0000_1000 | Production. Accepts only production-keyed images. | Auth required | prod-keys | denied unless unlocked then wipe |
| RMA | 0b0001_0000 | Authorized service. User-data partitions wiped on entry. | Auth required | rma-keys | yes |
| SCRAP | 0b0010_0000 | Permanently disabled. ROM halts immediately. | None | None | None |

Allowed transitions: BLANK->DEV, BLANK->MFG, MFG->LOCKED, LOCKED->RMA, any->SCRAP.

min_lifecycle_state in the header lets a production-signed image refuse to
boot on a DEV unit.

## 6. ROM halt behavior

ROM halts and emits a 32-byte structured halt record on UART at 115200n8 if:

- magic mismatch
- header_version unsupported
- payload_sha256 mismatch
- signature verification failure
- pubkey hash != OTP root
- rollback_index < OTP rollback slot
- key_id revoked
- lifecycle < min_lifecycle_state
- OTP read parity failure on any security fuse

Halt is hard: WDT disabled, all DMA quiesced, JTAG state per `debug-policy.md`.
There is no fallback to an unsigned image. There is no "secure mode bypass".

## 7. Cross-references

- `threat-model.md` mitigations M1, M2, M14
- `avb-a-b-ota.md` for AVB chain layering
- `otp-fuse-map.md` for fuse allocation
- `test-plan.md` cases TC-BOOT-* and TC-ROLLBACK-*
