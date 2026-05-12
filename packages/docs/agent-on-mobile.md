# Local agent on Android — spike record + roadmap

The Eliza mobile UI today (`MobileRuntimeMode = "remote-mac" | "cloud" | "cloud-hybrid"`) only
talks to remote agents — the desktop Eliza Cloud, a Mac running the runtime locally, or a
self-hosted gateway. The goal of this work is to add a fourth mode, **`local`**, where the full
`@elizaos/agent` runtime executes inside the phone itself with the WebView talking to it over
loopback HTTP, mirroring how Electrobun runs the agent on desktop.

This document records the spike that proved core viability, the artifacts kept in-repo so anyone
can reproduce it on a connected device, and the concrete blockers that remain before a real APK
ships with a working local agent.

## TL;DR

- **Bun runs on Android bionic.** A static `bun-linux-x64-musl` binary, paired with the matching
  `ld-musl-x86_64.so.1` loader and `libstdc++.so.6` / `libgcc_s.so.1` from Alpine, executes
  unmodified on the cuttlefish image and serves HTTP on `127.0.0.1:31337`. Same pattern works for
  arm64-v8a using the `bun-linux-aarch64-musl` + `ld-musl-aarch64.so.1` triple.
- **The agent boots far enough to hit plugin loading and PGlite init.** `bun build src/bin.ts` of
  `@elizaos/agent` produces a 43 MB bundle. With CJS stubs for native deps (`node-llama-cpp`,
  `sharp`, `onnxruntime-node`, `puppeteer-core`, `pty-manager`, `canvas`, `@huggingface/transformers`)
  it runs to the point of "Resolving 10 plugins... PGlite data dir created". It then dies on
  PGlite extension paths and on the 7-of-10 plugins the bundle did not include — both solvable.
- **Reproducible recipe** lives in `scripts/spike-android-agent/`. Pointed at any `adb`-attached
  device or a running cuttlefish, `bash scripts/spike-android-agent/bootstrap.sh` downloads the
  binaries, pushes them to `/data/local/tmp/`, and starts a stub HTTP server that responds to
  `GET /api/health` with `{"ok":true,"agent":"eliza-spike","bun":"1.3.13",...}`.

## What the spike actually exercised

```
adb device → /data/local/tmp/
              bun                    (96 MB, x86_64-musl)
              ld-musl-x86_64.so.1    (663 KB)
              libstdc++.so.6.0.33    (2.7 MB)
              libgcc_s.so.1          (174 KB)
              server.js              (proven HTTP responder)
              launch-on-device.sh    (double-fork daemoniser)
```

Invocation:

```
LD_LIBRARY_PATH=/data/local/tmp PORT=31337 \
  /data/local/tmp/ld-musl-x86_64.so.1 \
  /data/local/tmp/bun \
  /data/local/tmp/server.js
```

Verified on a `eliza_cf_x86_64_phone-trunk_staging-userdebug` cuttlefish. `/proc/net/tcp` shows
the listener on `0100007F:7A69` (`127.0.0.1:31337`). `nc 127.0.0.1 31337` from the device returns
valid JSON.

## Why this isn't done yet

A working APK that ships the bundled agent and serves chat through it requires four more pieces.

### 1. Asset shipping (DONE)

Bun + the three musl shared objects land in the APK under
`apps/app/android/app/src/main/assets/agent/{abi}/`. The
`stage-android-agent.mjs` step in `eliza/packages/app-core/scripts/run-mobile-build.mjs`
populates that tree on every Capacitor APK build, and `ElizaAgentService.java`
copies the files into `/data/data/com.elizaai.eliza/files/agent/{abi}/` at
first launch with the executable bit set.

For the AOSP product build, the same tree also receives a per-ABI
**`libllama.so`** (musl-linked, cross-compiled from llama.cpp `b3490` via
`scripts/elizaos/compile-libllama.mjs`). The Capacitor APK does NOT ship
`libllama.so` — it relies on the WebView-hosted `llama-cpp-capacitor`
plugin reached through the DeviceBridge loopback instead.

APK size with the agent runtime is ~100 MB per ABI; with `libllama.so`
added on the AOSP variant, ~110-115 MB per ABI. ABI split via Play
bundle config keeps the user-visible download sane.

### 2. `ElizaAgentService.java` (DONE)

`ElizaAgentService` is the foreground service that owns the local Eliza
agent process. It:

1. Copies `assets/agent/` → app data dir on first launch, sets executable bits.
2. `Runtime.exec()`s `ld-musl <bun> <agent-bundle.js> serve`.
3. Forwards stdout/stderr to logcat.
4. Holds a `FOREGROUND_SERVICE_SPECIAL_USE` notification with subtype
   `local-agent-runtime`.
5. `ElizaBootReceiver` calls `startForegroundService()` for it at
   `BOOT_COMPLETED`.

It also exports the per-platform inference env vars to the bun process:

- `ELIZA_DEVICE_BRIDGE_ENABLED=1` — always on, lets the WebView host
  `@elizaos/capacitor-llama` and broker inference for the agent.
- `ELIZA_LOCAL_LLAMA=1` — only when `BuildConfig.AOSP_BUILD == true`.
  This flips the runtime onto the in-process `bun:ffi` loader at
  `eliza/packages/agent/src/runtime/aosp-llama-adapter.ts`, which dlopens
  `agent/{abi}/libllama.so` directly. The gradle `AOSP_BUILD` field is
  driven by `-PelizaAospBuild=true`, set by `scripts/elizaos/build-aosp.mjs`
  during the AOSP product build.

### 3. SELinux policy

Apps in the default `priv_app` / `system_app` domain on AOSP can `execve()` binaries from their
own data dir, but the shared-object dependencies (musl loader, libstdc++) are an unusual access
pattern that can trip avc denials. The current `packages/os/android/vendor/eliza/sepolicy/` is a
permissive-only stub. Production needs:

- A `eliza_agent` type for the executables under `/data/data/com.elizaai.eliza/files/agent/`.
- `allow eliza_agent self:tcp_socket bind` for loopback listening.
- `allow eliza_agent priv_app_data_file:file r_file_perms` for reading the bundle.
- `neverallow` rules ensuring the binary cannot escape the loopback/data-dir sandbox.

Validate by running `adb shell dmesg | grep avc` after `cvd reset` and tightening until clean.

### 4. Agent payload

The bundling spike showed the agent loads but dies on:

- **PGlite extension resolution** (DONE). `pglite.wasm`, `pglite.data`,
  `vector.tar.gz`, and `fuzzystrmatch.tar.gz` are now shipped under
  `assets/agent/` and `ElizaAgentService` extracts them with the right
  parent/child relative path PGlite expects via its `new URL("../X", ...)`
  resolution.
- **Plugin resolution.** Core plugins such as shell and command handling are looked up by package name
  at runtime, not bundled. They need to ship as a flattened `node_modules/@elizaos/plugin-*` tree
  next to the bundle, or the runtime needs a mobile-aware loader that imports plugins from a
  manifest.
- **`child_process.spawn` from inside the agent.** The agent shells out in ~20 places
  (signal-pairing QR, sandbox-engine, stream-manager, self-updater, desktop-control,
  /usr/bin/open, osascript, lsof). On Android, none of these exist. They need either platform
  guards (`if (process.platform === "android") return null`) at every site, or — better — a
  `ELIZA_PLATFORM=android` env var the runtime checks centrally to short-circuit them. The
  existing `ELIZA_DISABLE_LOCAL_EMBEDDINGS=1` knob is the precedent.
- **On-device inference** (DONE for both APK variants). Two parallel paths
  now ship and are documented in the architecture section below. `node-llama-cpp`
  remains desktop-only; mobile uses one of the two mobile-friendly loaders.

### 5. UI wiring

```ts
// eliza/packages/app-core/src/onboarding/mobile-runtime-mode.ts
type MobileRuntimeMode = "remote-mac" | "cloud" | "cloud-hybrid" | "local";
```

`RuntimeGate.tsx`'s `shouldShowLocalOption()` becomes:

```ts
function shouldShowLocalOption(isDesktop: boolean, isDev: boolean, isAndroid: boolean) {
  if (isDesktop || isDev) return true;
  if (!isAndroid) return false;
  return await probeLocalAgent("http://127.0.0.1:31337/api/health");
}
```

`finishAsLocal()` on Android sets `apiBase = http://127.0.0.1:31337`, persists
`MOBILE_RUNTIME_MODE_STORAGE_KEY = "local"`, and the chat path then talks to the on-device
agent the same way it talks to a remote one — same protocol, no UI changes.

## On-device inference: two paths, one runtime

Eliza ships two distinct local-inference architectures on Android, gated by
which APK variant you're holding:

```
┌─────────────────────────────┐         ┌────────────────────────────┐
│  Capacitor APK (Play / IPA) │         │   AOSP product APK         │
│  com.elizaai.eliza        │         │   com.elizaai.eliza      │
│                             │         │   (priv-app, AOSP_BUILD=1) │
│   ┌──────────────────────┐  │         │   ┌──────────────────────┐ │
│   │ WebView              │  │         │   │ WebView              │ │
│   │ @elizaos/            │  │         │   │ (no llama plugin —   │ │
│   │ capacitor-llama JNI  │  │         │   │  bundle dependency   │ │
│   │      ↑               │  │         │   │  remains for fallback│ │
│   │      │               │  │         │   │  parity, unused)     │ │
│   │      │ DeviceBridge  │  │         │   └──────────────────────┘ │
│   │      │ /api/local-   │  │         │              │             │
│   │      │ inference/    │  │         │              │             │
│   │      │ device-bridge │  │         │              │             │
│   │  loopback WSS        │  │         │              │             │
│   └─────────┬────────────┘  │         │              │             │
│             │               │         │              │             │
│   ┌─────────┴────────────┐  │         │   ┌──────────┴──────────┐  │
│   │ ElizaAgentService   │  │         │   │ ElizaAgentService   │ │
│   │ (bun process)        │  │         │   │ (bun process)        │ │
│   │ ELIZA_DEVICE_BRIDGE_ │  │         │   │ ELIZA_LOCAL_LLAMA=1 │ │
│   │   ENABLED=1          │  │         │   │ + DeviceBridge       │ │
│   │   (sole inference)   │  │         │   │   loopback (legacy)  │ │
│   │                      │  │         │   │   bun:ffi.dlopen()   │ │
│   │                      │  │         │   │   agent/{abi}/       │ │
│   │                      │  │         │   │   libllama.so        │ │
│   └──────────────────────┘  │         │   └──────────────────────┘ │
└─────────────────────────────┘         └────────────────────────────┘
```

The selection is deterministic and triple-gated:

1. **Build-time gate** — `ELIZA_AOSP_BUILD=1` env to
   `eliza/packages/agent/scripts/build-mobile-bundle.mjs` keeps
   `node-llama-cpp` in the bundle (rather than stub-replacing it) so the
   `bun:ffi` loader has metadata helpers available to it.
2. **APK gradle gate** — `BuildConfig.AOSP_BUILD` boolean baked into the
   APK by `-PelizaAospBuild=true`. `ElizaAgentService` reads it with
   `if (BuildConfig.AOSP_BUILD) agentEnv.put("ELIZA_LOCAL_LLAMA", "1")`.
3. **Runtime gate** — `ELIZA_LOCAL_LLAMA=1` in the bun process env makes
   `aosp-llama-adapter.ts` register itself as the `localInferenceLoader`
   *before* the Capacitor adapter, so even with both loaders compiled in
   the FFI path always wins on AOSP.

Why two paths instead of one: the Capacitor APK distributes through the
Play Store and cannot ship `priv-app` privileges, system-level SELinux
domains, or arbitrary `dlopen()` of native code from app data. The
DeviceBridge loopback path keeps inference inside the WebView's
`llama-cpp-capacitor` JNI binding, which IS allowed for normal apps. The
AOSP product build owns the system surface, runs in `priv_app` (or its
own SELinux domain — sub-task 3 follow-up), and can dlopen() `libllama.so`
straight into the agent process without crossing the WebView boundary.

## Reproducing the spike

```
# With a connected device or running cuttlefish:
bash scripts/spike-android-agent/bootstrap.sh

# Verify from another shell:
adb shell '(echo -e "GET /api/health HTTP/1.0\r\nHost: localhost\r\n\r"; sleep 1) | toybox nc 127.0.0.1 31337'
# {"ok":true,"agent":"eliza-spike","bun":"1.3.13","uptime":...}
```

`bootstrap.sh` is idempotent (cached downloads in `/tmp/eliza-android-spike/`) and
ABI-aware (reads `ro.product.cpu.abi` and picks `x86_64` or `aarch64` artifacts).

## Building the AOSP variant locally

```bash
# 0. (one-time) install zig 0.13+ for the libllama cross-compile.
sudo snap install zig --classic --beta && zig version

# 1. Cross-compile libllama.so for both ABIs (idempotent).
node scripts/elizaos/compile-libllama.mjs --skip-if-present

# 2. Rebuild the privileged Capacitor APK with AOSP flags.
ELIZA_AOSP_BUILD=1 ELIZA_GRADLE_AOSP_BUILD=true bun run build:android:system

# 3. Run the AOSP product build (which also re-runs steps 1+2 if missing).
node scripts/elizaos/build-aosp.mjs --aosp-root ~/aosp \
  --rebuild-privileged-apk --launch --boot-validate
```

See `SETUP_AOSP.md` for the full Linux-x86_64-with-KVM setup.

## Open questions for follow-up sessions

- Should the agent ship as a single `bun build --compile` binary (smaller, fewer files, but
  forfeits per-plugin `import` resolution), or as `bun + bundle + node_modules` (larger, but
  every plugin path works as on desktop)?
- Is `ANTHROPIC_API_KEY` over the user's WAN acceptable for first-light, or do we need
  `llama-cpp-capacitor`-based inference before "local agent" tile is shown to users?
- How does the local agent reconcile with Eliza Cloud sync — does picking "local" disable cloud
  sync entirely, or do we keep a one-way push to cloud for cross-device continuity?

These are product calls, not architecture ones.
