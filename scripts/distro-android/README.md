# scripts/distro-android — Brand-aware AOSP/Cuttlefish toolchain

This directory contains the toolchain for building a brand-customised
Android AOSP image — Cuttlefish (virtual phone) for CI validation, and
real device targets (Pixel codenames) for installs.

The toolchain was originally written for **MiladyOS** (a single
hardcoded brand) and lifted upstream to **elizaOS** so any brand can
build a privileged-system-app distribution by supplying a JSON brand
config and a vendor tree.

## Whitelabel contract

A "brand" is fully described by a JSON config (see `brand-config.mjs`)
and a corresponding **vendor tree** under `os/android/vendor/<brand>/`.

### Brand config schema

```jsonc
{
  // Required
  "brand":         "milady",                  // lowercase token; vendor/<X>, init.<X>.rc, file paths
  "appName":       "Milady",                  // PascalCase; APK module + apk filename
  "distroName":    "MiladyOS",                // brand display name in log messages
  "packageName":   "com.miladyai.milady",     // APK Java package id
  "classPrefix":   "Milady",                  // Java class prefix (MiladyDialActivity, MiladySmsReceiver, …)
  "productName":   "milady_cf_x86_64_phone",  // Cuttlefish product name + makefile filename stem
  "lunchTarget":   "milady_cf_x86_64_phone-trunk_staging-userdebug",
  "envPrefix":     "MILADY",                  // env var prefix (MILADY_PIXEL_CODENAME, MILADY_AOSP_BUILD)

  // Optional — sensible defaults derived from `brand` if omitted
  "vendorDir":     "os/android/vendor/milady",
  "initRcName":    "init.milady.rc",
  "commonMakefile":"milady_common.mk",
  "cuttlefishMakefile":"milady_cf_x86_64_phone.mk",
  "buildAndroidSystemCmd": ["bun", "run", "build:android:system"],

  // Optional — only needed if the brand stores assets/cache outside the defaults
  "androidAssetsDir": "apps/app/android/app/src/main/assets/agent",
  "cacheDirName":     "milady-android-agent"
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
│   └── <AppName>.apk                                     # Built by `bun run build:android:system`
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
│   ├── <brand>_pixel_phone.mk                            # Pixel template
│   └── <brand>_<codename>_phone.mk                       # Per-device wrappers (oriole, panther, shiba, caiman, …)
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
| `build-aosp.mjs`          | Top-level orchestrator: libllama → APK → sync → validate → m → cvd start → boot-validate |
| `sync-to-aosp.mjs`        | Copy `<vendorDir>` to `<aospRoot>/vendor/<brand>` |
| `validate.mjs`            | Static validation of vendor tree + APK (xmllint, aapt) |
| `boot-validate.mjs`       | adb checks against a booted device (roles, intents, package flags, logcat) |
| `lint-init-rc.mjs`        | Brand-agnostic Android init.rc syntax checker |
| `compile-libllama.mjs`    | Cross-compile musl-linked libllama.so per ABI for the bundled bun runtime |

### Pending ports (developer tooling, milady-only for now)

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
    uses: elizaOS/eliza/.github/workflows/elizaos-cuttlefish.yml@develop
    with:
      brand-config: os/android/brand.mybrand.json
      vendor-source: os/android/vendor/mybrand
      aosp-root: ${{ inputs.aosp-root }}
      jobs: 16
      launch: true
```

Or invoke the scripts directly when eliza is checked out as a submodule:

```bash
node eliza/scripts/distro-android/build-aosp.mjs \
  --brand-config os/android/brand.mybrand.json \
  --source-vendor os/android/vendor/mybrand \
  --aosp-root /aosp \
  --jobs 16 \
  --launch \
  --boot-validate
```
