# AOSP system-app build toolkit

Generic build, validate, and test scripts for AOSP product images that
ship the elizaOS privileged Android app. Forks declare their variant
once in `app.config.ts > aosp:`; every script reads from there.

## Variant config

Add an `aosp` block to your host app's `app.config.ts`:

```ts
import type { AppConfig } from "@elizaos/app-core";

export default {
  appName: "Acme",
  appId: "com.acmecorp.acme",
  // ... other AppConfig fields ...

  aosp: {
    productLunch: "acme_cf_x86_64_phone-trunk_staging-userdebug",
    vendorDir: "acme",
    variantName: "AcmeOS",
    productName: "acme",
    packageName: "com.acmecorp.acme",
    appName: "Acme",
    commonMk: "vendor/acme/acme_common.mk",
    modelSourceLabel: "acme-download",
    bootanimationAssetDir: "os/android/vendor/acme/bootanimation",
  },
} satisfies AppConfig;
```

See `AospVariantConfig` in
`eliza/packages/app-core/src/config/app-config.ts` for the full
schema. Forks without an `aosp:` block don't ship an AOSP image; the
toolkit is inert.

## Scripts

| Script | What it does |
|---|---|
| `build-aosp.mjs` | End-to-end orchestrator: compile-libllama → stage models → validate → `m -j<N>` → optionally `cvd start --daemon` → boot-validate. |
| `validate.mjs` | Validate the `os/android/vendor/<vendorDir>/` tree: product makefile, permission XMLs, sepolicy, init.rc syntax, staged APK manifest. |
| `sync-to-aosp.mjs` | Copy `os/android/vendor/<vendorDir>/` into `<aospRoot>/vendor/<vendorDir>/`. |
| `boot-validate.mjs` | Validate a booted device or cuttlefish: roles, granted permissions, replacement intent resolvers, `/system/priv-app/<appName>/` install path. |
| `e2e-validate.mjs` | Wraps boot-validate + capture-screens into a single command that emits `report.json` + a PNG gallery. |
| `capture-screens.mjs` | Drive `adb shell screencap -p` over a sequenced step list (home, dialer, sms, assist, recents, launcher). |
| `avd-test.mjs` | Boot a stock Android AVD, debug-sign + install the variant APK, optionally capture screens. |
| `sim.mjs` | One-shot Cuttlefish runner: wait for `system.img`, `cvd start --daemon`, run e2e-validate, optionally `cvd stop --clean`. |
| `smoke-cuttlefish.mjs` | End-to-end agent smoke: APK installed, service starts, `/api/health` 200, bearer-token chat round-trip. |
| `compile-libllama.mjs` | Cross-compile llama.cpp into a musl-linked `libllama.so` per ABI for the on-device bun:ffi runtime. |
| `compile-shim.mjs` | Cross-compile the SIGSYS-handler shim + musl loader-wrapper for the x86_64 cuttlefish path. |
| `lint-init-rc.mjs` | Generic AOSP `init.rc` syntax linter. |
| `build-bootanimation.mjs` | Pack `desc.txt` + `partN/` PNG dirs into the uncompressed `bootanimation.zip` AOSP's bootanimation daemon expects. |
| `stage-default-models.mjs` | Download bundled chat + embedding GGUFs into APK assets so first-boot chat works offline. |
| `stage-models-dfm.mjs` | Restructure the regenerated `apps/app/android/` tree into a `:models` dynamic feature module for Play Store AABs. |

Each script accepts `--app-config <PATH>` to override
`apps/app/app.config.ts` for tests.

## Hardware requirements

- AOSP build: Linux x86_64, KVM, ≥30 GB RAM, ≥ 600 GB free disk.
- libllama compile: zig 0.13+ on PATH, cmake.
- Cuttlefish runtime: cuttlefish host package (`cvd`), `/dev/kvm`.
- Boot validation: `adb` on PATH or under `$ANDROID_HOME/platform-tools/`.
