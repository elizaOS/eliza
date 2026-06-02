# Manufacturing Key Ceremony and Signer Operations

Status: pre-silicon specification. No HSM, signer infrastructure, or audit
pipeline exists yet. This document defines requirements before any production
board may be provisioned to LOCKED state.

## 1. Roles

| Role | Description | Min headcount | Separation |
|---|---|---|---|
| Ceremony Officer (CO) | Conducts the ceremony, holds script, witnesses logs. | 1 | May not hold HSM credentials. |
| Key Custodian A / B (KC-A, KC-B) | Hold split-knowledge HSM activation credentials. | 2 | Each holds 1-of-2 PED key / smartcard. |
| Witness (W) | Independent witness; signs ceremony minutes. | 1 | Not employed by ceremony team. |
| Auditor (AU) | Reviews logs post-ceremony; read-only. | 1 | Not present during ceremony. |
| Vulnerability-response Owner (VRO) | Named accountable person for incident triage and key revocation decisions. | 1 | Named in key-ceremony.md revision history. |

No single individual may simultaneously hold any two of: HSM activation
credentials, signer-host root credentials, or release-manager credentials.

## 2. HSM and signer topology

| Tier | Hardware | Network | Keys | Use |
|---|---|---|---|---|
| Offline root HSM | FIPS 140-2 L3 or higher; PED-authenticated; smartcard-backed. | Air-gapped; write-once optical only. | Root key R; revocation key. | Sign AVB key A, vendor keys V, OTA key O. Ceremony only. |
| Online signing HSM | FIPS 140-2 L3; network-attached over mTLS. | Build VLAN, ACL'd to signer host only. | A, V, O, debug-auth, RMA keys. | Per-build signing on CI. |
| Signer host | Hardened Linux; reproducible image; remote attestation. | mTLS to online HSM only. | None (HSM-backed). | Receives image hash, returns signature. |

## 3. Ceremony script (root key generation)

Prereqs: room with no networked devices, two cameras, optical write-once
recorder, fresh tamper-evident bags, signed agenda witnessed by W.

1. CO reads agenda aloud; W confirms attendance and recording.
2. KC-A and KC-B verify HSM tamper seals; record seal IDs.
3. CO powers HSM zeroized; KC-A and KC-B enter PED keys.
4. HSM generates Ed25519 keypair R inside the secure boundary.
   Private key never leaves the HSM.
5. HSM exports R.pub; CO records SHA-256 hash on paper and reads digits
   aloud; W verifies against terminal display.
6. CO computes OTP.root_key_hash candidate; commits to release manifest.
7. HSM produces signed KeyCertificate-AVB; AVB keypair A generated on
   online HSM in same sitting.
8. Audit log written to two independent write-once optical disks.
9. Tamper bags resealed; bag IDs and seal IDs recorded.
10. AU receives audit log within 24 h; signs review record within 7 days.

Re-ceremony required if: any tamper-evident seal broken; HSM firmware
updated; any custodian rotated; root key revoked.

## 4. Per-build signing flow

```
CI builder --> signer host --> online HSM
                       ^              |
                       |              | signature
                       |              v
                       +--------- audit log entry
                                      |
                                      v
                       append-only audit store (replicated)
```

Each signature request must include: image SHA-256, image_type, requested
key_id, build provenance (git SHA, CI run URL, builder identity), requester
(signed mTLS client cert).

Each emitted audit entry contains the above plus signer host attestation
quote, HSM serial, key_id, timestamp, sequence number. Sequence numbers are
gap-checked nightly; any gap is a P0 incident.

## 5. Board identity provisioning

Per-device steps on the manufacturing line, lifecycle = MFG:

1. ATE reads die-unique SRAM PUF or e-fuse UID; computes device_uid.
2. Provisioning station requests per-device attestation key from online HSM
   signed by AVB key A; HSM returns certificate bound to device_uid.
3. ATE programs into OTP:
   - root_key_hash (SHA-256(R.pub))
   - debug_auth_pubkey_hash
   - initial rollback_index values
   - device_uid parity bits
4. ATE writes attestation key blob into RPMB/secure storage; bootloader
   refuses to leave MFG without the blob present.
5. ATE runs readback verification; mismatch -> board to scrap bin, fuses
   lifecycle = SCRAP.
6. ATE invokes mfg-to-locked transition only after full functional test pass;
   transition is a separate signed manifest entry.

## 6. Audit log requirements

| Property | Requirement |
|---|---|
| Append-only | Storage layer rejects in-place edits; daily Merkle root anchored to release manifest. |
| Replication | Three replicas in two physical sites. |
| Retention | 10 years minimum; longer if any device on that key is still in field. |
| Searchability | Indexed by image SHA, key_id, builder, device_uid. |
| Integrity check | Nightly Merkle-root recomputation; mismatch is P0. |
| Review SLA | AU reviews ceremony logs within 7 days, signer logs weekly. |
| Incident handover | VRO on-call rotation; revocation decisions documented inside audit store. |

## 7. Key rotation and revocation

- Online keys (A, V, O, debug-auth, RMA) rotated annually or on incident.
  Rotation signed by R; old key_id revoked in revocation list and (for
  fielded devices) in OTP.revoked_key_bitmap on next OTA.
- Root key R rotation requires re-ceremony and, for fielded devices, a
  signed root-rotation OTA that programs a new root_key_hash into the
  reserved OTP slot. Devices without that slot are field-fixed.
- Revocation list distributed inside every OTA payload; bootloader applies
  revocations at next boot.

## 8. Cross-references

- `threat-model.md` mitigations M11, M12
- `boot-image-format.md` §3 key ladder, §4 rollback
- `otp-fuse-map.md` fuse allocation
- `test-plan.md` cases TC-MFG-*, TC-SIGNER-*

## 9. Machine-checkable evidence contract

This document is allowed to remain a pre-silicon operating contract only when
it explicitly refuses production claims and names the artifacts required to
promote it. It is not production key-ceremony evidence by itself.

### Non-claim flags

| Flag | Value |
|---|---|
| release_claim_allowed | false |
| secure_boot_claim_allowed | false |
| silicon_secure_boot_claim_allowed | false |

### Required production evidence

Production promotion requires all of these machine-checkable evidence records:

- HSM attestation bundle: vendor certificate chain, FIPS validation reference,
  firmware version, device serial, and tamper-seal IDs.
- Ceremony transcript: signed agenda, participant role roster, witness
  signatures, video-log digest, and timestamped root-key generation transcript.
- Public-key digest manifest: `R.pub`, SHA-256 digest, OTP root-key-hash
  candidate, and release-manifest binding.
- Signer audit export: append-only log snapshot with sequence numbers, HSM
  serials, signer-host attestation quotes, request image hashes, and Merkle
  root.
- Provisioning sample log: device UID, programmed OTP fields, readback result,
  lifecycle transition record, and scrap-bin disposition for any mismatch.
- Revocation drill record: test key revocation list, OTA distribution proof,
  rollback-index update, and verifier rejection transcript.

The boot-security checker may treat this file as contract-backed only while the
non-claim flags and required production evidence section remain present.
