# scripts/distro-android — Brand-aware AOSP/Cuttlefish toolchain

This directory contains the toolchain for building a brand-customised
Android AOSP image — Cuttlefish (virtual phone) for CI validation, and
real device targets (Pixel codenames) for installs.

The toolchain was originally written for **ElizaOS** (a single
hardcoded brand) and lifted upstream to **elizaOS** so any brand can
build a privileged-system-app distribution by supplying a JSON brand
config and a vendor tree.

## Whitelabel contract

A "brand" is fully described by a JSON config (see `brand-config.mjs`)
and a corresponding **vendor tree** under `packages/os/android/vendor/<brand>/`.

### Brand config schema

```jsonc
{
  // Required
  "brand":         "eliza",                  // lowercase token; vendor/<X>, init.<X>.rc, file paths
  "appName":       "Eliza",                  // PascalCase; APK module + apk filename
  "distroName":    "ElizaOS",                // brand display name in log messages
  "packageName":   "com.elizaai.eliza",     // APK Java package id
  "classPrefix":   "Eliza",                  // Java class prefix (ElizaDialActivity, ElizaSmsReceiver, …)
  "productName":   "eliza_cf_x86_64_phone",  // Cuttlefish product name + makefile filename stem
  "lunchTarget":   "eliza_cf_x86_64_phone-trunk_staging-userdebug",
  "envPrefix":     "ELIZA",                  // env var prefix (ELIZA_PIXEL_CODENAME, ELIZA_AOSP_BUILD)

  // Optional — sensible defaults derived from `brand` if omitted
  "vendorDir":     "packages/os/android/vendor/eliza",
  "initRcName":    "init.eliza.rc",
  "commonMakefile":"eliza_common.mk",
  "cuttlefishMakefile":"eliza_cf_x86_64_phone.mk",
  "buildAndroidSystemCmd": ["bun", "run", "build:android:system"],

  // Optional — only needed if the brand stores assets/cache outside the defaults
  "androidAssetsDir": "apps/app/android/app/src/main/assets/agent",
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
| `validate-ota-metadata.mjs` | Static validation of an AOSP OTA release JSON index; no AOSP checkout required |
| `boot-validate.mjs`       | adb checks against a booted device (roles, intents, package flags, logcat) |
| `lint-init-rc.mjs`        | Brand-agnostic Android init.rc syntax checker |
| `compile-libllama.mjs`    | Cross-compile musl-linked libllama.so per ABI for the bundled bun runtime |

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
    uses: elizaOS/eliza/.github/workflows/elizaos-cuttlefish.yml@develop
    with:
      brand-config: packages/os/android/brand.mybrand.json
      vendor-source: packages/os/android/vendor/mybrand
      aosp-root: ${{ inputs.aosp-root }}
      jobs: 16
      launch: true
```

Or invoke the scripts directly when eliza is checked out as a submodule:

```bash
node eliza/scripts/distro-android/build-aosp.mjs \
  --brand-config packages/os/android/brand.mybrand.json \
  --source-vendor packages/os/android/vendor/mybrand \
  --aosp-root /aosp \
  --jobs 16 \
  --launch \
  --boot-validate
```

## OTA release metadata

AOSP/ElizaOS updates are owned by the signed OTA/system-image channel, not by
the normal APK update UI. Release jobs should publish a JSON index beside the
signed full OTA, optional signed incremental OTA, payload properties, checksums,
and release notes. GitHub Releases can host those files when devices verify the
payload signatures before install.

Run the metadata validator before publishing:

```bash
node scripts/distro-android/validate-ota-metadata.mjs \
  --brand-config scripts/distro-android/brand.eliza.json \
  out/elizaos-ota-release.json
```

Required top-level fields are `schemaVersion: 1`, `brand`, `distroName`,
`packageName`, `channel`, `releaseVersion`, `buildId`, `buildFingerprint`,
`androidVersion`, `securityPatchLevel`, `releaseNotesUrl`, and `payloads`.
Each payload records `type`, `fileName`, HTTPS `url`, `sha256`, `sizeBytes`,
`targetBuildFingerprint`, `rollbackIndex`, and `rollbackIndexLocation`.
Incremental payloads also require `sourceBuildFingerprint`. The optional
`--allow-file-urls` flag is for local dry-runs only.
