# Security / Boot / OTA / Debug Test Plan

Status: pre-silicon test plan. No test cases below are currently passing;
all are blocked on absent ROM, bootloader, OTA, AVB, and debug logic. Each
case lists the evidence-file path that the
`security-usb-storage-update-fail-closed-work-order-2026-05-17.yaml` check
will require before any matching claim may be made.

Evidence files are JSON transcripts plus raw UART/log captures. Path schema:

```
docs/manufacturing/evidence/security/<TC-ID>/{transcript.json, uart.log, payload.sha256}
docs/manufacturing/evidence/usb-storage-update/<TC-ID>/{transcript.json, ...}
```

Every expected log line below MUST be present (substring match) in
`uart.log` or the relevant Android logcat capture; the harness asserts on
absence.

---

## Secure boot - image acceptance / rejection

### TC-BOOT-001 - Signed image acceptance (positive)
- Prereq: lifecycle=DEV; dev root key fused; production-signed image flagged
  `allow_dev=1`; signer audit entry archived.
- Steps: power-on; boot from SPI; capture ROM and BL1 UART.
- Expected: `ROM: sig_ok key_id=0x01`, `BL1: vbmeta verified`,
  `androidboot.verifiedbootstate=green`.
- Evidence: `docs/manufacturing/evidence/security/TC-BOOT-001/`

### TC-BOOT-002 - Unsigned image rejection (negative)
- Prereq: image with `signature_blob` zeroed.
- Steps: flash image to bootloader partition; power-on.
- Expected: ROM emits halt record `HALT: code=SIG_BAD`; no further stage runs;
  WDT does not reset into fallback.
- Evidence: `docs/manufacturing/evidence/security/TC-BOOT-002/`

### TC-BOOT-003 - Tampered image rejection (negative)
- Prereq: signed image with one payload byte flipped.
- Steps: flash; power-on.
- Expected: `HALT: code=HASH_MISMATCH`.
- Evidence: `.../TC-BOOT-003/`

### TC-BOOT-004 - Wrong-key image rejection (negative)
- Prereq: image signed by a key whose hash != OTP root.
- Steps: flash; power-on.
- Expected: `HALT: code=PUBKEY_MISMATCH key_id=0xNN`.
- Evidence: `.../TC-BOOT-004/`

### TC-BOOT-005 - Revoked-key image rejection (negative)
- Prereq: OTP `revoked_key_bitmap` bit set for key_id=0x02; image signed
  with that key.
- Steps: power-on.
- Expected: `HALT: code=KEY_REVOKED key_id=0x02`.
- Evidence: `.../TC-BOOT-005/`

### TC-BOOT-006 - Corrupt header rejection (negative)
- Prereq: image with bad magic.
- Expected: `HALT: code=MAGIC_BAD`.
- Evidence: `.../TC-BOOT-006/`

### TC-BOOT-007 - min_lifecycle refusal (negative)
- Prereq: production-only image (`min_lifecycle_state=LOCKED`); lifecycle=DEV.
- Expected: `HALT: code=LIFECYCLE_TOO_LOW`.
- Evidence: `.../TC-BOOT-007/`

### TC-BOOT-008 - Missing/erased key material halts before mutable firmware (negative)
- Prereq: OTP `root_key_hash` all-zero or parity bad.
- Expected: `HALT: code=ROOT_KEY_INVALID`; SPI not written; no mutable firmware
  executes.
- Evidence: `.../TC-BOOT-008/`

---

## Rollback protection

### TC-ROLLBACK-001 - Old image rejected
- Prereq: OTP rollback slot for bootloader = 5; image with `rollback_index=4`.
- Expected: `HALT: code=ROLLBACK_BLOCKED slot=0 want=4 have=5`.
- Evidence: `.../TC-ROLLBACK-001/`

### TC-ROLLBACK-002 - Equal index accepted
- Image with `rollback_index = OTP slot`. Boots; OTP not modified.
- Evidence: `.../TC-ROLLBACK-002/`

### TC-ROLLBACK-003 - Higher index advances fuse after successful boot
- After `mark_boot_successful`, OTP slot programmed up to image index.
  Verified via fuse readback.
- Evidence: `.../TC-ROLLBACK-003/`

---

## Debug policy

### TC-DEBUG-001 - DEV JTAG open
- Lifecycle=DEV; JTAG IDCODE + halt + memory read succeed.
- Evidence: `.../TC-DEBUG-001/`

### TC-DEBUG-002 - LOCKED JTAG denied
- Lifecycle=LOCKED; JTAG IDCODE returns zero; no halt possible; tamper
  counter increments after 16 attempts.
- Evidence: `.../TC-DEBUG-002/`

### TC-DEBUG-003 - MFG debug-auth success
- Valid Ed25519 signature over `device_uid||nonce||caps`; debug becomes
  available for one boot.
- Evidence: `.../TC-DEBUG-003/`

### TC-DEBUG-004 - MFG debug-auth failure
- Bad signature; `debug_auth_valid` remains 0; tamper counter increments.
- Evidence: `.../TC-DEBUG-004/`

### TC-DEBUG-005 - RMA entry wipes KeyMint keys
- Trigger LOCKED->RMA; readback of KeyMint key blob storage = all-zero;
  `rma_wipe_done` fuse=1 before next reset.
- Evidence: `.../TC-DEBUG-005/`

### TC-DEBUG-006 - debug_disable kill-switch
- Program `debug_disable[jtag]=1` on a DEV device; JTAG no longer enumerates
  even with valid auth.
- Evidence: `.../TC-DEBUG-006/`

---

## fastboot lock state

### TC-FASTBOOT-001 - Unauthorized flash on LOCKED denied
- `fastboot flash boot` on LOCKED+unlocked=0 returns `FAIL`; partition unmodified.
- Evidence: `docs/manufacturing/evidence/usb-storage-update/TC-FASTBOOT-001/`

### TC-FASTBOOT-002 - `oem unlock` wipes userdata
- userdata flag set; unlock triggers wipe; verified-boot reports ORANGE.
- Evidence: `.../TC-FASTBOOT-002/`

### TC-FASTBOOT-003 - `oem lock` wipes userdata
- Re-lock wipes user data and KeyMint keys.
- Evidence: `.../TC-FASTBOOT-003/`

### TC-FASTBOOT-004 - getvar lock state matches reality
- `fastboot getvar unlocked` returns value consistent with persistent flag
  and verified-boot state reported to kernel.
- Evidence: `.../TC-FASTBOOT-004/`

---

## A/B slot switch and recovery

### TC-AB-001 - Successful slot switch after OTA
- Apply OTA from slot A to slot B; reboot; B boots; `mark_boot_successful`
  invoked; misc updated.
- Evidence: `.../TC-AB-001/`

### TC-AB-002 - Slot revert after unbootable inactive slot
- Inject panic in B kernel post-OTA; bootloader decrements `tries_remaining`
  twice, falls back to A; visible warning to user.
- Evidence: `.../TC-AB-002/`

### TC-RECOVERY-001 - Recovery boot
- `reboot recovery`; recovery image AVB-verified; UI reachable; reboot back.
- Evidence: `.../TC-RECOVERY-001/`

### TC-RECOVERY-002 - Recovery sideload bad signature rejected
- `adb sideload` with tampered payload; recovery aborts, no partition write.
- Evidence: `.../TC-RECOVERY-002/`

---

## OTA failure modes

### TC-OTA-001 - Bad payload signature rejected
- Tampered OTA payload; update_engine refuses; inactive slot unmodified.
- Evidence: `.../TC-OTA-001/`

### TC-OTA-002 - Wrong key rejected
- Payload signed with non-O key; rejected; logged.
- Evidence: `.../TC-OTA-002/`

### TC-OTA-003 - Rollback OTA rejected
- Payload `rollback_index < OTP slot`; rejected before write.
- Evidence: `.../TC-OTA-003/`

### TC-OTA-004 - Corrupt metadata rejected
- vbmeta within payload truncated; rejected.
- Evidence: `.../TC-OTA-004/`

### TC-OTA-005 - Interrupted download resumes
- Kill network mid-download; resume; finishes; verifies.
- Evidence: `.../TC-OTA-005/`

### TC-OTA-006 - Interrupted install recovery
- Power cut mid-write to inactive slot; next boot: inactive marked
  unbootable, active slot continues; user can retry OTA.
- Evidence: `.../TC-OTA-006/`

### TC-OTA-007 - Full storage refusal
- Fill data partition; start OTA; refused with `insufficient space`; no
  writes.
- Evidence: `.../TC-OTA-007/`

### TC-OTA-008 - Low battery refusal
- Battery < 20% and no charger; OTA refuses; surfaced to UI.
- Evidence: `.../TC-OTA-008/`

### TC-OTA-009 - Unbootable new slot reverts
- Inject failure in new slot kernel; after N=2 tries revert to old slot;
  rollback index NOT advanced.
- Evidence: `.../TC-OTA-009/`

### TC-OTA-010 - Recovery sideload bad payload
- Tampered payload via sideload; recovery rejects.
- Evidence: `.../TC-OTA-010/`

---

## Manufacturing / signer

### TC-MFG-001 - OTP programming and readback
- Provision lifecycle, root key hash, debug-auth hash, initial rollback;
  readback matches; line audit log entry created.
- Evidence: `.../TC-MFG-001/`

### TC-MFG-002 - Forbidden lifecycle transition refused
- Attempt LOCKED->DEV; OTP write logic refuses; halt log emitted.
- Evidence: `.../TC-MFG-002/`

### TC-SIGNER-001 - Signature emits audit log entry
- Per-build signing produces signer audit row with image SHA, key_id,
  builder identity, HSM serial, timestamp, sequence number.
- Evidence: `.../TC-SIGNER-001/`

### TC-SIGNER-002 - Audit gap detected
- Inject deleted sequence number; nightly audit job raises P0; release
  blocked.
- Evidence: `.../TC-SIGNER-002/`

---

## Evidence index

A passing run of `scripts/check_security_usb_update_work_order.py` (to be
written under `scripts/`) must verify the presence and JSON-schema validity
of every `transcript.json` listed above. Until that script exists and a real
hardware/lab transcript backs every TC, the corresponding claims listed in
`docs/project/security-usb-storage-update-fail-closed-work-order-2026-05-17.yaml`
`forbidden_claims` MUST remain unclaimed.
