# Android distro layer

This directory contains the brand vendor tree for building a privileged-system-app
Android distribution (Cuttlefish for CI validation, Pixel codenames for real
devices). The toolchain is brand-aware: any downstream brand can build its own
distribution by supplying a JSON brand config + vendor tree.

## Layout

```
packages/os/android/
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
configs live at `packages/scripts/distro-android/brand.eliza*.json` — one per
arch (`brand.eliza.json` = x86_64, `brand.eliza-arm64.json`,
`brand.eliza-riscv64.json`), all pointing at this package's
`vendor/eliza/` overlay and the matching `eliza_cf_<arch>_phone` product.

## Emulator + build entry point

`Makefile` here is the front door for the AOSP fork, parallel to
`packages/os/linux/elizaos/Makefile` for the Debian fork. `ARCH` selects
the brand config + Cuttlefish device dir; the eliza overlay (launcher,
splash, permissions) is arch-agnostic and shared across all three:

```bash
make build ARCH=x86_64            # build + launch + boot-validate a Cuttlefish image
make build ARCH=arm64
make build ARCH=riscv64
make sim   ARCH=riscv64           # bring up + validate an already-built image
make bootanimation                # render + pack the elizaOS boot splash (needs ImageMagick)
```

Each target drives the brand-aware orchestrator in
`packages/scripts/distro-android/` (`build-aosp.mjs`, `sim.mjs`,
`build-bootanimation.mjs`), which is the stack CI uses
(`.github/workflows/elizaos-cuttlefish.yml`). Real builds need a Linux
x86_64 host with KVM and a synced AOSP checkout (`AOSP_ROOT`, default
`$HOME/aosp`); riscv64 Cuttlefish runs under QEMU TCG (no KVM) and boots
slower — `sim.mjs` sizes its boot timeout for that automatically.

`make build` syncs `vendor/eliza`, validates the product layer against the
AOSP source, runs `lunch eliza_cf_<arch>_phone-trunk_staging-userdebug && m`,
launches Cuttlefish, and then runs the boot validator. The underlying
command is `node packages/scripts/distro-android/build-aosp.mjs
--brand-config <arch-config> --aosp-root <root> --launch --boot-validate`.

> Note on orchestration: a second, divergent AOSP build/emulator stack
> exists at `packages/app-core/scripts/aosp/` (wired into app-core's vitest
> + agent-payload staging). It currently ships only the x86_64 `milady`
> variant, so the eliza arm64/riscv64 images come from the
> `distro-android` stack that this Makefile drives. The two stacks share an
> identical-purpose core of ~11 files that have drifted; collapsing them to
> one canonical core is tracked as follow-up cleanup.

## Boot experience: splash + launcher

Every eliza image boots straight into the elizaOS launcher with the
elizaOS boot splash:

- **Launcher** — `eliza_common.mk` strips the stock launchers and the Eliza
  APK `overrides: ["Launcher3", "Launcher3QuickStep", "Trebuchet", …]`, so
  Eliza (`ai.elizaos.app`) is the only HOME app. The overlay sets
  `config_defaultHome` (alongside dialer/sms/assistant/browser) and
  `ro.elizaos.home`, and SetupWizard is disabled — no Google "Welcome" flow.
- **Splash** — `scripts/generate-eliza-bootanimation.sh` renders the white
  elizaOS logo on the elizaOS blue field into `vendor/eliza/bootanimation/`
  from the canonical brand SVG (the same way the Linux fork renders its
  branding), and `build-bootanimation.mjs` packs it into
  `bootanimation.zip`. The rendered frames + zip are gitignored; run
  `make bootanimation` (on a host with ImageMagick) before `make build` to
  bake the splash in. If the zip is absent, `eliza_common.mk` guards the
  copy and the image falls through to the stock AOSP animation.

## AOSP assistant/full-control contract

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
script in `packages/scripts/distro-android/` with `--brand-config <path>`:

```bash
node packages/scripts/distro-android/build-aosp.mjs \
  --brand-config /path/to/your-brand.json \
  --source-vendor /path/to/your-vendor-tree \
  --aosp-root /path/to/aosp \
  --launch --boot-validate
```

See `packages/scripts/distro-android/README.md` for the brand config schema and the
GitHub Actions workflow `.github/workflows/elizaos-cuttlefish.yml` for a
reusable workflow that downstream brands can call.
