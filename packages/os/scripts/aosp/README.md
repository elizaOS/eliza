# AOSP device toolkit

These scripts deploy and smoke-test elizaOS AOSP images. Image orchestration is
canonical in `scripts/distro-android/`; the Android application, its native
inference compiler, and model staging remain in `elizaOS/eliza` under
`packages/app-core/scripts/aosp/`.

Set `ELIZAOS_ELIZA_ROOT` to an application-source checkout. CI checks out that
repository at `.eliza-source` and uses it as the default dependency boundary.

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
| `smoke-cuttlefish.mjs` | End-to-end agent smoke: APK installed, service starts, `/api/health` 200, bearer-token chat round-trip. |
| `cuttlefish-native-inference-smoke.sh` | Cross-compile retained application kernels and verify them on a running x86_64 Cuttlefish image. |
| `deploy-pixel.mjs` | Invoke the application compiler, build the OS image, and deploy to a connected Pixel/dev board. |

Each script accepts `--app-config <PATH>` to override
`apps/app/app.config.ts` for tests.

## Hardware requirements

- AOSP build: Linux x86_64, KVM, ≥30 GB RAM, ≥ 600 GB free disk.
- Application payload compilation: use the toolchain documented by the checked
  out `elizaOS/eliza` revision.
- Cuttlefish runtime: cuttlefish host package (`cvd`), `/dev/kvm`.
- Boot validation: `adb` on PATH or under `$ANDROID_HOME/platform-tools/`.

For headless gfxstream on Intel ARL, select `EGL_PLATFORM=surfaceless` and the
Intel Vulkan ICD. The validated memory configuration is:

```sh
export ELIZA_CUTTLEFISH_GPU_RENDERER_FEATURES='VulkanAllocateHostMemory:enabled;VulkanDisableCoherentMemoryAndEmulate:enabled'
```

Use this with `build-aosp.mjs --launch`, or pass the same quoted value through
`launch_cvd --gpu_renderer_features`. Host allocation requires
`VK_EXT_external_memory_host` support. Coherent-memory emulation flushes mapped
buffer ranges before submissions; without it, repeated compute dispatches on
this host returned stale results even when a one-shot fixture passed.

Verify the actual renderer, repeated operations with changed inputs, and full
model generation against a CPU baseline. Software rendering and successful
model loading alone do not prove hardware Vulkan correctness. Keep these host
settings separate from Android image policy.
