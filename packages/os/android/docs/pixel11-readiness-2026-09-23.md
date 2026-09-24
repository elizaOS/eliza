# Pixel 11 readiness review — September 23, 2026 UTC

**Not qualified for installation.** The repository contains a Pixel 11 Pro
(`grizzly`) candidate, not a universal Pixel 11 image. `installerEligible` and
`labExperimentsEligible` remain false, and production trust remains unenrolled.
Do not use Cuttlefish results as physical-device qualification.

## Upstream review

- [Google's factory-image table](https://developers.google.cn/android/images?hl=en)
  distinguishes Pixel 11 `cubs`, Pro `grizzly`, Pro XL `kodiak`, and Fold `yogi`.
  The Pro September release is `CD1A.260905.001.B1`, while our lock remains
  `CD1A.260714.001.A9`. No newer image was silently substituted into the lock.
  The documented May 2026 inactive-slot rollback warning applies to the listed
  Pixel 10 models; it is not proof of a Pixel 11-specific failure. It does
  demonstrate why recovery must match measured firmware and rollback state.
- GrapheneOS initially described a partial port and suspected missing hardware
  MTE, but its [September 1 update](https://bsky.app/profile/grapheneos.org/post/3mugn23cpx22l)
  confirmed some hardware support while leaving performance/usability unresolved.
  The earlier [announcement](https://discuss.grapheneos.org/d/41564-pixel-11-doesnt-meet-the-grapheneos-security-standards-and-may-be-skipped)
  must not be read as the final hardware finding. Pixel 11 remains absent from
  the [official production list](https://grapheneos.org/faq#supported-devices).
  Neither MTE report diagnoses our two failed installs. See the
  [subsequent complete-toolchain review](pixel11-upstream-audit-2026-09-23.md)
  for newer common configuration and carrier/firmware changes.
- The [LineageOS device inventory](https://github.com/LineageOS/lineage_wiki/tree/main/_data/devices)
  was checked through GitHub's contents API (739 entries). No `cubs`, `grizzly`,
  `kodiak`, or `yogi` device entry was present. This is not a claim that no
  unofficial development exists.
- GitHub's path-specific commit history on GrapheneOS branch `17` still points
  to initial grizzly configuration commit
  `bbc05913de19f17205b7a40311a843f36720dcaf` in
  [adevtool](https://github.com/GrapheneOS/adevtool/commits/17/config/device/grizzly.yml)
  and vendor-state commit `afd6a0c9f6ca13d395f00e98227a0866cc14de07` in
  [vendor_state](https://github.com/GrapheneOS/vendor_state/commits/17/grizzly.json).
  These narrow history checks do not certify all upstream common-code changes.
- [Android Verified Boot](https://source.android.com/docs/security/features/verifiedboot/avb)
  requires a complete device-specific signing and rollback chain. A public
  userdebug test key is not evidence that a retail bootloader can safely relock.

Android Studio can inspect our APK, debug application startup, and profile a
booted target. It cannot certify bootloader compatibility, restore unavailable
OEM recovery transports, or prove a complete OS image safe to flash.

## Verification completed

Based on merged OS `5c0b722fe8e8572940675a1ba4a3b10283eaea35`:

- Corrected the signed installer's stale TCP health probe to use the packaged
  runtime's authenticated NDJSON abstract socket `eliza_local_agent_v1`.
  Credentials travel through child stdin, never command arguments; forwarding
  uses the selected serial and an allocated port, bounded I/O, and cleanup.
- `bun install --frozen-lockfile` and `bun run verify` passed: 224 Node release
  tests and 113 Bun contract tests, plus workspace and native compiler checks.
  Transport tests exercise the real framing, authentication header, identity
  validation, and failure cleanup. Existing installer tests continue to reject
  wrong images/slots, unhealthy runtime, unknown firmware and unsafe writes.
- Tested the new subprocess transport against the existing booted Cuttlefish:
  authenticated health 200/ready true; invalid token 401; forwarding inventory
  unchanged afterward. Its installed APK hash was
  `c0e738a443d77cd2f13d4eb6dbff846d7b4b0f79daffb6b23eab4425508dde19`,
  SELinux Enforcing, 4096-byte pages, slot A. This is virtual x86_64 evidence,
  not an ARM64 Pixel boot or a signed production release.
- The grizzly build preflight failed: the default `/home/shaw/aosp-grizzly`
  checkout is absent; checking the existing AOSP root also rejected this host
  (24 physical cores / 30 GiB RAM versus the lane requirement of 32 / 128).
  No grizzly image build or reproducibility comparison was completed.
- ADB/fastboot inventories contained no physical phone. No physical device was
  flashed, wiped, rebooted or relocked. Original failure logs remain unavailable.

Machine output and local device evidence are retained outside Git; this document
summarizes their scope and is not a signed qualification receipt.

## Remaining gates, in order

1. Identify each affected phone by actual product, SKU, storage and boot state.
   Collect existing installer logs and read-only incident evidence. Establish
   whether Android, recovery, bootloader or no USB transport remains available.
2. Establish a device-specific, currently bootable stock recovery path and both
   slots' firmware/rollback state. The pinned A9 archive is a build input, not
   blanket downgrade authorization. Do not relock a test-key/custom image.
3. Complete an exact-source grizzly build with the generated vendor/kernel
   baseline, VINTF/init/SELinux and AVB checks; inspect actual partition metadata.
   Remove diagnostic overrides and compare a second isolated build's artifacts.
4. On an explicitly qualified lab transition, retain boot/reboot, encryption,
   keystore, radio, Wi-Fi, camera, graphics, audio, local inference and voice
   evidence. Validate recovery, OTA/rollback constraints and interruption cases
   using the [hardware matrix](hardware-validation.md). Investigate the original
   failures before promoting the same installation path.
5. Independently sign the exact evidence-bound release, enroll production trust,
   verify revocations, and qualify each SKU/storage/firmware/slot combination.
   A changed artifact or firmware combination requires new qualification.

Until those gates pass, the correct installer result is refusal. No host test
suite can establish a zero-brick guarantee for untested hardware transitions.

## Additional qualification before connecting a phone

The next host-side review added an exclusive per-serial installer interlock.
It spans device inspection, staging, writes and requested boot verification.
A failed write or killed process leaves the lock in place for investigation;
there is no automatic retry of a partially applied plan. See the
[interlock operating rules](../../../../scripts/android/README.md#concurrent-or-interrupted-installation).
This protects concurrent invocations by the same host account, not independent
raw fastboot processes or another host/account.

The read-only incident collector now preserves subprocess stderr for model
identification. Fastboot normally reports its getvars there; previously the
collector saved that output but did not return it to the identity check.
Tests exercise an actual subprocess writing stderr, while unknown products
and failed probes still cannot authorize device-specific diagnostics.

Verified before physical connection:

| Boundary | Result and limit |
| --- | --- |
| Concurrent installation | Separate processes targeting one serial are rejected; different serials remain independent. |
| Interrupted installer | SIGKILL leaves an interlock; write errors block immediate retries; normal completion and pre-write failures release the lock. |
| Flash command failure | Injected a failure at every command in the generated plan; no later command ran and no success receipt was produced. This is simulated I/O, not USB/power-loss qualification. |
| Artifact integrity | Every signed file was independently corrupted and removed; verification rejected each case. |
| Public entrypoints | Node and shell entrypoints rejected fixture authorization before invoking any ADB/fastboot tool. |
| Repository verification | Frozen dependency install and full verification passed: 230 Node release tests, 114 Bun contract tests / 1134 assertions, workspace checks and native compilation. |
| Shell compatibility | All 19 shell installer mock checks passed. |
| Running Cuttlefish | Repeated complete post-boot verification passed against the previously recorded APK/image, including authenticated health, expected slot, SELinux, page size and app roles. |

**Ready for read-only phone intake, not physical installation.** Nothing in this
review establishes a bootable grizzly image or qualifies a firmware transition.
The builder, exact image, physical recovery and hardware gates above remain open.

For the post-PR #126 gate-by-gate assessment, evidence requirements and current
host findings, see [boot and recovery qualification](boot-recovery-qualification.md).
