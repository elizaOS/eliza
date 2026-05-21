# AVB Chain, A/B Slots, OTA, and Recovery

Status: pre-silicon specification, with the vbmeta **verification** path now
implemented in firmware and exercised by host known-answer + negative tests.
The freestanding vbmeta verifier (`fw/avb/avb_verify.{c,h}`) parses the real
libavb vbmeta image and descriptor formats, verifies the authentication block,
pins the AVB key, checks rollback, and walks hash/hashtree/chain/property
descriptors; it builds freestanding for riscv64 and is gated by
`scripts/check_avb_verify.py` (report `build/reports/avb_verify.json`). See §2.1
for the implemented scope and the E1 algorithm profile.

The rest of this document remains specification. What is **not** yet
implemented: on-device AVB *enforcement* inside a booted Android image
(dm-verity activation, `androidboot.verifiedbootstate` propagation, the
fstab-driven runtime path) is gated on the AOSP boot lane; full A/B OTA
download/apply, slot switching, and recovery sideload (§§4-7) are
specification only; and the silicon root-of-trust — the OTP rollback fuses and
RoT crypto that supply the verifier's trust inputs — is hardware-gated. AOSP
`fstab.eliza` AVB flags remain scaffold markers. No production verified-boot
claim follows from host/sim evidence alone.

## 1. A/B slot layout

Two complete sets of bootable partitions, suffixed _a and _b:

| Partition | Slot | AVB-covered | Notes |
|---|---|---|---|
| bootloader (BL1/BL2 fused image) | A/B | yes | First-stage chain-of-trust root after ROM. |
| vbmeta | A/B | yes (self) | Top-level AVB descriptor; signed by key A. |
| boot | A/B | yes | Kernel + ramdisk. |
| vendor_boot | A/B | yes | Vendor ramdisk fragments. |
| dtbo | A/B | yes | Device-tree overlays. |
| system | A/B | yes (hashtree) | dm-verity. |
| vendor | A/B | yes (hashtree) | dm-verity. |
| product | A/B | yes (hashtree) | dm-verity. |
| recovery | shared | yes | One physical copy; own AVB descriptor. |
| misc | shared | no | Bootloader message and slot metadata. |
| userdata | shared | no (encrypted) | metadata-encrypted; FBE for per-file. |
| metadata | shared | no | KeyMint key blobs and DSU metadata. |
| persist | shared | no | Calibration; signed at factory. |

Slot metadata in `misc` per AOSP bootloader-message format:

- priority (0-15)
- tries_remaining (0-7)
- successful_boot (0/1)
- verity_corrupted (0/1)
- slot_suffix

Active slot = highest priority with tries_remaining > 0 or successful_boot == 1.

## 2. AVB chain

```
OTP.root_key_hash
        |
        v
   BL1 (verifies BL2 against header.next_stage_pubkey_hash)
        |
        v
   BL2 (loads vbmeta_$slot, verifies sig with key A)
        |
        v
   vbmeta (chain-descriptors -> boot, vendor_boot, dtbo;
           hashtree-descriptors -> system, vendor, product)
        |
        v
   boot, vendor_boot, dtbo (whole-partition hashes verified pre-kexec)
        |
        v
   system, vendor, product (dm-verity hashtree at runtime)
```

androidboot.verifiedbootstate values:

- GREEN: locked, AVB root chains to OTP root.
- YELLOW: locked, signed by user key (not used in v0).
- ORANGE: unlocked (fastboot oem unlock); user-keyed; user-data wiped.
- RED: AVB failure; bootloader halts before kernel.

### 2.1 Implemented vbmeta verifier (E1 Ed25519 profile)

`fw/avb/avb_verify.{c,h}` implements the vbmeta **verification** step of the
chain above. It is freestanding (no malloc, no libc beyond the shared crypto
sources), fail-closed (first failing check returns a distinct error code; only
an all-pass returns `AVB_OK`), and reuses the constant-time SHA-256 and Ed25519
primitives from `fw/boot-rom/secure` — no crypto is duplicated.

On-wire format: the verifier parses the real libavb image — the 256-byte
big-endian `AvbVBMetaImageHeader` (`magic "AVB0"`, required libavb version,
authentication/auxiliary block sizes, `algorithm_type`, the hash/signature/
public-key/descriptors offset+size pairs, `rollback_index`, `flags`,
`rollback_index_location`, release string) followed by the authentication block
and the auxiliary block — and the libavb descriptor stream (`AvbDescriptor`
header plus bodies for tags HASH=2, HASHTREE=1, CHAIN_PARTITION=4, PROPERTY=0,
and KERNEL_CMDLINE=3). Every block size and every sub-field offset+size is
bounds-checked against the supplied image length before any field is read;
out-of-range descriptors are rejected.

Algorithm profile — **E1, not libavb-RSA**: libavb's standard authentication is
`SHA256_RSA*`. The E1 root-of-trust key ladder is Ed25519
(`boot-image-format.md` §1), so this verifier authenticates vbmeta with
Ed25519: the authentication hash is `SHA-256(header || auxiliary block)` (the
authentication block, which holds the hash and signature, is excluded from the
hashed span, matching libavb's `avb_vbmeta_image_verify`), and the signature is
Ed25519 (RFC 8032) over that 32-byte hash, made with AVB key A. The profile is
carried in `algorithm_type` as the vendor-reserved id
`AVB_ALGORITHM_TYPE_E1_SHA256_ED25519`; the four standard libavb RSA ids are
recognized only so they can be rejected with a precise error. **No
libavb-RSA-compatibility is claimed or implemented.**

Verification order: OTP parity gate → header parse + structural bounds → magic
→ libavb major version → block bounds → E1 algorithm id → `flags` must not
disable verification → auth hash → AVB-key pin → Ed25519 signature → rollback
floor → descriptor walk. The AVB-key pin (`SHA-256(aux public key)` ==
expected hash supplied by the loading boot stage) is the AVB analogue of the
OPNPHN01 key ladder's `next_stage_pubkey_hash`. The rollback check refuses any
`rollback_index` below the OTP floor for this image's
`rollback_index_location` (`boot-image-format.md` §4 slot 2). Chain-partition
descriptors are recorded as pins (partition name, rollback location, the
trusted vbmeta public key) so the bootloader can load and verify each chained
vbmeta with `expected_pubkey_hash = SHA-256(pin.public_key)` — the verifier
does not itself recurse into chained partitions. Hash descriptors are verified
against caller-supplied partition images when provided (`SHA-256(salt ||
image)`; SHA-256 digests only). Hashtree descriptors are validated for
well-formedness (the dm-verity root digest field is bounds-checked); dm-verity
activation itself is a runtime-enforcement concern on the AOSP boot lane and is
out of scope here.

Evidence: `fw/avb/tests/make_vbmeta.py` (independent python `cryptography`
Ed25519) builds a valid image plus tampered-descriptor, wrong-key, bad-magic,
rollback-downgrade, truncated-aux, and corrupted-hash-descriptor negatives;
`fw/avb/tests/test_kat.c` asserts the exact `avb_result` for each.
`bash fw/avb/tests/run_tests.sh` runs the suite and the riscv64 freestanding
build; `python3 scripts/check_avb_verify.py` is the gate
(`build/reports/avb_verify.json`, `eliza.gate_status.v1`). Scope is vbmeta
verification only — see the status block for what remains specification.

## 3. Rollback protection

- vbmeta header carries rollback_index_location and rollback_index.
- Bootloader refuses image whose index < OTP slot value
  (see `boot-image-format.md` §4).
- After successful boot (post-mark_boot_successful), bootloader programs
  fuses to advance the OTP slot to the image's rollback_index.

## 4. OTA failure-mode matrix

| Failure | Detector | Response | Test case |
|---|---|---|---|
| Bad payload signature | OTA client (pre-write verify) | Abort before any write to inactive slot. | TC-OTA-001 |
| Wrong key | OTA client | Abort; log key_id mismatch. | TC-OTA-002 |
| Rollback (index too low) | OTA client + bootloader | Abort. | TC-OTA-003 |
| Corrupt vbmeta metadata | OTA client | Abort; do not mark inactive slot bootable. | TC-OTA-004 |
| Interrupted download | OTA client | Resume from last verified chunk. | TC-OTA-005 |
| Interrupted install / power loss mid-write | bootloader | Inactive slot marked unbootable; active slot continues. | TC-OTA-006 |
| Full storage | OTA client | Refuse to start; surface "insufficient space"; no partial writes. | TC-OTA-007 |
| Low battery | OTA client (Health HAL) | Refuse below configurable threshold (default 20% or charger present). | TC-OTA-008 |
| Unbootable slot after switch | bootloader (tries_remaining decrement) | After N=2 failed boots, revert to previous slot. | TC-OTA-009 |
| Recovery sideload of bad payload | recovery | Same checks as OTA; abort on failure. | TC-OTA-010 |

## 5. OTA streaming / staging policy

- OTA downloads stream into a dedicated staging area inside /data/ota, never
  into the inactive slot directly.
- Verification: whole-payload signature + per-block hashes inside the payload
  protobuf. Both must pass before any write to inactive slot.
- Apply phase writes inactive slot blocks; bootloader-message updated last,
  atomically.
- Mark inactive slot active with priority=15, tries_remaining=2,
  successful_boot=0.
- Next boot: bootloader attempts new slot. On user-visible boot success
  (post mark_boot_successful from update_engine), bootloader sets
  successful_boot=1, tries_remaining=0 for new slot and clears flags on old
  slot; rollback index advanced.

## 6. Recovery partition spec

- Standalone bootable image with minimal kernel + initramfs + recovery binary
  + sideload UI.
- Covered by its own AVB descriptor signed by key A; rollback slot 3.
- Recovery may not write to OTP, may not change lifecycle state, may not
  reveal user keys.
- Recovery sideload requires the same signature checks as OTA.
- Recovery may invoke fastboot oem unlock flow's wipe path; recovery itself
  does not bypass lock.
- Recovery boot reason logged via bootloader-message; reasons: recovery,
  update, bootloader, --wipe_data, --wipe_cache.

## 7. fastboot / fastbootd

| Command | DEV | MFG | LOCKED (unlocked=0) | LOCKED (unlocked=1) | RMA |
|---|---|---|---|---|---|
| fastboot flash (any partition) | allowed | allowed (mfg-key images only) | denied | allowed (user-key images, ORANGE) | allowed (RMA-key) |
| fastboot erase userdata | allowed | allowed | denied | allowed | allowed |
| fastboot oem unlock | n/a | n/a | allowed if userdata flag set; triggers wipe | n/a | n/a |
| fastboot oem lock | n/a | n/a | n/a | allowed; triggers wipe | n/a |
| fastboot getvar all | allowed | allowed | allowed (limited) | allowed | allowed |
| fastboot reboot bootloader/recovery | allowed | allowed | allowed | allowed | allowed |

fastbootd (userspace fastboot) handles dynamic partitions and is subject to
the same lock policy.

## 8. Cross-references

- `threat-model.md` mitigations M3-M9
- `boot-image-format.md` for image format and rollback fuses
- `debug-policy.md` for unlock + wipe coupling
- `test-plan.md` cases TC-OTA-*, TC-AB-*, TC-RECOVERY-*, TC-FASTBOOT-*
