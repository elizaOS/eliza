# Pixel 11 Pro (grizzly) bring-up runbook

Updated 2026-09-04. The earlier static-G-logo/no-adb failure is historical,
not a live observation of the connected phone. Kiosk mode in a running app is
a separate provisioning problem and does not establish an OS boot failure.
Capture current identity and transport state before choosing an experiment.

Read the [dated upstream audit](pixel11-upstream-audit-2026-09-04.md) first.
It supersedes the August 26 claims that no public kernel work exists, that
Google's GSI excludes Pixel 11, and that a failed GSI would prove an
unfixable platform gap. Neither a social announcement nor a successful image
build establishes that our bundle boots.

## Boundaries and tooling

- `scripts/distro-android/grizzly-evidence.mjs --device SERIAL`: read-only
  capture, with exact serial selection across ADB and fastboot. Multiple
  devices require an explicit selection. Unauthorized/offline/sideload ADB
  transports are not shell access.
- `scripts/aosp/build-grizzly-bundle.mjs`: source-locked build, required
  gates, privileged APK provenance, artifact verification and handoff receipts.
  See [build-lane handoff](grizzly-build-handoff.md).
- `scripts/distro-android/verify-grizzly-artifacts.mjs`: attestation and
  flash-host checksum checks. Verify exact bytes before each experiment.
- `scripts/distro-android/prepare-grizzly.mjs`: renderer, EGL, init probes,
  nonblocking keymaster and conservative-fstab experiments are opt-in and
  stamp-bound. Change one at a time; none is proof of a production fix.

No automatic firmware upgrade, OEM MTE toggle, reboot, wipe, flash, bootloader
relock or installer promotion is part of the evidence collector. Retain raw
logs outside Git; they may contain device identifiers and private app data.

## Known candidate contract

The lock remains AOSP `android-17.0.0_r1` plus A9 factory vendor/firmware and
the stock kernel. The September 4 update pins audited adevtool commit
`144f004cc484d7e7234cdd167cee48e5f240288f`, including its corrected partition
extraction. It does **not** migrate to QPR2 Beta 4.

Generated `BoardConfig.mk` must match the pinned upstream size/SHA-256 and
declare a 10 GiB super device, 10733223936-byte dynamic group, and the six
expected logical partitions. An old generated tree must fail validation and
be regenerated. On Linux, inspect both stock and produced `super_empty.img`
with `lpdump --json`; inspect effective build variables too. A source hash
does not prove the final LP metadata. Test OTA only after a corrected clean
installation: upstream reports that stale installed LP metadata can prevent
updates even though first boot succeeds.

The real host-init gate is the product output
`host_init_verifier_output.txt` target. The nonexistent
`host_init_verifier_check` alias is not an alternative.

## Experiment sequence

### 0. Establish current state without rebooting

Record serial, product codename, running build fingerprint, firmware versions,
slot, unlock state and the exact candidate/rollback hashes. Select the phone
explicitly when other Android devices or emulators are attached.

Run the evidence collector. It records inventory, available OEM diagnostics,
properties, kernel command line/bootconfig, CPU features, actual page size,
super size/LP layout, APEX inventory, binder services, logcat, dmesg and pstore.
Some probes need privileges or are absent on stock/recovery: retain their
failures rather than converting them into empty-success results.

A forced reset may lose the evidence being sought. OEM `last_dmesg` and
pstore availability/retention are firmware-dependent. Missing markers cannot
locate a boot failure until marker delivery and log retention are demonstrated
on a known-good boot.

### 1. Establish a stock control

Boot a verified, device-correct stock installation and record the same
evidence. Keep A9 as its own test matrix. If choosing QPR2 Beta 4, use the
complete grizzly C2 factory package and verify its downloaded hash, requirements
and rollback constraints before changing firmware. An archived A9 ZIP alone
is not proof downgrading remains possible after a beta firmware update.

### 2. Establish the new Google GSI control

Google now lists Pixel 11 devices for QPR2 Beta 4 GSI validation. Test the
published ARM64 B1 GSI against the corresponding grizzly C2 firmware release
train; the suffixes legitimately differ. Record both exact identities.

Prefer DSU if offered and usable on the selected stock build, following
[Google's DSU instructions](https://developer.android.com/topic/dsu).
DSU is not a guaranteed menu option, zero-risk operation or zero-reboot test.
If unavailable, prepare a separate reviewed GSI installation plan; do not
improvise a single-partition flash on the custom bundle.

- GSI boots: useful generic userspace/vendor compatibility control. Compare
  init, VINTF/SELinux, APEX and secure-storage behavior with our candidate.
  This does not validate our custom kernel, app, images or hardware matrix.
- GSI fails: retain its own errors and confirm firmware, installation method,
  slot and image compatibility. A failure does not prove AOSP is unfixable,
  nor that the same component caused the earlier custom-image failure.

### 3. Build and test one attributable custom candidate

Regenerate vendor output using the updated pin; run droidcore, dist,
host-init, VINTF, artifact/AVB and APK-provenance gates. Verify the final
partition metadata and flash plan. Keep firmware, vendor and kernel inputs
coherent. Do not disable gates, fake validation metadata or relock a
userdebug image signed with a public test key.

After an explicitly approved device test, capture boot progress and logs.
Prioritize the first demonstrated failing boundary:

- Early kernel failure: inspect the actual kernel trace/config/toolchain.
  GrapheneOS's new BTI/AutoFDO fix concerns its custom kernel, not our pinned
  stock kernel.
- Init/secure-storage stall: correlate init phase markers, KeyMint/keystore,
  vold, APEX activation and policy denials. The nonblocking keymaster switch
  is diagnostic only; reaching the launcher after bypassing a wait does not
  prove secure storage works.
- Policy mismatch: the current 202604-to-202704 vendor sepolicy declaration
  rewrite remains provisional. Establish the real mapping and VINTF contract
  before replacing it; do not infer compatibility from a changed number.
- Graphics crash: use tombstones and graphics probes after earlier boot
  phases are proven. A black/splash screen alone does not identify a renderer.
- Storage-state mismatch: compare stock fstab and encryption state. Wiping
  data/metadata is a destructive experiment, not a universal fix.

Do not mix stock and custom system/product/system_ext partitions without
checking their APEX, VINTF and AVB contracts. A mixed-image failure can create
a new incompatibility rather than isolate the original one.

## After first boot

Rebuild with probes and diagnostic bypasses disabled, then repeat cold boots
and the [hardware validation matrix](hardware-validation.md). Validate
launcher/HOME ownership, local text inference, ASR/TTS, graphics, radios,
sensors, camera, suspend, encryption and secure keystore behavior. Complete
corrected-layout OTA, recovery and rollback tests.

Keep candidate/install eligibility unchanged until exact-digest evidence
supports promotion. Treat MTE functional/performance qualification as a
separate security workstream; advertised CPU features alone are insufficient.
