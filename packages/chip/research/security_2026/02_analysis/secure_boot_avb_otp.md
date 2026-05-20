# Phone-Class Secure Boot, AVB, OTP/eFuse and Lifecycle on RISC-V

Date: 2026-05-19

This note focuses on the bootloader chain and OTP/lifecycle pieces of
the secure subsystem: AVB 2.0/3.0, U-Boot Verified Boot, EDK2 Secure
Boot, OpenSBI signed payloads, dm-verity / fs-verity, A/B and rollback
protection, and what real OTP/eFuse macros are available on the
candidate process nodes. The goal is to anchor the pre-silicon contract
documents (`docs/security/boot-image-format.md`, `docs/security/avb-a-b-ota.md`,
`docs/security/otp-fuse-map.md`, `docs/security/debug-policy.md`,
`docs/security/secure-boot-lifecycle-evidence.md`) to open implementations
that can fill the BLOCKED rows.

## 1. AVB 2.0 on E1

AVB 2.0 is the AOSP-mandated boot-time integrity scheme. Our
`docs/security/avb-a-b-ota.md` already codifies the chain partitions
(vbmeta -> boot, vendor_boot, dtbo + hashtree-descriptors over system,
vendor, product). The reference implementation is `libavb` (AOSP) and
its tooling (`avbtool`).

**What we should reuse from libavb:**

- `avb_slot_verify` -- main entry point. BL2 should invoke this against
  the active slot's vbmeta partition.
- `avb_descriptor_validate_and_byteswap` -- vbmeta descriptor parser.
- `avb_atx_*` -- Android Things eXtensions; provides a richer key
  hierarchy. v0 does not need ATX; the simpler libavb key descriptor
  is sufficient.
- `avb_vbmeta_image_verify` -- header + signature + rollback index
  check.

**Glue points to e1-chip:**

- BL2 must implement five `AvbOps` callbacks:
  `read_from_partition`, `get_unique_guid_for_partition`, `read_rollback_index`,
  `write_rollback_index`, `read_is_device_unlocked`.
- `read_rollback_index` and `write_rollback_index` go directly to the
  OTP rollback bank described in `docs/security/otp-fuse-map.md` §1
  (rows at offsets 832, 864, 896, 928, 944) and `docs/security/boot-image-format.md`
  §4 (image-type to slot mapping).
- `read_is_device_unlocked` reads the persistent unlocked flag mirrored
  in OTP offset 801 (`unlocked` mirror per otp-fuse-map.md §1).

**Hashtree vs hash descriptors:**

- `boot`, `vendor_boot`, `dtbo`, `recovery` partitions get whole-
  partition hash descriptors verified pre-kexec.
- `system`, `vendor`, `product` get hashtree (dm-verity) descriptors;
  block-level Merkle verification happens at runtime, not at boot.

This matches our table in `docs/security/avb-a-b-ota.md` §1; no change
needed to that table.

## 2. AVB 3.0 and future evolution

AVB 3.0 has not been formally published as of 2026-05-19 (AOSP
references remain at 2.0). When 3.0 lands, the expected deltas are:
post-quantum signature support (likely ML-DSA), explicit policy for
GKI / GKI-DTB, and tightening of the chain partition rules. None of
those break the v0 design; the chain table in `avb-a-b-ota.md` §1 is
forward-compatible.

For E1 v0: target AVB 2.0 with Ed25519. Reserve a `header_version=2`
slot in `docs/security/boot-image-format.md` §2.1 (we have it; it is
explicit `header_version=1`) for a future PQC migration. PQC-ready
firmware-signing keys are tracked in `02_analysis/pqc_and_crypto_accel.md`.

## 3. dm-verity and fs-verity

`docs/security/avb-a-b-ota.md` already lists dm-verity for system,
vendor, product. Two implementation choices:

- **`restart_on_corruption`** vs `ignore_corruption` vs `eio`. v0 uses
  `restart_on_corruption` (the AOSP default) so a corrupted block on
  the active partition forces a reboot into recovery and a slot revert
  via `tries_remaining` decrement. This satisfies TC-AB-002 in
  `docs/security/test-plan.md`.
- **FEC (forward error correction)** coverage. AVB's `avbtool
  add_hashtree_footer --do_not_use_ab` accepts a FEC parameter; with
  2-byte FEC, single-block uncorrelated corruption is auto-repaired
  with a logcat warning. We should ship with FEC enabled to reduce
  spurious slot reverts from media wear on long-lived eMMC blocks.

fs-verity is complementary: per-file Merkle trees signed by AOSP /
Play keys, applied to APKs, OAT artifacts, and conscrypt mainline
modules. The kernel side is built into modern AOSP kernels; we should
enable `CONFIG_FS_VERITY` and `CONFIG_FS_VERITY_BUILTIN_SIGNATURES` and
trust only AOSP fs-verity certs by default. fs-verity is not a v0
secure-boot blocker but is on the Android CTS path.

## 4. U-Boot Verified Boot and OpenSBI signed payloads (early bring-up)

For early board bring-up, U-Boot Verified Boot may temporarily replace
BL2 if we have not yet written our own AVB-aware bootloader. U-Boot
Verified Boot signs a FIT image; supported signature algorithms include
Ed25519. The DTB carries the trusted public keys.

OpenSBI sits at M-mode after the bootloader. For E1, OpenSBI binaries
should be packed inside the same signed image format described in
`docs/security/boot-image-format.md` §2 (i.e., the bootloader stage is
"OpenSBI + Linux payload" wrapped in our header + signature). OpenSBI's
own FW_PAYLOAD format already supports an embedded payload, and our
top-level container can wrap it.

**Recommendation:** Avoid U-Boot in the production path. Use it only
during board bring-up before BL2 exists, and gate its use with the DEV
lifecycle bit (`allow_dev=1` flag in `docs/security/boot-image-format.md`
§2.1 flags byte). U-Boot's verified-boot model conflicts with AVB
slot-and-rollback expectations; the cost of keeping U-Boot in production
is owning a second verifier path forever.

## 5. EDK2 secure boot — out of scope

EDK2 / UEFI secure boot is the natural fit for x86 / ARM laptop class
devices. The PE/COFF Authenticode model does not match Android's chain
partitions. Skipping EDK2 is correct for E1 v0; we should not "support
both" because that doubles the verifier surface and the audit cost.

## 6. OTP / eFuse macro options on the candidate processes

The largest single physical-IP risk for the security subsystem is the
fuse / OTP macro. Our `docs/security/otp-fuse-map.md` specifies "4 kbit
antifuse macro or 8 kbit OTP block on the target node" but explicitly
defers the vendor selection.

**Options on the open / shuttle path:**

- **Sky130 (SkyWater).** No vendor OTP IP in the open PDK. Antifuse
  macros for Sky130 exist only as research designs (e.g., MIT zero-mask-
  cost antifuse). Not viable for any LOCKED device claim.
- **GF180 (Global Foundries 180 nm, open PDK).** Vendor OTP IP exists
  but is not openly licensed; behind NDA at minimum.
- **TSMC N12 / N6 (intermediate node).** Multiple vendor OTP/anti-fuse
  IPs (Synopsys SkyOne, eMemory NeoFuse, KMI antifuse). All commercial,
  all NDA, but the standard option for a phone-class product.
- **GF22FDX (22 nm FDSOI).** Vendor antifuse macros (GF NVM) exist;
  same NDA caveats but lower mask cost than 12 nm and friendly for
  mixed-signal radio.

**Implication for v0.**

For the simulator + Sky130 / OpenLane prototype path that the e1-chip
repo currently uses, the OTP/fuse is necessarily synthetic. A small
"fuse RAM" model backed by simulator state is the only way to exercise
the boot-image-format + AVB + lifecycle test cases (TC-BOOT-*,
TC-ROLLBACK-*, TC-DEBUG-*). That synthetic model must be clearly
labelled as not-production, parallel to how `docs/arch/security.md`
labels the current ROM as identity-only.

For any LOCKED device claim, the chip must move to an intermediate
node with a real OTP macro. This is a major work order, not a small
detail; it crosses into the package, process, and EDA decisions in
`docs/architecture-optimization/compute-silicon.md`.

## 7. Rollback indices: unary encoding choice

Our `docs/security/otp-fuse-map.md` §2 uses unary encoding for
rollback indices (popcount of programmed bits). This is the AOSP /
AVB pattern (Pixel parts use a similar scheme). Advantages:

- Monotonic advance with no read-modify-write.
- Tolerant of partial fuse-blow events (one bit at a time).
- Trivial verification in ROM (no arithmetic; just compare popcount).

Disadvantage: each rollback slot consumes width bits of OTP. We've
allocated 32 fuses each for BL1, BL2, vbmeta; 16 fuses each for
recovery and vendor_boot. That caps the lifetime rollback budget at
32 advances per main image type. For a 5-7 year device lifetime with
quarterly security patches, that is approximately 1.5x to 2x headroom,
which is acceptable.

Caliptra and OpenTitan use the same approach.

## 8. Lifecycle and debug fuse interplay

`docs/security/debug-policy.md` §3 specifies derived enable signals
as combinational from OTP fields. The implementation rule is:

```
jtag_enable     = (state==DEV) | (state==BLANK)
               | ((state==MFG | state==RMA) & debug_auth_valid)
```

This is intentionally NOT software-writable; the debug controller
reads `lc_ctrl`-style outputs directly from the OTP shadow registers,
through replicated fuse paths, with a 2-of-3 majority vote per
`docs/security/otp-fuse-map.md` §3.

Open implementations to mirror here:

- OpenTitan `lc_ctrl` outputs `lc_dft_en_o`, `lc_hw_debug_en_o`,
  `lc_keymgr_en_o`, etc., each as a 4-bit one-hot mubi (multi-bit
  boolean) that is fault-resilient. Our debug-policy boolean checks
  should be implemented as mubi signals, not as single-bit Booleans.
  This is a direct fault-injection countermeasure (`02_analysis/side_channel_and_tamper.md`
  §3.2).

## 9. AVB-to-AVB-to-OTP chain wiring

Putting the pieces together for the production path:

```
OTP.root_key_hash  (256-bit; otp_ctrl partition; ECC + 2-of-3 majority)
       |
       v
ROM (mask, scrambled; rom_ctrl integrity check at boot)
       |  verifies pubkey hash == OTP.root_key_hash
       v
BL1 (Ed25519 verify of BL2 header || payload; next_stage_pubkey_hash pin)
       |
       v
BL2 (libavb avb_slot_verify against active slot vbmeta; rollback fuse
     read via avb_ops; passes verified-boot state to kernel cmdline)
       |
       v
kernel (dm-verity via libdm-verity for system/vendor/product; fs-verity
        for APKs and conscrypt)
       |
       v
init / KeyMint TA (TEE-side; pulls per-app keys from secure storage
                    wrapped by keymgr-derived HBK)
```

This is the explicit realization of `docs/security/threat-model.md` M1
+ M3 + M4 + M9 + AVB chain in `docs/security/avb-a-b-ota.md` §2.

## 10. Test cases that become passable

Adopting AVB 2.0 + libavb + an OpenTitan-class lifecycle + a real (or
synthetic-for-simulator) OTP closes the following `docs/security/test-plan.md`
cases at the simulator-level transcript granularity:

- TC-BOOT-001 through TC-BOOT-008 (signed/unsigned/tampered/wrong-key/
  revoked/corrupt/min-lifecycle/erased-key paths).
- TC-ROLLBACK-001 through TC-ROLLBACK-003.
- TC-AB-001, TC-AB-002.
- TC-RECOVERY-001, TC-RECOVERY-002.
- TC-OTA-001 through TC-OTA-004 (cryptographic OTA-payload checks).

The fastboot and OEM-unlock cases (TC-FASTBOOT-001 .. TC-FASTBOOT-004)
require the persistent-storage flag wiring; the debug cases (TC-DEBUG-*)
need the debug-auth challenge implementation (Ed25519 verify of
`OPDBGv1 || device_uid || nonce || requested_caps`).

The manufacturing cases (TC-MFG-001, TC-MFG-002, TC-SIGNER-*) need the
ATE flow specified in `docs/security/key-ceremony.md` §5, which is
process-and-line work, not chip RTL.

## 11. Cross-references

- `docs/security/avb-a-b-ota.md` §1 (slot layout), §2 (AVB chain), §3
  (rollback), §4 (failure matrix).
- `docs/security/boot-image-format.md` §1 (algorithms), §2 (container),
  §3 (key ladder), §4 (rollback), §5 (lifecycle), §6 (ROM halt).
- `docs/security/otp-fuse-map.md` §1 (allocation), §2 (semantics), §3
  (ECC), §4 (write authorization).
- `docs/security/debug-policy.md` §3 (derived enables), §4 (debug-auth
  challenge), §5 (LOCKED -> RMA), §7 (tamper logging).
- `docs/security/threat-model.md` mitigations M1 .. M14.
- `02_analysis/root_of_trust_landscape.md` for the RoT IP that owns
  the OTP/lifecycle blocks.
- `02_analysis/pqc_and_crypto_accel.md` for the Ed25519 verify
  implementation and a PQ-ready migration path.
