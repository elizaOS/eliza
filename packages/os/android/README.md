# Android distro layer

This directory contains the brand vendor tree for building a privileged-system-app
Android distribution (Cuttlefish for CI validation and the canonical emulated
OS boundary). The toolchain is brand-aware: any downstream brand can build its own
distribution by supplying a JSON brand config + vendor tree.

## Layout

```
android/
└── vendor/
    └── <brand>/                # Vendor tree for brand <brand>
        ├── AndroidProducts.mk
        ├── <brand>_common.mk
        ├── apps/<AppName>/Android.bp
        ├── bootanimation/{desc.txt,README.md}
        ├── init/init.<brand>.rc
        ├── overlays/frameworks/base/core/res/res/values/config.xml
        ├── permissions/{Android.bp,default-permissions-<pkg>.xml,privapp-permissions-<pkg>.xml}
        ├── products/<brand>_*_phone.mk
        └── sepolicy/{file_contexts,<brand>_agent.te,README.md}
```

The default brand shipped here is **eliza** (`vendor/eliza/`). The brand
configs live at `scripts/distro-android/brand.eliza*.json`: the three
Cuttlefish architectures (`brand.eliza.json` = x86_64,
`brand.eliza-arm64.json`, `brand.eliza-riscv64.json`) plus the pinned Pixel 9a
and generated Pixel 11 Pro hardware targets (`brand.eliza-tegu.json`,
`brand.eliza-grizzly.json`). All point at this package's
`vendor/eliza/` overlay and a matching product makefile.

## Emulator + build entry point

`Makefile` here is the front door for the AOSP fork, parallel to
`linux/Justfile` for the canonical Debian fork. `ARCH` selects
the brand config + Cuttlefish device dir; the eliza overlay (launcher,
splash, permissions) is arch-agnostic and shared across all three:

```bash
make build ARCH=x86_64            # build + launch + boot-validate a Cuttlefish image
make build ARCH=arm64
make build ARCH=riscv64
make sim   ARCH=riscv64           # bring up + validate an already-built image
make bootstrap                    # sync the pinned complete AOSP checkout
make bootanimation                # render + pack the elizaOS boot splash (needs ImageMagick)
```

Each target drives the brand-aware orchestrator in
`scripts/distro-android/` (`build-aosp.mjs`, `sim.mjs`,
`build-bootanimation.mjs`), which is the stack CI uses
(`.github/workflows/elizaos-cuttlefish.yml`). Real builds need a Linux
x86_64 host with KVM and a synced AOSP checkout (`AOSP_ROOT`, default
`$HOME/aosp`); riscv64 Cuttlefish runs under QEMU TCG (no KVM) and boots
slower — `sim.mjs` sizes its boot timeout for that automatically.

The complete platform checkout is reproducible from this repository: `make
bootstrap AOSP_ROOT=/path/to/aosp` initializes and syncs the manifest locked in
`aosp.lock.json`. The lock records both the Android 17 release tag object and
its peeled manifest commit; bootstrap verifies the exact commit before syncing
and copies the lock into the checkout. The Make target first downloads the AOSP
`repo` launcher into the ignored local cache and verifies its checked-in SHA-256;
the Cuttlefish workflow performs the same provisioning on a clean runner.
Release builds must not use an arbitrary `android-latest-release` workspace.

`make build` rebuilds the privileged APK from the Eliza checkout, syncs
`vendor/eliza`, validates the product layer against the AOSP source, runs
`lunch eliza_cf_<arch>_phone-trunk_staging-userdebug && m`,
launches Cuttlefish, and then runs the boot validator. The underlying
command is `node scripts/distro-android/build-aosp.mjs
--brand-config <arch-config> --aosp-root <root> --rebuild-privileged-apk
--launch --boot-validate`.

x86_64 and arm64 builds intentionally omit the unavailable RISC-V Bun slice.
The riscv64 target remains fail-closed and requires a locally built or hosted
`bun-linux-riscv64-musl.zip` plus its SHA-256 through the Eliza build
environment. The reusable workflow exposes `bun-riscv64-url` and
`bun-riscv64-sha256` for that lane.

The canonical Cuttlefish products depend only on this release repository and
the checkout pinned by `aosp.lock.json`. E1 simulator development uses a
separate `eliza_cf_riscv64_e1_phone` product. Its device/HAL sources are
imported from `elizaOS/research` at the commit recorded in
`cuttlefish-e1.lock.json`; the importer verifies the commit, required source
paths, and the upstream Android license declarations before copying them into
the AOSP checkout. The canonical launcher products never inherit this overlay.

To provision and build the simulator target on a Linux x86_64 host:

```bash
make -C android provision-e1 AOSP_ROOT=/build/aosp
make -C android build-e1 AOSP_ROOT=/build/aosp \
  ELIZAOS_ELIZA_ROOT=/build/eliza
```

The E1 target currently supports `riscv64` Cuttlefish only. A successful local
import is not boot evidence; retain the Cuttlefish build, `checkvintf`, and
boot-validation outputs for release qualification.

Before assembling the APK, the Make and workflow front doors build the
mandatory arm64 fused inference library plus the selected Cuttlefish ABI.
That compiler path requires the pinned Zig 0.13 toolchain; the workflow
provisions and checksum-verifies it, while local builders must put Zig 0.13 on
`PATH`.

`build:android:system` deliberately emits an unsigned vendor input. Soong
signs that input with the product platform certificate and writes the
installable result to
`$OUT_DIR/target/product/<product>/system/priv-app/Eliza/Eliza.apk` (with
`$OUT_DIR` defaulting to `<aosp-root>/out`). The raw
`vendor/eliza/.../Eliza.apk` cannot be installed directly. A stock Pixel also
will not accept an elizaOS platform-signed privileged package as a substitute
for flashing the matching OS image.

### Pixel 9a (`tegu`) source and license boundary

The physical-device product is `eliza_tegu_phone`, configured by
`scripts/distro-android/brand.eliza-tegu.json`. Its source contract is
`pixel9a.lock.json`: Android `android-15.0.0_r31`, build
`BD4A.250505.003`, the exact public Pixel device/kernel project commits, and
Google's matching separately licensed vendor archive. Bootstrap this target
with its own lock rather than the default Cuttlefish lock:

```bash
node scripts/distro-android/bootstrap-aosp.mjs \
  --lock android/pixel9a.lock.json \
  --aosp-root /path/to/aosp-tegu \
  --repo-bin android/cache/repo
```

Download the archive from the URL recorded in `pixel9a.lock.json`. It is a
self-extracting agreement: a human authorized to accept Google's terms must run
the enclosed `extract-google_devices-tegu.sh` interactively from the AOSP root.
The repository never types `I ACCEPT`, bypasses, or persists acceptance on the
operator's behalf. Preserve the downloaded `.tgz`; the build verifies its exact
filename, byte length, and SHA-256 through `ELIZA_PIXEL_VENDOR_ARCHIVE`, then
fails closed unless the locked vendor files are present:

```bash
ELIZAOS_ELIZA_ROOT=/path/to/eliza \
ELIZA_PIXEL_VENDOR_ARCHIVE=/path/to/google_devices-tegu-bd4a.250505.003-9ab41e05.tgz \
node scripts/distro-android/build-aosp.mjs \
  --brand-config scripts/distro-android/brand.eliza-tegu.json \
  --aosp-root /path/to/aosp-tegu \
  --rebuild-privileged-apk
```

That command builds only on Linux x86_64. It does not make the target eligible
for end-user installation: `hardware-targets.json` keeps Pixel 9a fail-closed
until a retained build, explicit-confirmation flash, post-boot validation, and
rollback evidence bundle passes on real hardware. Use the release-manifest
installer for flashing; do not sideload the product APK onto stock Android.
See the AOSP [source download requirements](https://source.android.com/docs/setup/download#obtaining-proprietary-binaries)
and Google's [Pixel driver binaries](https://developers.google.com/android/drivers).

### Pixel 11 Pro (`grizzly`) generated device support

This repository does not yet have a verified, source-built Pixel 11 device
kernel integration. `pixel11pro.lock.json` pins a generated-device path:
Android 17 r1, GrapheneOS `adevtool`, GrapheneOS `vendor_state`, and Google's
A9 factory image for generation and the declared rollback archive. The
first bring-up deliberately uses the stock `spacecraft` kernel, modules, DTB,
and DTBO extracted by `adevtool`. Reconfirm the phone's actual firmware and
rollback constraints before flashing. See the
[September 4 upstream audit](docs/pixel11-upstream-audit-2026-09-04.md) for new
GrapheneOS kernel work, QPR2 Beta 4 controls and the corrected super-partition
contract; these developments do not establish a booted elizaOS image.

Use the dedicated Linux x86_64 builder specified in
[`docs/grizzly-build-handoff.md`](docs/grizzly-build-handoff.md); the production
lane requires at least 32 physical cores, 128 GiB RAM, 1.5 TB fast local
storage, and 600 GiB free at bundle start:

```bash
make -C android bootstrap-grizzly \
  AOSP_GRIZZLY_ROOT=/build/aosp-grizzly
make -C android preflight-grizzly \
  AOSP_GRIZZLY_ROOT=/build/aosp-grizzly
make -C android prepare-grizzly \
  AOSP_GRIZZLY_ROOT=/build/aosp-grizzly
make -C android build-grizzly \
  AOSP_GRIZZLY_ROOT=/build/aosp-grizzly \
  ELIZAOS_ELIZA_ROOT=/build/eliza
SOURCE_DATE_EPOCH="$(git show -s --format=%ct HEAD)" \
make -C android bundle-grizzly \
  AOSP_GRIZZLY_ROOT=/build/aosp-grizzly \
  ELIZAOS_ELIZA_ROOT=/build/eliza \
  BUNDLE_DIR=/build/elizaos-grizzly-bundle
```

Preparation uses sparse exact-commit Git checkouts for the generation inputs,
runs `adevtool generate-all -d grizzly`, verifies the required output, and
retains and verifies both factory images. Downloads are governed by Google's
Pixel factory-image terms, which `adevtool` displays before download. The
bundle target completes explicit `droidcore`, `dist`,
host init verifier, and `check-vintf-all` gates, retains their command
and product-output receipts, and verifies every referenced vbmeta image with
the built `avbtool` against a lock-authorized key.
It validates the generated dynamic-super flash plan, binds the privileged APK
and its embedded runtime provenance to the Eliza commit and checked-out AOSP
platform certificate, and compares pre/post AOSP-project and vendor source
snapshots without executing the mutable `repo` implementation. The collector
requires an authoritative resolved-project manifest digest in the source lock
and rejects local manifests; it fails closed while that reviewed artifact is
absent. It rejects any
unstable or missing input, publishes only a complete recursively synced bundle
from private staging without replacing an existing path, and emits exact
source identities, retained gate receipts, builder facts, SHA-256 values, and
sizes.
`SOURCE_DATE_EPOCH` is mandatory so the handoff metadata is reproducible. Sign
`SHA256SUMS` only with the separately provisioned offline release key; this
command never generates or accepts private signing material. The generated
`fastboot-info.txt` is the flashing authority: do not replace it with a direct
`fastboot flash system` operation on the dynamic-super device.

The result remains installer-ineligible until the exact image completes the
full physical validation and rollback matrix.

`scripts/aosp/` contains device deployment and Cuttlefish runtime smoke
orchestration. App compilation and agent-payload staging remain in the
external `eliza` application repository; OS scripts locate that checkout via
`ELIZAOS_ELIZA_ROOT` or `.eliza-source`.

## Boot experience: splash + launcher

Every eliza image boots straight into the elizaOS launcher with the
elizaOS boot splash:

- **Launcher** — `eliza_common.mk` strips the stock launchers and the Eliza
  APK `overrides: ["Launcher3", "Launcher3QuickStep", "Trebuchet", …]`, so
  Eliza (`ai.elizaos.app`) is the only HOME app. The overlay sets
  `config_defaultHome` (alongside dialer/sms/assistant/browser) and
  `ro.elizaos.home`, and SetupWizard is disabled — no Google "Welcome" flow.
- **Splash** — `scripts/generate-eliza-bootanimation.mjs` renders the white
  elizaOS logo on the elizaOS blue field (#0B35F1) into
  `vendor/eliza/bootanimation/` from the canonical brand SVG using `sharp`
  (the repo's image toolchain — no external ImageMagick needed), and
  `build-bootanimation.mjs` packs it into the uncompressed `bootanimation.zip`
  AOSP's bootanimation daemon requires. The rendered frames + zip are
  gitignored; run `make bootanimation` before `make build` to bake the
  splash in. If the zip is absent, `eliza_common.mk` guards the copy and
  the image falls through to the stock AOSP animation.

The image currently retains AOSP's real SystemUI implementation for status,
navigation, and keyguard. Eliza owns HOME and the assistant/control surface; it
does not claim to replace `frameworks/base/packages/SystemUI`. An earlier
standalone React/native bridge scaffold was removed because no AOSP host copied
or bound it, while `eliza_common.mk` still named its undefined Soong module.
Any future SystemUI replacement must land as a build-resolvable, platform-signed
module with a real surface host, keyguard integration, SELinux policy, and boot
evidence—not as an unreferenced workspace package.

The Cuttlefish CPU kernel parity gate now emits its own evidence report through
`scripts/aosp/kernel-parity-evidence.mjs`. It requires the native source commit in
`release/eliza-source.lock.json`, refuses tracked kernel changes and
source drift during the run, and hashes the source inputs, host/guest verifier
binaries, fixtures, compiler/NDK metadata and captured guest properties. The guest
binary must match the compiled verifier both before and after its self-test.
Use fresh `ELIZA_CUTTLEFISH_OUT_DIR` and `ELIZA_CUTTLEFISH_EVIDENCE_OUT` paths for
each run; existing evidence is refused rather than reused. Retain the output
directory with the JSON report; the default output is under `reports/cuttlefish/`
so the workflow retains the verifier binaries and raw proof files too. This proves Cuttlefish CPU kernel-reference parity,
not full-engine ASR, assistant/IME routing, physical-device support or hardware
Vulkan readiness.

## AOSP assistant/full-control contract

The product removes Android's stock provisioning applications. Its SettingsProvider
overlay therefore seeds `device_provisioned` and `user_setup_complete` to `1` for
fresh settings databases; otherwise Android suppresses assist-key routing even
when the assistant role and service are correct. Boot validation requires both
settings. These defaults leave existing userdata unchanged and do not complete
Eliza's application-level account/provider onboarding. Qualify this image change
with fresh disposable userdata, not shell-written settings on an older image.

The AOSP image makes `ai.elizaos.app` the device assistant, not just another
app that can answer an intent. The product overlay sets
`config_defaultAssistant`, the APK declares `ElizaAssistActivity` for both
`android.intent.action.ASSIST` and `android.intent.action.VOICE_COMMAND`, and
the boot validator checks the role holder plus both activity resolutions.

The machine-readable contract lives at
`vendor/eliza/manifests/aosp-assistant-full-control.json` and is copied into
the image at `/product/etc/eliza/aosp-assistant-full-control.json`. It records
the full AOSP-only control surface:

- `RoleManager.ROLE_ASSISTANT`, `Intent.ACTION_ASSIST`, and
  `Intent.ACTION_VOICE_COMMAND` ownership and their concrete platform values.
- Concrete AOSP-only `ElizaAccessibilityService` and
  `ElizaNotificationListenerService` declarations. The Play/cloud build strips
  the services, Java sources, and accessibility-service XML resource.
- Usage stats through `PACKAGE_USAGE_STATS` plus the boot-time
  `GET_USAGE_STATS` appop grant path.
- MediaProjection/foreground-service screen capture for user-consented paths
  and privileged `READ_FRAME_BUFFER` capture for system images.
- Input control through accessibility gestures on user-consented paths and
  `INJECT_EVENTS` on privileged system images.
- Direct-boot receiver coverage for `LOCKED_BOOT_COMPLETED`,
  `BOOT_COMPLETED`, and package replacement.
- Foreground service declarations for the local agent runtime, gateway sync,
  background voice capture, and screen capture.
- System-image requirements: `/system/priv-app/Eliza/Eliza.apk`, platform
  certificate, `privileged: true`, default-permissions XML, and privapp XML.

Google Play builds must use `android-cloud`. Static checks assert that the
cloud build strips assistant/default-role components, boot/direct-boot
receivers, `RECEIVE_BOOT_COMPLETED`, background microphone foreground service,
MediaProjection service permission, privileged permissions, and native
system-control plugins.

## Whitelabel — building a downstream brand

Provide a brand config and a corresponding vendor tree, then drive every
script in `scripts/distro-android/` with `--brand-config <path>`:

```bash
node scripts/distro-android/build-aosp.mjs \
  --brand-config /path/to/your-brand.json \
  --source-vendor /path/to/your-vendor-tree \
  --aosp-root /path/to/aosp \
  --launch --boot-validate
```

See `scripts/distro-android/README.md` for the brand config schema and the
GitHub Actions workflow `.github/workflows/elizaos-cuttlefish.yml` for a
reusable workflow that downstream brands can call.
