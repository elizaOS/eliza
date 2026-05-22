# AVB Chain, A/B Slots, OTA, and Recovery

Status: pre-silicon specification, with the vbmeta **verification** path AND the
A/B slot + OTA-apply + recovery bootloader logic now implemented in firmware and
exercised by host known-answer + negative tests.

The freestanding vbmeta verifier (`fw/avb/avb_verify.{c,h}`) parses the real
libavb vbmeta image and descriptor formats, verifies the authentication block,
pins the AVB key, checks rollback, and walks hash/hashtree/chain/property
descriptors; it builds freestanding for riscv64 and is gated by
`scripts/check_avb_verify.py` (report `build/reports/avb_verify.json`). See §2.1
for the implemented scope and the E1 algorithm profile.

The A/B slot state machine and OTA apply (`fw/avb/ab_slot.{c,h}`,
`fw/avb/ota_apply.{c,h}`) implement slot selection, OTA apply-to-inactive-slot,
automatic rollback on boot-try exhaustion, monotonic OTP rollback-floor advance
on a pinned boot, and recovery fallback — all gating on the same `avb_verify`
(no fakes). They build freestanding for riscv64 and are gated by
`scripts/check_ab_ota.py` (report `build/reports/ab_ota.json`). See §§4.1, 5.1,
6.1 for the implemented scope.

What is **not** yet implemented and remains specification: on-device AVB
*enforcement* inside a booted Android image (dm-verity activation,
`androidboot.verifiedbootstate` propagation, the fstab-driven runtime path) is
gated on the AOSP boot lane; the physical OTA download/staging, the flash/UFS
block write, the atomic bootloader-message commit, and recovery sideload UI
(the driver/platform half of §§5-7) are physical/driver follow-ons; fastboot
(§7) is specification only; and the silicon root-of-trust — the OTP rollback
fuses and RoT crypto that supply the verifier's trust inputs — is
hardware-gated. AOSP `fstab.eliza` AVB flags remain scaffold markers. No
production verified-boot or OTA claim follows from host/sim evidence alone.

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

### 4.1 Implemented A/B slot state machine

`fw/avb/ab_slot.{c,h}` implements the bootloader slot logic, the firmware model
of the AOSP `boot_control` HAL. Per-slot metadata (priority 0-15, tries_remaining
0-7, successful_boot, unbootable, cached rollback_index) mirrors the
bootloader-message record in `misc` (§1). It is freestanding (no malloc, no libc
beyond the shared crypto memcpy/memset) and fail-closed.

- `ab_select_slot()` considers A and B in priority order (ties to A), and for
  each eligible candidate (priority > 0, not unbootable, tries_remaining > 0 or
  already successful, image present) runs `avb_verify` against the live OTP
  rollback floor and the pinned AVB key A hash, with the slot's boot image fed
  as a hash target so the boot partition digest is confirmed too. The first slot
  returning `AVB_OK` is selected; a slot whose vbmeta fails is permanently marked
  unbootable. If neither A nor B is selectable it falls through to the recovery
  slot (§6.1), and if recovery also fails it returns `AB_ERR_NO_BOOTABLE_SLOT`
  (fail-closed halt — there is no unverified boot path).
- `ab_mark_boot_attempt()` decrements tries for the slot about to launch; a slot
  that reaches zero tries without a success is marked unbootable, so the next
  `ab_select_slot()` auto-reverts to the other slot or recovery (TC-OTA-009).
- `ab_mark_successful()` pins the slot (successful_boot=1, tries=0,
  priority=15), demotes the other A/B slot below it, and advances the OTP
  rollback floor monotonically to the booted image's rollback_index (§3; the
  firmware model of programming OTP fuses — the physical program is
  `fw/provisioning/e1_provision.py` / the OTP driver).

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

### 5.1 Implemented OTA apply

`fw/avb/ota_apply.{c,h}` implements `ota_apply()`: the apply half of this
section, fail-closed.

1. The target must be A or B and must not be the running (active) slot; recovery
   is never an OTA target.
2. **Pre-write verification** runs the same `avb_verify` gate over the payload
   vbmeta with the payload boot image as a hash target, against the live OTP
   rollback floor. A rollback-index downgrade (`AVB_ERR_ROLLBACK`), a tampered
   vbmeta (`AVB_ERR_HASH`), a wrong key (`AVB_ERR_PUBKEY_HASH`), or a corrupt
   descriptor is rejected here and **nothing is written** to the inactive slot
   (TC-OTA-001..004). The precise `avb_result` is returned for logging.
3. The verified payload is staged into the inactive slot (modeled as a
   capacity-checked software store; an oversized payload is refused with
   `OTA_ERR_NO_SPACE`, the TC-OTA-007 path).
4. The slot is armed active-pending: priority=15, tries_remaining=2 (`AB_OTA_TRIES`),
   successful_boot=0. A bad new image therefore auto-rolls-back via §4.1 after
   the tries are spent without an `ab_mark_successful()`.
5. A **post-write re-verify** runs `avb_verify` over the bytes that actually
   landed; a corrupted write disarms the slot (unbootable) and returns
   `OTA_ERR_VERIFY_POST`.

Scope boundary: the partition store is a software model. The OTA download into
`/data/ota`, the resumable chunk verification, the physical flash/UFS block
write, and the atomic bootloader-message commit are driver/platform follow-ons.

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

### 6.1 Implemented recovery selection

The recovery fallback is implemented in `ab_select_slot()` (§4.1): when neither
A nor B is bootable, the shared recovery slot is verified with the same
`avb_verify` gate, against its own OTP rollback floor (`recovery_rollback_floor`,
the recovery rollback slot 3 of `boot-image-format.md` §4) and the pinned AVB
key A. A recovery image that verifies is selected; an absent or
verification-failing recovery image fails closed to `AB_ERR_NO_BOOTABLE_SLOT`.
Recovery sideload of an OTA payload uses the same `avb_verify` checks as `ota_apply`
(§5.1); the sideload transport and UI are platform follow-ons.

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
