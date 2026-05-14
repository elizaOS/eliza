# Windows End-to-End Build Report (eliza, develop branch)

## 1. Build entrypoints (Windows)

The repo is a Bun + Turborepo monorepo. There is no `build:windows` task at the root — the Windows path goes through the same orchestrator as macOS, branching on `process.platform === "win32"` inside the desktop scripts.

Root scripts (`package.json:21-78`):
- `postinstall` runs `scripts/fix-windows-bun-stub.mjs` first — replaces the 450-byte `node_modules/bun/bin/bun.exe` stub with the real Bun (Windows-only no-op elsewhere). See `scripts/fix-windows-bun-stub.mjs:1-46` for the rationale (oven-sh/bun#17482).
- `dev:desktop` (`package.json:50`) → `bun packages/app-core/scripts/dev-platform.mjs` — orchestrates Vite + API + Electrobun.
- `build` (`package.json:78`) → `turbo run build --concurrency=1` then `scripts/run-examples-benchmarks.mjs`. Plain `turbo` here, no Windows guard, so any task with a `&&`, `rm -rf`, or `NODE_OPTIONS='...'` in its script will break on `cmd.exe` (`clean`, `typecheck`, etc. all use POSIX quoting).
- `packages/app-core/scripts/build-win.mjs:1-82` and `dev-win.mjs:1-25` are Windows-specific wrappers but they target an older layout (`apps/app` instead of `packages/app`, `eliza/packages/app-core/apps/app` paths) — they're stale relative to the current `packages/app` layout used everywhere else. They likely don't work today as a one-shot Windows build.
- The real cross-platform desktop driver is `packages/app-core/scripts/desktop-build.mjs:1-918`. It branches on `process.platform === "win32"` for `embedWindowsIcons()` (`desktop-build.mjs:596-680`, post-build rcedit pass) and signing preflight (`:463`).

Electrobun config: `packages/app-core/platforms/electrobun/electrobun.config.ts:445-457` declares the `win:` block with `bundleCEF: true, bundleWGPU: true, defaultRenderer: "cef", icon: "assets/appIcon.ico"` and Chromium flags (`enable-unsafe-webgpu`, `enable-features=Vulkan`, `in-process-gpu`, `disable-gpu-sandbox`, `no-sandbox`).

Turbo pipelines (`turbo.json`): no Windows-specific filter exists. There is one Electrobun entry: `@elizaos/electrobun#build` (`turbo.json:170-173`) but no platform target.

A previously packaged build already exists in this checkout: `packages/app-core/platforms/electrobun/build/dev-win-x64/Eliza-dev/bin/launcher.exe` plus all CEF/WGPU DLLs (`libcef.dll`, `webgpu_dawn.dll`, `vulkan-1.dll`, `vk_swiftshader.dll`, `WebView2Loader.dll`, `bun.exe`, four helper EXEs).

## 2. Native dependencies on Windows

`node-llama-cpp@3.18.1` is the local-inference engine, declared `optional` in `plugins/plugin-local-inference/package.json:57`. Bun resolved **four** Windows variants of the prebuilt addon:
- `@node-llama-cpp/win-x64@3.18.1` (CPU)
- `@node-llama-cpp/win-x64-vulkan@3.18.1` — present at `node_modules/.bun/@node-llama-cpp+win-x64-vulkan@3.18.1/.../bins/win-x64-vulkan/` with `llama-addon.node`, `ggml-base.dll`, `ggml-vulkan.dll`, `ggml-cpu-*` micro-arch DLLs.
- `@node-llama-cpp/win-x64-cuda@3.18.1` + `-cuda-ext`
- `@node-llama-cpp/win-arm64@3.18.1`

All prebuilds ship — no local CMake/MSVC build is required for the chat happy-path on x64 Windows. The repo also has its own llama.cpp fork submodule at `plugins/plugin-local-inference/native/llama.cpp` (managed by `scripts/ensure-llama-cpp-submodule.mjs`), used only by the DFlash speculative-decoding pipeline (`scripts/build-llama-cpp-dflash.mjs`) — not required for first-run chat.

Other native deps: `onnxruntime-node@1.24.3` (Kokoro TTS), `bigint-buffer` (the log already says `bigint: Failed to load bindings, pure JS will be used` — benign), `lightningcss-win32-x64-msvc` (Tailwind), and CEF/WGPU prebundled by Electrobun.

GPU detection on Windows: `plugins/plugin-local-inference/src/adapters/node-llama-cpp/utils/platform.ts:144-208` — prefers PowerShell `Get-CimInstance Win32_VideoController` (Win 11 24H2 compatible) and falls back to `wmic`. NVIDIA → CUDA backend; else DirectML.

## 3. Code-signing / packaging

Three Windows distribution flavors:
- **Inno Setup direct installer**: `packages/app-core/packaging/inno/ElizaOSApp.iss` + `build-inno.ps1`. Per-user install (`PrivilegesRequired=lowest`), x64 only.
- **MSIX (Microsoft Store + direct full-trust)**: `packages/app-core/packaging/msix/build-msix.ps1` with two manifests (`AppxManifest.xml` for direct full-trust, `AppxManifest.store.xml` for AppContainer/store). Uses Windows SDK `makeappx.exe` + `signtool.exe`. Store-variant signing gated by `ELIZA_MSIX_STORE_CERT_PATH`.
- **Code signing**: `packages/app-core/platforms/electrobun/scripts/sign-windows.ps1` — PFX-based via `WINDOWS_SIGN_CERT_BASE64`/`_PASSWORD` env, or Azure Trusted Signing if `AZURE_TENANT_ID` is set. Default timestamp server DigiCert.
- Icon embed post-build via `rcedit-x64.exe` (`desktop-build.mjs:596-680`) because Electrobun's bundled rcedit step references a CI-local D:\ path.

## 4. Chat path with a 4B local model

End-to-end trace (current implementation):

1. **User types in UI** → `packages/ui/src/hooks/useProvisioningChat.ts` (or the standard messaging widget) → POSTs to the Eliza API.
2. **Agent runtime** in `packages/agent` (and `@elizaos/core`) routes the message to model handlers. Handler priority for `TEXT_SMALL`/`TEXT_LARGE` is owned by the cross-provider router installed at `MAX_SAFE_INTEGER` by `plugins/plugin-local-inference/src/services/router-handler.ts`.
3. **Local provider registration**: `plugins/plugin-local-inference/src/runtime/ensure-local-inference-handler.ts:1-80` registers the `eliza-local-inference llama.cpp handler for TEXT_SMALL / TEXT_LARGE at priority 0` (this exact log line appears in `dev-desktop.out.log:4795`).
4. **Engine**: `plugins/plugin-local-inference/src/services/engine.ts:1-100` owns one `Llama` binding (from `node-llama-cpp`) and at most one `LlamaModel` + cached `LlamaChatSession`. Model swap is unload-then-load (no double VRAM).
5. **Streaming bridge**: `plugins/plugin-local-inference/src/adapters/node-llama-cpp/text-streaming.ts:1-80` converts node-llama-cpp's push-based `onTextChunk` to the pull-based `TextStreamResult` shape (`{ textStream, text, usage, finishReason }`) that `packages/core/src/runtime.ts:417` (`isTextStreamResult`) requires. Runtime drains `textStream` at `runtime.ts:4657` and pumps SSE chunks via `params.onStreamChunk` to the UI.

Currently in `dev-desktop.out.log` the runtime starts cleanly (`Runtime ready — agent: Eliza`) but no model is auto-loaded — `local-inference` registers the handler but the 4B GGUF must be downloaded into `~/.eliza/local-inference/models/` first.

## 5. Known Windows-only issues found

- `scripts/fix-windows-bun-stub.mjs` — required workaround for `bun.exe` placeholder; Windows-only.
- `desktop-build.mjs:463-484` — store-build signing preflight; `ELIZA_MSIX_STORE_CERT_PATH` env required.
- `packages/app-core/platforms/electrobun/src/windows-cef-profile.ts:1-56` — bespoke `path.win32` vs `path.posix` switching because Electrobun bundle paths can be win-style even when read by Node on darwin (cross-pack path normalization).
- `packages/app-core/platforms/electrobun/scripts/smoke-test-windows.ps1:36-58` — PGlite MAX_PATH 260 workaround: pre-creates a short-name `pglite-XXXXXXXX` data dir in `$RUNNER_TEMP` because PGlite WAL nesting blows past MAX_PATH.
- `packages/app-core/scripts/lib/desktop-preflight.mjs:85-94` — buildWindowsRepairSteps for `EACCES_ELECTROBUN_VIEW`; common Bun-on-Windows symlink issue.
- `packages/app-core/scripts/build-win.mjs` and `dev-win.mjs` reference old `apps/app` layout (current layout is `packages/app`). Stale.
- `bigint-buffer` falls back to pure JS on Windows (logged at `dev-desktop.out.log:4742`) — benign for chat but slow for crypto.
- `@orca-so/common-sdk` import fails on Windows in dev runtime (`Cannot find module '@noble/hashes/sha2'`, log line ~4805) — only affects `app-steward`/Solana routes, not chat.
- `app-training` route load fails (`Cannot find module './' from '@types/react/jsx-dev-runtime.d.ts'`, log line ~4806) — TypeScript `types/react` resolution conflict; not a chat-blocker.

## 6. Current run state

Per `dev-desktop.out.log:4795-4816`:
- Vite + tsdown bundle succeeded (warnings only for `pglite` `eval` and dynamic-import dedup).
- API container started; SQL migrations all OK; `local-inference` registered TEXT_SMALL/TEXT_LARGE handler; router installed; runtime ready in 43s as agent "Eliza".
- Two non-blocking warnings: `plugin-video` lacks ffmpeg, `bigint` falls back to JS, `activity-tracker` disabled (`Non-Darwin platform — collector disabled; reports will be empty. (platform=win32)`).
- No local GGUF model is loaded yet. The chat path is wired but the model must be downloaded.

`dev-desktop.err.log` only contains turbo-build esbuild warnings (eval in pglite, dynamic-import double-import for several UI pages) — no fatal errors.

## 7. Smallest eliza-1 model variant

Per `ELIZA_1_GGUF_PLATFORM_PLAN.json`:
- `0_8b` tier — Qwen3.5 0.8B, Q4_K_M, 32k ctx, ~0.5 GB. Required Windows evidence: `windows-x64-cpu`, `windows-x64-vulkan`, `windows-arm64-cpu`, `windows-arm64-vulkan`. Required files include `text/eliza-1-0_8b-32k.gguf`.
- `2b` — Qwen3.5 2B, Q4_K_M, 32k ctx, ~1.4 GB. **This is the `FIRST_RUN_DEFAULT_MODEL_ID`** declared at `packages/shared/src/local-inference/catalog.ts:35`.
- `4b` — Qwen3.5 4B, Q4_K_M, 64k + 128k ctx, ~2.6 GB, min RAM 10 GB (`packages/shared/src/local-inference/catalog.ts:221-238`). Required Windows evidence: `windows-x64-cpu`, `windows-x64-vulkan`, `windows-x64-cuda`. Required files: `text/eliza-1-4b-64k.gguf`, `text/eliza-1-4b-128k.gguf`, kokoro TTS, mmproj-4b, dflash drafter, etc.

Download source: HuggingFace repo `elizaos/eliza-1` (`packages/shared/src/local-inference/catalog.ts:18`). URL builder at `plugins/plugin-local-inference/src/services/downloader.ts:1-50` streams the GGUF directly into `$STATE_DIR/local-inference/downloads/<id>.part` with resumable Range requests, then atomically moves to `models/<id>.gguf`.

## Prioritized issues to fix

1. **P0 — Stale Windows wrapper scripts** (`packages/app-core/scripts/build-win.mjs:24-25, dev-win.mjs:17-22`). Reference `apps/app` instead of `packages/app`. Either fix or delete to avoid trapping fresh contributors.
2. **P0 — No auto-download of 4B GGUF on first chat**. Today the runtime registers the handler but won't load a model unless one is already in `~/.eliza/local-inference/models/`. Need a first-run UX (or scripted preflight) that downloads `eliza-1-4b-64k.gguf` from `huggingface.co/elizaos/eliza-1` before the user types.
3. **P1 — `@types/react/jsx-dev-runtime.d.ts` `Cannot find module './'`** (log:4806). Blocks `app-training` route registration. TypeScript types resolution issue specific to Bun on Windows.
4. **P1 — `@noble/hashes/sha2` not found in `@orca-so/common-sdk`** (log:4805). Blocks `app-steward`. Subpath-exports incompatibility.
5. **P2 — `bigint: Failed to load bindings, pure JS will be used`** (log:4742). The bindings prebuild for Windows is missing; pure-JS path is slow.
6. **P2 — Inno installer placeholders never substituted**: `packaging/inno/ElizaOSApp.iss` is full of `__APP_ID__` / `__SOURCE_DIR__` placeholders; the substitution driver is `build-inno.ps1` — must run before iscc.exe.
7. **P3 — `dist/packaging/` duplicates `packaging/`** under `app-core/`. Confirm `dist/` is treated as build output, not edited by hand.

## Step-by-step: full Windows build + first chat with a 4B model

Prereqs once: Bun 1.3.13+, Node 24.15.0, Git for Windows, Windows SDK 10 (for signtool/makeappx if packaging), Visual C++ Redist 2022.

```powershell
# 1. Install deps. Triggers postinstall which fixes the bun.exe stub.
cd C:\Users\Administrator\Documents\eliza
bun install

# 2. (Optional) Initialize llama.cpp submodule for DFlash. Not required for vanilla chat.
git submodule update --init --recursive plugins/plugin-local-inference/native/llama.cpp

# 3. Build the workspace. Use the per-package builds (root `build` script uses POSIX `&&`).
bun run build:core
bun run --cwd packages/app plugin:build
bun run --cwd packages/app build:web

# 4. Stage + package the Electrobun desktop bundle for Windows.
bun packages/app-core/scripts/desktop-build.mjs build

# Output: packages/app-core/platforms/electrobun/build/dev-win-x64/Eliza-dev/bin/launcher.exe
# (already present in this checkout).

# 5. Pre-download the 4B GGUF so first chat is instant.
$models = "$env:USERPROFILE\.eliza\local-inference\models"
New-Item -ItemType Directory -Force -Path $models | Out-Null
Invoke-WebRequest `
  "https://huggingface.co/elizaos/eliza-1/resolve/main/bundles/4b/text/eliza-1-4b-64k.gguf" `
  -OutFile "$models\eliza-1-4b-64k.gguf"

# 6. Launch in dev mode (Vite + API + Electrobun) -- watches everything.
bun run dev:desktop

# 7. In the launched Eliza window: Settings -> Model -> Activate "eliza-1-4b" (or wait
#    for first-run recommender, which picks FIRST_RUN_DEFAULT_MODEL_ID = "eliza-1-2b"
#    by default; override via the model picker UI). Then type into chat.

# 8. (Optional) Sign + package as Inno installer for distribution.
$env:WINDOWS_SIGN_CERT_BASE64 = "<base64 PFX>"
$env:WINDOWS_SIGN_CERT_PASSWORD = "<password>"
pwsh -File packages/app-core/platforms/electrobun/scripts/sign-windows.ps1 `
  -ArtifactsDir packages\app-core\platforms\electrobun\artifacts `
  -BuildDir   packages\app-core\platforms\electrobun\build
pwsh -File packages/app-core/packaging/inno/build-inno.ps1 `
  -Variant direct `
  -SourceDir packages\app-core\platforms\electrobun\build\dev-win-x64\Eliza-dev
```

The dev-server route already proves steps 1-6 reach a ready runtime (`Runtime ready — agent: Eliza`). The remaining gap to "user types → gets streamed tokens" is just dropping a 4B GGUF in `~/.eliza/local-inference/models/` (step 5) and activating it in the UI.

Key file refs: `packages/app-core/scripts/desktop-build.mjs`, `packages/app-core/scripts/dev-platform.mjs`, `packages/app-core/platforms/electrobun/electrobun.config.ts:273-468`, `packages/app-core/packaging/msix/build-msix.ps1`, `packages/app-core/packaging/inno/ElizaOSApp.iss`, `plugins/plugin-local-inference/src/services/engine.ts`, `plugins/plugin-local-inference/src/adapters/node-llama-cpp/text-streaming.ts`, `plugins/plugin-local-inference/src/runtime/ensure-local-inference-handler.ts`, `packages/shared/src/local-inference/catalog.ts:18-238`, `scripts/fix-windows-bun-stub.mjs`, `dev-desktop.out.log:4795-4816`.
