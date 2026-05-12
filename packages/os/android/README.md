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
config lives at `scripts/distro-android/brand.eliza.json`.

## Build flow (eliza brand on a Linux x86_64 host with KVM)

```bash
bun install
bun run build:android:system        # stages vendor/eliza/apps/Eliza/Eliza.apk
node scripts/distro-android/validate.mjs

repo init --partial-clone -b android-latest-release \
  -u https://android.googlesource.com/platform/manifest
repo sync -c -j8

node scripts/distro-android/build-aosp.mjs \
  --aosp-root /path/to/aosp \
  --launch --boot-validate
```

That command syncs `vendor/eliza`, validates the product layer against the
AOSP source, runs `lunch eliza_cf_x86_64_phone-trunk_staging-userdebug && m`,
launches Cuttlefish, and then runs the boot validator.

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
