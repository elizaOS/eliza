# AOSP agent-payload toolkit

Scripts that build and stage the **agent payload** into the elizaOS
privileged Android app: the per-ABI `libllama.so`, the seccomp/loader
shim, and the bundled GGUF models, plus the on-device agent smoke test
and the Pixel deploy helper. Forks declare their variant once in
`app.config.ts > aosp:`; these scripts read from there.

> **Image build + emulator orchestration lives elsewhere.** The
> brand-aware, CI-wired orchestrator (`build-aosp.mjs`, `sim.mjs`,
> `boot-validate.mjs`, `e2e-validate.mjs`, `validate.mjs`,
> `sync-to-aosp.mjs`, `capture-screens.mjs`, `avd-test.mjs`,
> `build-bootanimation.mjs`, `lint-init-rc.mjs`) is canonical in
> `packages/scripts/distro-android/`, driven per-arch through
> `packages/os/android/Makefile` (`make build|sim ARCH=x86_64|arm64|riscv64`).
> Those scripts used to be duplicated here; the copies were removed in
> favor of the single distro-android core. This toolkit keeps only the
> agent-payload concerns that belong with the app-core runtime.

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
| `compile-libllama.mjs` | Cross-compile llama.cpp into a musl-linked `libllama.so` per ABI for the on-device bun:ffi runtime. |
| `compile-shim.mjs` | Cross-compile the SIGSYS-handler shim + musl loader-wrapper for the x86_64 cuttlefish path. |
| `stage-default-models.mjs` | Download bundled chat + embedding GGUFs into APK assets so first-boot chat works offline. |
| `stage-models-dfm.mjs` | Restructure the regenerated `apps/app/android/` tree into a `:models` dynamic feature module for Play Store AABs. |
| `smoke-cuttlefish.mjs` | End-to-end agent smoke: APK installed, service starts, `/api/health` 200, bearer-token chat round-trip. |
| `deploy-pixel.mjs` | Build the agent payload for a real device ABI and install onto a connected Pixel/dev board. |

Each script accepts `--app-config <PATH>` to override
`apps/app/app.config.ts` for tests.

## Hardware requirements

- AOSP build: Linux x86_64, KVM, ≥30 GB RAM, ≥ 600 GB free disk.
- libllama compile: zig **0.13.x** on PATH (pinned series), cmake. The
  `aarch64-linux-musl` / `x86_64-linux-musl` cross-link is pinned to the 0.13
  series because zig 0.16's bundled `lld` SIGSEGVs that link and aborts the
  fused/Android build with no actionable diagnostic. `compile-libllama.mjs` and
  `compile-shim.mjs` fail loudly (via `assertZigPinForTargets`) if the detected
  zig is outside 0.13.x; download the 0.13.x tarball from
  <https://ziglang.org/download/> (the package-manager `zig` is frequently
  0.16). Override only after independently verifying your lld links
  aarch64-linux-musl: `ELIZA_ALLOW_UNPINNED_ZIG=1`. (The riscv64 RVV build path
  is exempt — it needs zig 0.14+, gated by `MIN_ZIG_RVV_VERSION`.)
- Cuttlefish runtime: cuttlefish host package (`cvd`), `/dev/kvm`.
- Boot validation: `adb` on PATH or under `$ANDROID_HOME/platform-tools/`.
