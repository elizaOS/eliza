# scripts/distro-android — Brand-aware AOSP/Cuttlefish toolchain

This directory contains the toolchain for building a brand-customised
Android AOSP image — Cuttlefish (virtual phone) for CI validation, and
real device targets (Pixel codenames) for installs.

The toolchain was originally written for **elizaOS** as a single
hardcoded brand and generalized so any brand can build a
privileged-system-app distribution by supplying a JSON brand config
and a vendor tree.

## Whitelabel contract

A "brand" is fully described by a JSON config (see `brand-config.mjs`)
and a corresponding **vendor tree** under `android/vendor/<brand>/`.

### Brand config schema

```jsonc
{
  // Required
  "brand":         "eliza",                  // lowercase token; vendor/<X>, init.<X>.rc, file paths
  "appName":       "Eliza",                  // PascalCase; APK module + apk filename
  "distroName":    "elizaOS",                // brand display name in log messages
  "packageName":   "com.elizaai.eliza",     // APK Java package id
  "classPrefix":   "Eliza",                  // Java class prefix (ElizaDialActivity, ElizaSmsReceiver, …)
  "productName":   "eliza_cf_x86_64_phone",  // Cuttlefish product name + makefile filename stem
  "lunchTarget":   "eliza_cf_x86_64_phone-trunk_staging-userdebug",
  "aospLockPath":  "android/pixel9a.lock.json", // optional per-target source lock
  "envPrefix":     "ELIZA",                  // env var prefix (ELIZA_PIXEL_CODENAME, ELIZA_AOSP_BUILD)

  // Optional — sensible defaults derived from `brand` if omitted
  "vendorDir":     "android/vendor/eliza",
  "initRcName":    "init.eliza.rc",
  "commonMakefile":"eliza_common.mk",
  "cuttlefishMakefile":"eliza_cf_x86_64_phone.mk",
  "buildAndroidSystemCmd": ["bun", "run", "--cwd", "packages/app", "build:android:system"],

  // Optional — only needed if the brand stores assets/cache outside the defaults
  "androidAssetsDir": "packages/app-core/platforms/android/app/src/main/assets/agent",
  "cacheDirName":     "eliza-android-agent"
}
```

### Brand resolution order (for every script in this directory)

1. CLI flag: `--brand-config <path>`
2. Env var: `DISTRO_ANDROID_BRAND_CONFIG=<path>`
3. Fallback: `scripts/distro-android/brand.eliza.json` (the elizaOS default)

### Vendor tree layout

For `brand = "<brand>"`:

```
<vendorDir>/
├── AndroidProducts.mk                                    # PRODUCT_MAKEFILES + COMMON_LUNCH_CHOICES
├── <brand>_common.mk                                     # Shared product layer
├── apps/<AppName>/
│   ├── Android.bp                                        # android_app_import (privileged: true, certificate: "platform")
│   └── <AppName>.apk                                     # Built by `bun run --cwd packages/app build:android:system`
├── bootanimation/
│   ├── desc.txt
│   └── (frame .png files)                                # Built by build-bootanimation.mjs
├── init/init.<brand>.rc                                  # Boot-time service definitions
├── overlays/frameworks/base/core/res/res/values/config.xml
│   └── config_defaultDialer/Sms/Assistant/Browser = <packageName>
├── permissions/
│   ├── Android.bp                                        # prebuilt_etc declarations
│   ├── default-permissions-<packageName>.xml             # default-grant permissions
│   └── privapp-permissions-<packageName>.xml             # privapp whitelist
├── products/
│   ├── <brand>_cf_x86_64_phone.mk                        # Cuttlefish product
│   └── <brand>_<codename>_phone.mk                       # Source-pinned physical target
└── sepolicy/
    ├── README.md
    ├── file_contexts                                     # Vendor file contexts (may be empty)
    └── <brand>_agent.te                                  # platform_app exec rule for on-device agent
```

The validator (`validate.mjs`) checks every required component, including
that the APK manifest contains `<classPrefix>DialActivity`,
`<classPrefix>InCallService`, `<classPrefix>SmsReceiver`, etc., wired
to the corresponding role intents.

## Scripts

| Script | What it does |
|---|---|
| `brand-config.mjs`        | Brand config loader; exports `loadBrandFromArgv(argv)` |
| `build-aosp.mjs`          | Top-level orchestrator: APK → sync → validate → m → cvd start → boot-validate |
| `sync-to-aosp.mjs`        | Copy `<vendorDir>` to `<aospRoot>/vendor/<brand>` |
| `validate.mjs`            | Static validation of vendor tree + APK (xmllint, aapt) |
| `boot-validate.mjs`       | adb checks against a booted device (roles, intents, package flags, logcat) |
| `lint-init-rc.mjs`        | Brand-agnostic Android init.rc syntax checker |

A physical-device brand config must set `aospLockPath` to its own source lock.
The build verifies the manifest and every device/kernel project named by that
lock. If it also contains a `proprietaryArchive` contract, the operator must
accept and run the vendor's license-gated extractor themselves; the build only
verifies the retained archive and extracted files. It never accepts a license.

Targets without a published OEM device tree may use a lock with pinned
`externalProjects` and a `generatedVendor` contract. Pixel 11 Pro uses this
path: `prepare-grizzly.mjs` materializes sparse, exact-commit `adevtool` and
`vendor_state` checkouts, generates `vendor/google_devices/grizzly`, verifies
the pinned reference image and required generated files, and retains the exact
stock rollback image. `build-aosp.mjs` refuses to continue if that generated
tree is absent or incomplete.

### Pending ports (developer tooling, eliza-only for now)

- `e2e-validate.mjs` — full e2e boot + interaction smoke
- `capture-screens.mjs` — adb screencap automation
- `avd-test.mjs` — emulator (non-cuttlefish) variant
- `sim.mjs` — local simulator runner
- `build-bootanimation.mjs` — bootanimation.zip builder

These can be migrated by following the same brand-config pattern when
needed.

## Whitelabel flow — call from a downstream brand

The `elizaos-cuttlefish.yml` workflow accepts a `brand-config` input
that points to a JSON file in the calling repo:

```yaml
# downstream-brand/.github/workflows/my-brand-cuttlefish.yml
jobs:
  build:
    uses: elizaOS/os/.github/workflows/elizaos-cuttlefish.yml@develop
    with:
      brand-config: android/brand.mybrand.json
      vendor-source: android/vendor/mybrand
      aosp-root: ${{ inputs.aosp-root }}
      jobs: 16
      launch: true
```

Or invoke the scripts directly from the OS checkout, with the application
repository available through `ELIZAOS_ELIZA_ROOT`:

```bash
ELIZAOS_ELIZA_ROOT=/path/to/eliza \
node scripts/distro-android/build-aosp.mjs \
  --brand-config android/brand.mybrand.json \
  --source-vendor android/vendor/mybrand \
  --aosp-root /aosp \
  --jobs 16 \
  --rebuild-privileged-apk \
  --launch \
  --boot-validate
```

For x86_64 or arm64 application staging, set
`ELIZA_BUN_RISCV64_OPTIONAL=1`; those images cannot execute a RISC-V slice.
For a riscv64 brand, instead provide `ELIZA_BUN_RISCV64_FILE` or
`ELIZA_BUN_RISCV64_URL` and the matching `ELIZA_BUN_RISCV64_SHA256`.
