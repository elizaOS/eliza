# Android physical validation gate

Repository-side checks cannot promote a physical device. A release becomes
installable only after the exact source lock, licensed input, signed artifacts,
device identity, and retained runtime evidence all agree.

## Pixel 9a candidate

The public-source candidate is `tegu` on `android-15.0.0_r31`, build
`BD4A.250505.003`. Verify the manually license-accepted vendor archive before
building:

```bash
node scripts/aosp/verify-source-lock.mjs \
  --profile pixel9a \
  --aosp-root "$AOSP_ROOT" \
  --vendor-archive "$ELIZA_PIXEL_VENDOR_ARCHIVE" \
  --verify-vendor-tree --json
```

Build and deploy through `scripts/aosp/deploy-pixel.mjs`. The deploy command
re-applies the assistant role and IME after install, requires the full-engine
IME ASR result, and retains inspectable adb evidence in
`out/android-evidence/` (or `$ELIZA_ANDROID_EVIDENCE_DIR`).

The arm64 release path currently uses `android-arm64-cpu-fused`. The Vulkan
variant is excluded because it did not pass the Android/bionic native-loader
boundary; it must not replace the CPU artifact until a device run proves load,
model initialization, inference, and the failure path on the exact APK.

The candidate is not currently promotable: the pinned application catalog's
active Gemma ASR release has no published GGUF asset (`missing-from-hf-repo`).
Retired pre-Gemma artifacts may be used only for compatibility diagnosis; they
must not satisfy release evidence. The voice lane fails when ASR is skipped,
so publishing and digest-pinning the active artifact is an explicit external
prerequisite rather than a silent fallback.

The Cuttlefish workflow is fail-closed on the same boundary. Its no-mock voice
self-test must pass WAV → local ASR → local agent → local TTS, and its assistant
surface verifier runs with `--require-engine`. Consequently, a selected IME or
a successful deep-link alone cannot satisfy the full-engine gate while the
Gemma artifact is unavailable.

## Pixel 11 Pro generated candidate

`grizzly` is pinned in `pixel11pro.lock.json` to Android 17 r1, stock build
`CD1A.260714.001.A9`, exact `adevtool` and `vendor_state` commits, and the stock
kernel extraction path. Earlier lab notes reported an A9 phone after a stock
update; that historical observation is not the current phone's identity or
downgrade authorization. Recollect its product, firmware and slot state before
choosing a recovery image. Do not downgrade the earlier phone to C2 after its
A9 bootloader has run. Archive verification alone does not authorize flashing.

Generate and verify the device layer before building:

```bash
node scripts/distro-android/prepare-grizzly.mjs \
  --aosp-root "$AOSP_ROOT" \
  --lock android/pixel11pro.lock.json
```

This is generated device support, not a complete qualification of the device
tree. Newer community kernels and September sources are reviewed in the
[upstream audit](pixel11-upstream-audit-2026-09-23.md); they do not change this
candidate's pinned stock-kernel baseline. Promotion additionally
requires an exact-build compile, bootloader/slot capture, stock rollback drill,
and every physical validation item below.

The reproducible operator handoff is produced with `make bundle-grizzly` as
documented in the package README. Before flashing, independently verify
`SHA256SUMS`, its offline release signature, and the adjacent resolved AOSP
source manifest. Use only the signed v2 executor after a separately reviewed lab authorization.
It validates the bundled `fastboot-info.txt` and executes qualified fastbootd
dynamic-super transitions. Do not run bundled flashall scripts directly or
flash a standalone system partition. See the
[boot/recovery qualification review](boot-recovery-qualification.md).

Verify the pinned source identities with
`node scripts/aosp/verify-source-lock.mjs --profile pixel11pro --aosp-root "$AOSP_ROOT"`.

The G-logo boot-hang investigation, ranked hypotheses, reboot decision tree,
and attestation/evidence contract live in
[grizzly-bringup-runbook.md](grizzly-bringup-runbook.md).

### Bring-up diagnostics are opt-in and stamped

The default grizzly image is stock apart from the required build fixes. Every
diagnostic deviation is env-gated at prepare time, recorded in
`vendor/google_devices/grizzly/.elizaos-prepare-stamp.json`, and re-checked by
`build-aosp.mjs`, which fails closed if the tree was prepared under different
settings than the build environment:

- `ELIZAOS_GRIZZLY_RENDERENGINE_BACKEND=skiagl|skiaglthreaded|skiavk|skiavkthreaded`
  forces a RenderEngine backend and switches Graphite off. Set
  `ELIZAOS_GRIZZLY_RENDERENGINE_GRAPHITE=1` only for an explicit
  Graphite-on-Vulkan probe; it is rejected with a GL backend.
- `ELIZAOS_GRIZZLY_EGL=native` drops the stock ANGLE selection and derives the
  vendor PowerVR EGL name from the extracted payload. Unset (or `angle`) keeps
  the stock selection.
- `ELIZAOS_GRIZZLY_EARLY_BOOT_PROBES=1` enables init phase markers, pstore
  `/dev/kmsg` breadcrumbs, and non-blocking module/storage waits. The probe
  init file is installed through an explicit `PRODUCT_COPY_FILES` rule.
- `ELIZAOS_GRIZZLY_CONSERVATIVE_F2FS=1` applies the diagnostic userdata fstab
  rewrite. It strips the factory encryption contract from `/data` and is not
  eligible for public release. Any lab transition changing this stance must
  have its wipe requirement, recovery path and starting state independently
  qualified in the signed v2 contract; never issue an ad hoc `fastboot -w`.

A generated tree carrying gated edits whose flag is now unset is deleted and
regenerated, so a default build cannot inherit an earlier diagnostic image.

## Promotion matrix

Before requesting independently signed v2 qualification, retain all of:

- clean source checkout identities and signed artifact SHA-256 values;
- boot, display, touch, Wi-Fi, Bluetooth, cellular/SIM, audio/mic, camera,
  sensors, suspend/resume, charging, and physical-button results;
- Pixel long-press-power routing to the Eliza `ROLE_ASSISTANT` holder;
- full-engine voice IME mic → local ASR → committed-text evidence;
- HOME/assistant launch, local health/chat/inference, logcat, and SELinux denial
  review, including a deliberate failure canary;
- verified boot, recovery, OTA, both-slot boot, and rollback results.

The signed physical check set also requires these explicit results:

| Check | Evidence required |
| --- | --- |
| `encrypted-recovery` | Preserved encryption and successful credential unlock after the qualified recovery round trip, on the exact firmware and credential configuration. Recovery need not expose private files. If backup/restore is offered, verify restored data after authenticated unlock; raw encrypted copies are not proof. Preserve the factory encryption contract. |
| `recovery-after-ota-slot` | Retain slot identity before OTA, after switching slots and after restarting recovery. Prove subsequent operations target the intended slot, including stale/missing slot-probe rejection. The current installer does not implement OTA or recovery sideload. |
| `kernel-vendor-module-pair` | Bind kernel, boot/vendor-kernel images, module load lists, vendor drivers, firmware and security patch level to one tested build. Reject mixed artifacts and verify module loading and camera/radio operation on hardware. |

Also retain clean-install and update results separately for Wi-Fi, mobile data,
camera and optional packages. A recovery logo, successful patcher exit or
network-connected icon does not satisfy these checks. Preparation must complete
artifact hashes and staging-space checks before writes. Factory archive hashing
is streamed; no memory-exhaustion fallback may skip verification.

A legacy `lab-validated` label cannot authorize installation. The installer
requires signed v2 qualification, reviewed target eligibility, current trust
and revocations, exact artifacts/tools, and a qualified firmware/slot/recovery
starting state. See [supported devices](../installer/docs/supported-devices.md).

## Light Phone III

`TLP301` remains blocked in `hardware-targets.json`. It must not receive a
product or installer alias until the vendor or an authorized maintainer
provides the missing unlock, device-tree, kernel, proprietary-input, and
recovery boundaries and the exact retail device passes this matrix.
