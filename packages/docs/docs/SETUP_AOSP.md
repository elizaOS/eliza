# Eliza Android — Dual-Build Map

The same `apps/app/android/` Gradle module produces two distinct APK shapes
from one source tree. They share the renderer, capacitor plugin set, agent
runtime code, and config; they diverge only in *what gets bundled into the
APK* and *where the resulting APK is installed*.

The build is selected at gradle invocation time:

| Build               | Property               | APK size  | Signing              | Install target                | Local inference path                       |
| ------------------- | ---------------------- | --------- | -------------------- | ----------------------------- | ------------------------------------------ |
| **AOSP** (elizaos)  | `-PelizaAospBuild=true`| ~250 MB   | platform key         | `/system/priv-app/<Brand>/`   | bundled `bun` + `libllama.so` + GGUFs      |
| **Capacitor**       | (unset, default)       | ~150 MB   | project keystore     | regular install / Play Store  | `@elizaos/llama-cpp-capacitor` jniLibs     |

Both code paths must work. Code that depends on the bundled runtime is
gated on `BuildConfig.AOSP_BUILD` (Java) or the runtime check
`process.env.ELIZA_LOCAL_LLAMA === '1'` (the agent-bundle JS).

## What each build ships

### AOSP build (`-PelizaAospBuild=true`)

Privileged system app. Lives at `/system/priv-app/<Brand>/<Brand>.apk`.
Platform-signed with the AOSP `platform.{pk8,x509.pem}` key so the
package can declare `android:sharedUserId="android.uid.system"` and use
the priv-app SELinux domain.

`assets/agent/` is preserved and contains:

- `agent-bundle.js` — single-file 43 MB esbuild bundle of the entire
  elizaOS agent (runtime, plugins, action graph, providers).
- `arm64-v8a/bun` + musl loader + libgcc/libstdc++ — static bun runtime
  that `ElizaAgentService` spawns directly, no JNI.
- `arm64-v8a/libllama.so`, `libggml*.so` — llama.cpp shared libs that
  the bun process dlopens.
- `arm64-v8a/libeliza-llama-shim.so` — thin C shim that re-exports the
  llama.cpp symbols under `eliza_llama_*` names so the agent can
  bun:ffi-bind them without colliding with any other loaded llama lib.
- `models/` — bundled Eliza-1 GGUF models for smoke and the production
  checkpoint listed in `manifest.json`.
- `pglite.wasm`, `pglite.data`, `vector.tar.gz`, `fuzzystrmatch.tar.gz`,
  `fuzzystrmatch.tar` — PGlite v0 + extensions (no compression so
  PGlite's loader can mmap them as-is).
- `launch.sh` — the entry script `ElizaAgentService` invokes with
  `ELIZA_LOCAL_LLAMA=1` so the agent registers the AOSP llama loader
  (`eliza/packages/agent/src/runtime/aosp-llama-adapter.ts`).

`AndroidManifest.xml` (overlaid from
`eliza/packages/app-core/platforms/android/app/src/main/...` with
package rename) declares the AOSP-only system components:

- `ElizaAgentService` — foreground service that owns the bun process.
- `ElizaBootReceiver` — `BOOT_COMPLETED` start.
- `ElizaInCallService` / `ElizaSmsReceiver` / `ElizaMmsReceiver` /
  `ElizaRespondViaMessageService` / `ElizaDialActivity` — telephony
  defaults so the agent can be the system phone/messaging app.
- `ElizaAssistActivity` — assist intent handler.
- `ElizaBrowserActivity` / `ElizaContactsActivity` / `ElizaCameraActivity`
  / `ElizaClockActivity` / `ElizaCalendarActivity` / `ElizaSmsComposeActivity`
  — replacements for the standard system activities.

SELinux: domain `priv_app` (or, when seapp_contexts orders
`seinfo=platform` first because the APK is platform-signed, `platform_app`).
The brand-specific seapp_contexts entry lives at
`os/android/vendor/<brand>/sepolicy/<brand>_agent.te`.

### Capacitor build (default)

Regular Android app. Installed via `pm install` or the Play Store.
Signed with the project keystore.

`assets/agent/` is **stripped at merge time**. Local inference goes
through `@elizaos/llama-cpp-capacitor`'s `lib/<abi>/libllama-cpp-*.so`
jniLibs, which the agent talks to over the loopback DeviceBridge JSON-RPC.
There is no bundled `bun` and no privileged system component.

The `Eliza*` system activities/services declared in the manifest are
still present — they're inert in the Capacitor build because the agent
never calls them, and the manifest is shared. The `BuildConfig.AOSP_BUILD`
flag (compiled in from `-PelizaAospBuild`) is what runtime code keys off
to know which mode it's in.

## The thinning hook

The actual exclude is implemented as a `doLast` action on the
`mergeReleaseAssets` (and any other `merge*Assets`) task in
`apps/app/android/app/build.gradle`:

```gradle
afterEvaluate {
    tasks.matching { it.name.startsWith('merge') && it.name.endsWith('Assets') }.all { mergeTask ->
        mergeTask.doLast {
            if (project.findProperty('elizaAospBuild') != 'true') {
                def assetsDir = mergeTask.outputDir.get().asFile
                def agentDir = new File(assetsDir, 'agent')
                if (agentDir.exists()) {
                    println "[app-thinning] removing assets/agent/ from ${mergeTask.name} (Capacitor build)"
                    agentDir.deleteDir()
                }
            } else {
                println "[app-thinning] keeping assets/agent/ in ${mergeTask.name} (AOSP build)"
            }
        }
    }
}
```

AGP's `sourceSets.assets.exclude 'agent/**'` is silently ignored for the
assets dir under AGP 9.x — the pattern is accepted but not propagated to
the merge step. The `doLast` hook above is the reliable mechanism.

The same hook is injected by
`eliza/packages/app-core/scripts/run-mobile-build.mjs::injectAospAssetThinning()`,
so any regenerated `apps/app/android/app/build.gradle` picks it up
idempotently.

## Build commands

### AOSP build

```bash
# From repo root. Stages the bundled agent runtime, overlays Java sources,
# patches the manifest, then runs the gradle build with the AOSP flag.
bun run build:android:system
```

Or directly:

```bash
cd apps/app/android
./gradlew :app:assembleRelease -PelizaAospBuild=true
```

The resulting APK at
`apps/app/android/app/build/outputs/apk/release/app-release-unsigned.apk`
must then be platform-signed with `apksigner` and the AOSP platform key
before it is pushed to `/system/priv-app/<Brand>/`. See
`scripts/elizaos/build-aosp.mjs` and the post-build sign+push script.

### Capacitor build

```bash
cd apps/app/android
./gradlew :app:assembleRelease
```

Produces a ~150 MB APK signed with the project keystore. The `agent/`
asset tree is excluded by the thinning hook above — the build log shows
`[app-thinning] removing assets/agent/ from mergeReleaseAssets (Capacitor build)`.

## Cuttlefish smoke

The cuttlefish smoke runner lives at
`scripts/elizaos/smoke-cuttlefish.mjs`. It expects a running cvd on
`0.0.0.0:6520`, a platform-signed Eliza APK at
`os/android/vendor/eliza/apps/Eliza/Eliza.apk`, and an overlay-mounted
`/system` so it can push the APK to `/system/priv-app/Eliza/Eliza.apk`
without re-flashing.

The smoke validates: APK install, ElizaAgentService start, bun process
alive, PGlite init, `/api/health` reachable on the loopback port, and an
end-to-end planner round-trip against the bundled GGUF.

## Related files

- `apps/app/android/app/build.gradle` — module gradle (gitignored,
  generated by `bun run build:android:system`; the source-of-truth
  patches live in `run-mobile-build.mjs`).
- `eliza/packages/app-core/scripts/run-mobile-build.mjs` — injection
  functions: `injectBuildConfigAospField`, `injectNoCompressTarGz`,
  `injectAospAssetThinning`, plus `patchAndroidGradle` that wires them.
- `eliza/packages/app-core/scripts/lib/stage-android-agent.mjs` —
  `stageAndroidAgentRuntime()` that copies the bun runtime, libllama,
  shim, agent-bundle, PGlite payload, and GGUFs into
  `apps/app/android/app/src/main/assets/agent/`.
- `eliza/packages/app-core/platforms/android/app/src/main/java/ai/elizaos/app/`
  — upstream Java sources (`ElizaAgentService`, `ElizaBootReceiver`, etc.)
  that the overlay step copies into `ai.elizaos.eliza` package.
- `eliza/packages/agent/src/runtime/aosp-llama-adapter.ts` — runtime
  adapter that registers the AOSP `eliza_llama_*` shim symbols when
  `ELIZA_LOCAL_LLAMA=1`.
- `eliza/packages/native-plugins/agent/android/` — capacitor agent
  plugin used by the Capacitor build path.
- `os/android/vendor/eliza/sepolicy/eliza_agent.te` — brand-specific
  SELinux domain definition for the priv-app AOSP build.
- `scripts/elizaos/smoke-cuttlefish.mjs` — cuttlefish smoke runner.
- `scripts/elizaos/build-aosp.mjs` — orchestrator that drives the
  AOSP-side build (sourcetree overlay + sign + push to overlay).
