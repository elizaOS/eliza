# 9584 AOSP build-toolchain evidence

Local Mac-feasible slice for #9584: make the Android arm64/aarch64-musl
llama.cpp builder fail closed on unsupported Zig host toolchains and resolve the
default Android assets directory for both flat elizaOS checkouts and host repos
whose app shell lives at `apps/app`.

## Verified here

```bash
bun test packages/app-core/scripts/aosp/compile-libllama.test.mjs
```

Result: 9 passing tests covering:

- macOS NDK host-prebuilt resolution for Android Vulkan builds.
- default assets-dir resolution for `packages/app`, host `apps/app`, and nested
  `eliza/packages/app` layouts.
- the arm64/aarch64-musl Zig compatibility gate: Zig 0.13.x accepted, Zig 0.14+
  rejected for arm64, riscv-only builds left to the existing RVV planner.

```bash
node packages/app-core/scripts/aosp/compile-libllama.mjs \
  --target android-arm64-vulkan --dry-run
```

Dry-run evidence from this host:

- `install=/Users/shawwalters/eliza-workspace/eliza/apps/app/android/app/src/main/assets/agent/arm64-v8a`
- `zig requirement: 0.13.0 <= version < 0.14.0 (aarch64-linux-musl pin)`

## Not verified here

The actual Vulkan/native build remains hardware/toolchain gated: it requires the
Android SDK/NDK plus the target-device GPU validation described in #9584.
