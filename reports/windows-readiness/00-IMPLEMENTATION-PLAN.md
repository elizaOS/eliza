# Windows Readiness — Consolidated Implementation Plan

**Status:** Research phase complete (2026-05-14). 10 reports in `reports/windows-readiness/01-*` through `10-*`. This document is the parallelized implementation plan derived from those reports.

**Host context:** This machine (the dev VM) is QEMU/KVM Win11 Pro 26200, AMD EPYC 9684X (Zen4, AVX-512 capable on bare-metal — exposed AVX2/FMA/F16C reliably), 12 vCPU, 32 GB RAM, **no GPU** (only Basic Display Adapter). CUDA/Vulkan paths cannot be hardware-validated on this box; CPU-only validation is the achievable scope here. Reserve a separate Windows-with-GPU host for CUDA/Vulkan evidence.

---

## A. Cross-cutting findings (one root cause feeds many streams)

| # | Finding | Affects streams | Single-source fix |
|---|---|---|---|
| C1 | `ffmpeg` not on PATH | Voice (mic/playback), Vision (camera/audio) | Install ffmpeg via winget; add to the documented Windows prereq list; harden code to detect-and-warn |
| C2 | `wmic` deprecated on Win11 26200 | Vision (display enum), build-tools | Replace with `Get-CimInstance Win32_DesktopMonitor` everywhere |
| C3 | `process.env.HOME ?? "/tmp"` model-cache root | Vision (rapid OCR, YOLO, MediaPipe) | Use `os.homedir()` / `os.tmpdir()` |
| C4 | Plugin manifest has no `requiresUnsandboxed` flag | Sandbox (YOLO/safe), Store-compat | Add field to `Plugin` type in `packages/core`; tag dangerous plugins; switch `plugin-collector.ts:35` to read it |
| C5 | llama.cpp Windows binaries stale (old `spiritbuun` fork, `qjl_full:false`) and missing `llama-bench.exe` / `llama-completion.exe` | Kernels, DFlash, Build (first-chat), Optimizations | Init submodule, rebuild against `elizaOS/llama.cpp @ ce85787c`, produce full binary set |
| C6 | First-run UX never auto-downloads an eliza-1 GGUF | Build (chat works), DFlash (test target), Voice (Kokoro bundle dep) | Preflight pulls `eliza-1-2b` (default) into `~/.eliza/local-inference/models/` before runtime ready |
| C7 | Launcher does not propagate `ELIZA_BUILD_VARIANT` / `ELIZA_DISTRIBUTION_PROFILE` into agent subprocess | Sandbox, Store | Codify in `packages/app-core/platforms/electrobun/src/native/agent.ts` |
| C8 | Plugin exclusion in store builds is hardcoded to 3 plugins, missing 10+ others | Sandbox, Store | Replace `plugin-collector.ts:35-40` hardcoded Set with manifest-driven filter (depends on C4) |

These eight cross-cutting items are the prerequisite foundation. Three of them (C4, C7, C8) are tightly coupled and form a single workstream below ("Stream 0").

---

## B. Dependency graph

```
                           STREAM 0 (FOUNDATION)
                  C4 + C7 + C8: gating contract refactor
                              |       |
                              v       v
                   STREAM 5         STREAM 6
                   Sandbox          Store-compat
                   (YOLO/Safe)      (MSIX, WACK; submission gated on Partner Center)

   STREAM 1 (FOUNDATION) — 4 binary variants
   C5: llama.cpp Windows rebuild
   produces windows-x64-cpu-avx2, -cpu-avx512, -cuda, -vulkan
   each with qjl_full:true CAPABILITIES.json
            |
            +---------------+----------------+----------------+
            v               v                v                v
       STREAM 2         STREAM 8         STREAM 9         STREAM 10
       Kernels          DFlash drafters  Streaming        Build opts +
       (verify CPU)     train+publish+   (depends on      micro-arch
       (this VM)        Windows e2e      llama-server)    dispatcher

   STREAM 3 (INDEPENDENT — install ffmpeg, fix HOME, fix wmic)
   Voice + Vision Windows enablement
            |
            +---------+
            v         v
       STREAM 4a   STREAM 4b
       Voice ETE   Vision ETE

   STREAM 7a (INDEPENDENT)         STREAM 7b (after S7a interfaces stable)
   Computeruse parity primitives    Sandbox providers
   (host driver, Win fixes)          (Windows Sandbox, Docker, Cloud)

   STREAM 11 (CAPSTONE — needs S1, S3, S5 done)
   End-to-end Windows build + first chat with 4B model
```

Streams marked INDEPENDENT can start immediately in parallel. Streams 5–6 depend on Stream 0. Streams 2/8/9/10 depend on Stream 1. Stream 7b depends on Stream 7a interfaces. Stream 11 is the integration capstone.

---

## C. Parallel work streams — per-stream agent briefs

Each brief is a self-contained prompt suitable for handing to an implementation sub-agent. Each agent reads its referenced research report from `reports/windows-readiness/` for full context.

### STREAM 0 — Sandbox gating refactor (FOUNDATION, blocks S5 + S6)

**Owner:** one agent. Estimated effort: 2 days.

**Reads:** `reports/windows-readiness/06-sandbox-yolo-modes.md`, `07-windows-store-compat.md`.

**Tasks:**
1. Add `requiresUnsandboxed: boolean` (default `false`) to the `Plugin` type in `packages/core/src/types/plugin.ts`. Add `dangerLevel: "safe" | "medium" | "high" | "critical"` while you're there for downstream UX.
2. Tag every dangerous plugin's exported `Plugin` object: `plugin-shell`, `plugin-coding-tools`, `plugin-agent-orchestrator`, `plugin-computeruse`, `plugin-browser`, `plugin-mcp`, `plugin-background-runner`, `plugin-app-control`, `plugin-codex-cli`, `plugin-executecode`, `plugin-tailscale`, `plugin-ngrok`, `plugin-tunnel`, `plugin-discord-local`, `plugin-bluebubbles`, `plugin-imessage`, `app-polymarket`.
3. Rewrite the hardcoded `STORE_BUILD_LOCAL_EXECUTION_PLUGINS` Set in `packages/agent/src/runtime/plugin-collector.ts:35-40` to instead filter on `plugin.requiresUnsandboxed === true` when `isStoreBuild()`.
4. In `packages/app-core/platforms/electrobun/src/native/agent.ts`, propagate `ELIZA_BUILD_VARIANT` and `ELIZA_DISTRIBUTION_PROFILE` from the launcher env into the spawned agent subprocess. Add a startup assertion that fails loud if the binary is signed for store but the agent process sees `direct`.
5. Add `pty`, `mcp-spawn`, `cdp`, `ipc` to `CapabilityKind` in `packages/agent/src/services/capability-broker.ts:37`; extend the policy table to deny these for `store` profile across all three runtime modes.
6. Vite `define` driven compile-time strip in `packages/app/vite.config.ts` — for store builds, replace `dangerousPluginAllowlist` re-exports with `[]` so the renderer bundle physically lacks dangerous-action handlers.
7. Extend `scripts/launch-qa/check-store-security.mjs` to assert (a) env-propagation contract, (b) no `ShellService | PTYService | ComputerUseService | SandboxService` symbols in the store renderer bundle.

**Done when:** A store-build MSIX run produces an agent subprocess that sees `ELIZA_BUILD_VARIANT=store`; the plugin-collector strips every tagged plugin; capability broker denies the new kinds; check-store-security passes.

---

### STREAM 1 — llama.cpp Windows rebuild — 4 target variants (FOUNDATION, blocks S2 + S8 + S9 + S11)

**Owner:** one agent. Estimated effort: 2 days.

**Reads:** `reports/windows-readiness/01-llama-cpp-kernels.md`, `08-windows-optimizations.md`, `09-dflash-and-models.md`.

**Tasks:**
1. `git submodule update --init --recursive plugins/plugin-local-inference/native/llama.cpp` and confirm HEAD = `ce85787c` (`v1.2.0-eliza`).
2. Apply the OpenMP fix from `08-windows-optimizations.md` §3: gate `GGML_OPENMP=ON` for Windows MSVC host builds in `packages/app-core/scripts/build-llama-cpp-dflash.mjs:1479`. Keep mingw-cross path with `OFF`.
3. Apply the AVX-512/AVX-VNNI fix from `01-llama-cpp-kernels.md` §8 item 1 and `08-windows-optimizations.md` §4: add `hostHasAvx512()`/`hostHasAvxVnni()` detection for Windows-x64.
4. **Produce two Windows-x64-cpu variants** (two-binary AVX dispatch):
   - `windows-x64-cpu-avx2`: `-DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON` (baseline, runs on any x64 post-2013).
   - `windows-x64-cpu-avx512`: above + `-DGGML_AVX512=ON -DGGML_AVX512_VNNI=ON -DGGML_AVX512_BF16=ON -DGGML_AVX_VNNI=ON` (Zen4 / Sapphire Rapids / Granite Rapids / Tiger Lake+).
   - Tag each `CAPABILITIES.json` with the micro-arch baseline so the runtime dispatcher can identify the right binary set.
5. Also produce `windows-x64-cuda` and `windows-x64-vulkan` binary sets (staged for the future Windows+GPU host; not validated on this VM).
6. For each variant, produce `llama-server.exe`, `llama-cli.exe`, `llama-bench.exe`, `llama-completion.exe`, `llama-speculative-simple.exe`, plus DLLs `llama.dll, ggml.dll, ggml-base.dll, ggml-cpu.dll, mtmd.dll`, plus `CAPABILITIES.json` showing `qjl_full:true, turbo3/4/3_tcq:true, dflash:true, polarquant:true` and the fork commit `ce85787c`.
7. Install built artifacts to `C:\Users\Administrator\.eliza\local-inference\bin\dflash\<target>\` replacing the stale `spiritbuun/buun-llama-cpp@6575873e` binaries.
8. Sanity check on this Zen4 host: `llama-bench.exe --model <any small gguf> --threads 12 --n-prompt 64 --n-gen 64` runs against both AVX2 and AVX-512 variants; expect AVX-512 to win.

**Done when:** Four Windows binary sets exist (avx2-cpu, avx512-cpu, cuda, vulkan); both CPU variants pass `llama-bench` on this host; `qjl_full:true` and current fork commit confirmed in each `CAPABILITIES.json`.

---

### STREAM 2 — Kernel verification & Windows fixture-parity gate

**Owner:** one agent. Estimated effort: 2 days. **Depends on:** Stream 1.

**Reads:** `reports/windows-readiness/01-llama-cpp-kernels.md`.

**Tasks:**
1. Add a `windows-cpu-verify` Make target in `plugins/plugin-local-inference/native/verify/Makefile` that ports `gen_fixture --self-test`, `cpu_qjl_polar_attn_smoke`, and `qjl_mt_check` to MSVC + CMake-on-Windows.
2. Run `plugins/plugin-local-inference/native/verify/windows_runner.ps1 -Backend cpu -Model C:\models\eliza-1-smoke.gguf -Report evidence\platform\windows-x64-cpu.json` against a smallest-tier GGUF (download `eliza-1-0_8b-32k.gguf` from `huggingface.co/elizaos/eliza-1`).
3. Verify `kernel-contract.json` `platformTargets[windows-x64-cpu]` updates from `compile-only` / `needs-hardware` to `verified`.
4. Sweep `--threads` and `--threads-batch` via `llama-bench.exe` (4, 8, 10, 12) to pin the sweet spot for this 12-thread Zen4 box; record into `evidence/platform/windows-x64-cpu-threadsweep.json`.
5. Record this AMD EPYC 9684X as a new device class under `verify/evidence/platform/`.

**Done when:** `evidence/platform/windows-x64-cpu.json` exists with PASS status across `turbo3/turbo4/turbo3_tcq/qjl/polar` + `dflash`; AVX-VNNI dispatch confirmed via dispatcher logs.

---

### STREAM 3 — Windows environment prereqs (FOUNDATION, blocks S4)

**Owner:** one agent. Estimated effort: 0.5 day.

**Reads:** `02-voice-asr-tts.md`, `05-plugin-vision.md`.

**Tasks:**
1. Install `ffmpeg`, `ffplay`, `sox` via winget on this host. Confirm `where ffmpeg ffplay sox` resolves.
2. Document this as a Windows prereq in `docs/windows-setup.md` (new file) and `docs/voice-interactive.md`. Add a preflight check in `packages/app-core/scripts/voice-interactive.mjs` that fails loud if ffmpeg is missing.
3. Replace every `wmic` invocation with `Get-CimInstance` (Win11 26200 compat). Targets:
   - `plugins/plugin-vision/src/screen-capture.ts:57-62`
   - `plugins/plugin-vision/src/workers/screen-capture-worker.ts:144-167`
   - `plugins/plugin-vision/src/tests/e2e/vision-worker-tests.ts:298-302`
4. Fix `process.env.HOME ?? "/tmp"` to `os.homedir()` and use `os.tmpdir()` for temp screenshot files:
   - `plugins/plugin-vision/src/ocr-service-rapid.ts:89-95`
   - `plugins/plugin-vision/src/yolo-detector.ts:173-179`
   - `plugins/plugin-vision/src/face-detector-mediapipe.ts:96-102`
   - `plugins/plugin-vision/src/screen-capture.ts:79`
   - `plugins/plugin-vision/src/workers/screen-capture-worker.ts:259-262`
   - `plugins/plugin-vision/src/service.ts:1851-1855`
5. Replace `powershell -Command "<inline>"` with `spawn("powershell", ["-NoProfile","-NonInteractive","-EncodedCommand", base64(script)])` to defuse quoting bugs (same files as item 3).
6. Fix the hardcoded `Microphone (Realtek(R) Audio)` mic name in `plugins/plugin-local-inference/src/services/voice/mic-source.ts:167` and `plugins/plugin-vision/src/audio-capture.ts:85-89` — auto-detect default dshow audio device via `ffmpeg -list_devices true -f dshow -i dummy` parsing, or accept env override.

**Done when:** ffmpeg/ffplay on PATH; no `wmic` references in vision plugin; no `process.env.HOME ?? "/tmp"` strings; no hardcoded Realtek mic name.

---

### STREAM 4a — Voice end-to-end on Windows

**Owner:** one agent. Estimated effort: 2 days. **Depends on:** Stream 3.

**Reads:** `02-voice-asr-tts.md`.

**Tasks (in order from research report §7):**
1. Run `bun run voice:interactive -- --platform-report` and `bun run voice:interactive -- --list-active` — capture diagnostics.
2. TTS-only paths in priority order:
   - `plugin-edge-tts` (no key) — must work.
   - `plugin-omnivoice` — build `omnivoice.dll` via `plugins/plugin-local-inference/native/build-omnivoice.mjs`; stage speech GGUFs.
   - Kokoro-82M ONNX — requires fused `libelizainference.dll` + an `eliza-1-2b` bundle.
   - Renderer-side `SpeechSynthesis` + ElevenLabs streaming via `/api/tts/cloud`.
3. ASR paths:
   - Browser Web Speech API (Edge WebView2) — verify in dev build.
   - Cloud ASR via env keys when present.
   - Fused Qwen3-ASR via `libelizainference.dll` — depends on bundle staged in Stream 8.
4. Full loops:
   - `bun run voice:interactive -- --say "hello"` (LLM→TTS→speaker).
   - `bun run voice:interactive -- --wav fixture.wav` (mic→VAD→ASR→LLM→TTS→speaker on file).
   - `bun run voice:interactive` with real mic.
5. Write a Windows-only Playwright e2e in `packages/app/test/ui-smoke/voice-windows.e2e.spec.ts` that asserts the renderer mic permission flow plus a real `/api/tts/cloud` round trip.

**Done when:** Every TTS engine + every ASR engine ticked off in `02-voice-asr-tts.md` §7; one Playwright spec covers the renderer path.

---

### STREAM 4b — Vision end-to-end on Windows

**Owner:** one agent. Estimated effort: 1.5 days. **Depends on:** Stream 3.

**Reads:** `05-plugin-vision.md`.

**Tasks:**
1. Install `onnxruntime-node` under `plugins/plugin-vision/` (currently absent). Confirm first-run model download for `RapidOCR` works.
2. Provide a Tesseract `tessdata` cache + offline `langPath` (`plugins/plugin-vision/src/ocr-service-real.ts:30-39`) so first-run does not silently hang on offline hosts.
3. Either auto-download or document the `face-api.js` weights into `plugins/plugin-vision/models/face-api/` (`face-recognition.ts:67`); throw a friendly error if absent.
4. Add a Windows-only e2e in `plugins/plugin-vision/src/tests/vision-windows.e2e.test.ts`: takes a fixture PNG → `OCRService.extractText` (Tesseract chain) → asserts substring; runs `ScreenCaptureService.captureScreen` → asserts PNG bytes returned.
5. Rename or replace `florence2-local.ts` — current implementation is MobileNet + canned strings labelled as Florence-2. Either wire real Florence-2 ONNX or drop the misleading name.
6. Add DirectML execution-provider switch (`executionProviders: ["dml","cpu"]`) gated by env for YOLO/RapidOCR/MediaPipe.
7. Replace `Microsoft.Photos.exe` cleanup in `vision-worker-tests.ts:349-352` (Photos was replaced by Media Player in recent builds).

**Done when:** Fixture-PNG OCR e2e passes on Windows; screen capture returns valid PNG; RapidOCR initializes without writing to `/tmp/.milady/`.

---

### STREAM 5 — Finish the YOLO / Sandbox mode wiring

**Owner:** one agent. Estimated effort: 1.5 days. **Depends on:** Stream 0.

**Reads:** `06-sandbox-yolo-modes.md`.

**Tasks:**
1. Use Stream 0's plugin tagging to make `local-yolo` the unrestricted dev default and `local-safe` route every shell/PTY/CDP through `SandboxManager`.
2. UI sweep: hide unsandboxed plugins from the action catalog provider (`packages/core/src/generated/action-docs.ts`), connectors list (`packages/shared/src/contracts/onboarding.ts`), and settings panels when `isStoreBuild()`.
3. Audit the four `eval`/`new Function`/`vm.runIn` sites flagged in `07-windows-store-compat.md` §3 (`packages/core/src/utils.ts`, `packages/core/src/features/advanced-capabilities/personality/services/character-file-manager.ts`, `packages/app-core/src/runtime/mobile-safe-runtime.ts`, `packages/app-core/platforms/electrobun/src/rpc-handlers.ts`). For each: prove inputs are static or gate behind `!isStoreBuild()`.
4. Per-conversation runtime warning UI when a denied capability is requested (broker audit log → toast).
5. Add an `ELIZA_RUNTIME_MODE=local-safe` integration test that exercises a shell-using plugin and asserts the SandboxManager intercept.

**Done when:** All three modes (`cloud` / `local-safe` / `local-yolo`) demonstrably gate the right plugins; broker audit JSONL emits deny events for store profile attempts.

---

### STREAM 6 — Windows Store / MSIX compliance (plumbing only; submission gated on Partner Center)

**Owner:** one agent. Estimated effort: 3 days. **Depends on:** Stream 0.

**External blocker:** Microsoft Partner Center registration not yet started. Every task below is in scope; only the final `makeappx pack`-for-submission step waits on Partner Center returning Identity/Publisher values.

**Reads:** `07-windows-store-compat.md`.

**Tasks (P0 + P1 from the report's §9):**
1. Plumb store-build plugin exclusion through the bundler. Add `plugins.json` filtering keyed on `ELIZA_BUILD_VARIANT=store`; the exclusion list is whatever Stream 0 tagged `requiresUnsandboxed:true`. Exclude `app-polymarket` separately (11.14 gambling).
2. Hard-error at runtime if `resolveRuntimeExecutionMode()` returns anything but `cloud` when `ELIZA_BUILD_VARIANT=store` (`packages/shared/src/config/runtime-mode.ts`).
3. Extend `packages/app-core/packaging/msix/build-msix.ps1` with a `signtool sign` loop over every `*.dll`, `*.node`, `*.exe` under `$msixStaging` before `makeappx pack`. Use the same Azure Trusted Signing identity as the launcher.
4. Drop dev-only `node_modules` from the runtime bundle: `@nomicfoundation/*`, `@swc/*`, `@rolldown/*`, `@oxc-*`, `lightningcss-*`. Edit `runtimeBundleNodeModulesDir` allowlist in `electrobun.config.ts`.
5. **Keep identity env-driven.** `AppxManifest.store.xml` and `store/listing.json` already source from `ELIZA_MSIX_IDENTITY_NAME` / `ELIZA_MSIX_PUBLISHER_ID` / `ELIZA_MSIX_PUBLISHER_DISPLAY_NAME`. Verify this is wired end-to-end and that a missing env var produces a clear `MSIX_IDENTITY_NOT_PROVISIONED` build error rather than shipping placeholders. Submission step blocks until Partner Center provides values.
6. Add 11.16 live-AI disclosure: in-listing description block, Partner-Center "Notes for certification" entry stub (text-only, ready to paste once submitting), in-app "Report content" button on AI outputs.
7. Audit `plugins/plugin-video/src/services/binaries.ts` — if it downloads ffmpeg.exe at runtime, either bundle a signed copy or exclude from store.
8. Tighten `Capabilities` in `AppxManifest.store.xml` — only declare `microphone`/`webcam` if voice/vision features actually ship in store build; otherwise omit (10.6 finding).
9. Add CI step: run WACK (`appcert.exe`) against the staged MSIX (with placeholder identity), fail on findings other than the expected `IDENTITY_NOT_PROVISIONED`.
10. Validate `xmllint --noout` on both manifests in CI.
11. **Both AVX2 and AVX-512 binary sets ship in the same MSIX** (per Stream 1 + Stream 10's micro-arch dispatcher). Verify both pass WACK.
12. **Computeruse can ship in store builds** if a sandbox provider is selected (per Stream 7b). Gate the store-build inclusion of plugin-computeruse on `requiresSandboxProvider:true` so it loads but defaults to `cloud` provider with `windows-sandbox` and `docker` available via Settings.

**Done when:** A store-variant MSIX builds clean on this host with placeholder identity, every internal PE is signed, WACK passes (modulo identity), AppContainer launch succeeds, plugin exclusion verified by `dumpbin` showing no `node-pty` / `libnut` / `ngrok` binaries in the package. Submission-ready the moment Partner Center returns identity.

---

### STREAM 7a — Computeruse parity primitives (host driver)

**Owner:** one agent. Estimated effort: 3–4 days. (Independent.)

**Reads:** `04-computeruse-vs-trycua.md`, plus the trycua source for cross-checking: `https://github.com/trycua/cua/tree/main/libs/python/computer-server/computer_server/handlers/windows.py` and `https://github.com/trycua/cua/tree/main/libs/python/computer/computer/interface/windows.py`.

**Tasks (highest-value subset from §6 first patch suggestion):**
1. Fix `plugins/plugin-computeruse/src/platform/windows-list.ts:556-559` — replace destructive `Stop-Process` close with `PostMessageW(hwnd, WM_CLOSE, 0, 0)`. Switch enumeration at `:210-226` from PID-keyed to HWND-keyed via `EnumWindows`/`GetWindowText`. Update focus/move/show paths to take HWND.
2. Add primitives — `mouse_down`/`mouse_up`/`key_down`/`key_up`/`get_cursor_position`/`find_element` to `useComputerAction` enum (`src/actions/use-computer.ts:125-139`) and `ComputerUseService.executeDesktopAction` (`src/services/computer-use-service.ts:324`). Wire to existing nut-js `pressButton`/`releaseButton`/`pressKey`/`releaseKey`.
3. New `src/platform/clipboard.ts` with cross-OS get/set. Surface as `COMPUTER_USE_CLIPBOARD_GET/SET`. Re-enable clipboard pass-through in `toComputerUseActionResult`.
4. Rewrite `WindowsAccessibilityProvider.snapshot` (`src/scene/a11y-provider.ts:396`) to walk `TreeWalker.ControlViewWalker` depth-first with depth cap; emit `AutomationId`, `ControlType.ProgrammaticName`, `Name`, `IsEnabled`, `IsKeyboardFocusable`, `HelpText`, `BoundingRectangle`, parent id. Add `findByQuery(role?, name?)` used by `find_element`.
5. Add `resize` and `get_bounds` to WINDOW action (`src/actions/window.ts:24`).
6. Add Anthropic computer-use tool adapter at `src/actor/adapters/anthropic-cu.ts` translating Claude's `computer_20250124` actions to `DesktopActionParams`.
7. Add MCP server surface at `src/routes/mcp-server.ts` proxying `ComputerUseService.executeCommand`.

**Done when:** Primitive parity matrix in `04-computeruse-vs-trycua.md` §2 turns G1–G8 from N/P → Y; window close is non-destructive on Windows; HWND-keyed window IDs.

---

### STREAM 7b — Computeruse sandbox/VM providers (cross-platform)

**Owner:** one agent. Estimated effort: 5–7 days. **Depends on:** Stream 7a interfaces stable. **Reads:** `04-computeruse-vs-trycua.md`, trycua sources:
- `https://github.com/trycua/cua/tree/main/libs/python/computer/computer/providers/winsandbox` (Windows Sandbox provider)
- `https://github.com/trycua/cua/tree/main/libs/python/computer/computer/providers/docker` (Docker provider)
- `https://github.com/trycua/cua/tree/main/libs/python/computer/computer/providers/cloud` (Cloud provider)
- `https://github.com/trycua/cua/tree/main/libs/python/computer-server` (the in-VM agent server they ship into each sandbox)

**Goal:** Run `ComputerUseService` against three distinct execution targets — local host (today), Windows Sandbox, Docker container, eliza-cloud VM — using the same action API. Skip Lume (Mac-only; not portable to PC).

**Tasks:**
1. Define an `ExecutionTarget` abstraction in `plugins/plugin-computeruse/src/sandbox/target.ts`. Verbs: `start()`, `stop()`, `screenshot()`, `executeCommand(DesktopActionParams)`. The existing local in-process driver is the default implementation.
2. **Windows Sandbox provider** (`src/sandbox/windows-sandbox-provider.ts`):
   - Template a `.wsb` file mapping a known-port loopback bridge, mounting the eliza-bridge agent binary read-only, mapping shared media folder.
   - Spawn via `WindowsSandbox.exe <config>.wsb`.
   - Inside the sandbox, run a minimal bridge server (`src/sandbox/bridge-server/`) that re-implements `ComputerUseService` actions and listens on the bridge port.
   - Host-side `WindowsSandboxTarget` translates `executeCommand` to JSON-RPC over the bridge.
   - Requires Win Pro/Enterprise; surface this requirement in capability detection.
3. **Docker provider** (`src/sandbox/docker-provider.ts`):
   - Reference `Dockerfile` building an Ubuntu base + Xvfb + Xfce + the eliza-bridge server. Publishes loopback bridge port.
   - Spawn via `docker run` with `--security-opt`, `--cap-drop`, `--rm`. On Windows, requires Docker Desktop or WSL2.
   - Same JSON-RPC contract as Windows Sandbox.
   - This is the *primary* sandbox option for Mac and Linux users; Windows users can use either.
4. **Cloud provider** (`src/sandbox/cloud-provider.ts`):
   - Thin client that issues a `POST /api/v1/computeruse/session` to an eliza-cloud control endpoint (define the endpoint shape; coordinate with `cloud/` package owners).
   - Receives a remote bridge URL + auth token; same JSON-RPC contract over HTTPS.
   - Defer the server-side cloud-VM pool itself; this stream lands the client + protocol only.
5. **Bridge agent** (`src/sandbox/bridge-server/`):
   - Single TypeScript binary (or python script, mirroring trycua) that re-uses `plugins/plugin-computeruse/src/platform/*` modules and serves JSON-RPC.
   - Bundled into the Docker image and copied into the WSB shared folder.
6. **UI surface**: Add a sandbox-mode picker to the computeruse settings panel — `local` (default) / `windows-sandbox` (Windows only) / `docker` (everywhere) / `cloud` (eliza-cloud).
7. **Store-build interaction**: In `requiresUnsandboxed:true` plugin gating, allow plugin-computeruse if the user has selected a sandbox provider. Bridges this stream to Stream 0/6 — opens a path to ship limited computeruse in the store build via cloud sandbox.

**Done when:** Demo flow — open Eliza on Windows, enable computeruse with `windows-sandbox` provider, agent clicks around inside the sandbox not the host; same demo with `docker` provider succeeds; cloud provider returns "not yet provisioned" with a clear message but the protocol path is wired.

---

### STREAM 8 — DFlash drafters: train, publish, validate

**Owner:** one agent (training pass runs in background on Linux+CUDA host; validation runs on this Windows VM). Estimated effort: 3–4 days. **Depends on:** Stream 1 (for Windows validation half).

**Reads:** `09-dflash-and-models.md`, `packages/training/scripts/HF_PUBLISHING.md`, `packages/training/scripts/distill_dflash_drafter.py`.

**Tasks (parallel sub-tracks):**

**8a — Drafter training & HF publishing (on Linux+CUDA box):**
1. Audit `huggingface.co/elizaos/eliza-1` and list which tiers under `bundles/<tier>/dflash/` already have published drafters vs which are missing.
2. For each missing tier, run `packages/training/scripts/distill_dflash_drafter.py` distilling a Qwen3.5 drafter against the matching text-tier teacher (`0_8b`, `2b`, `4b`, `9b`, `27b`, `27b-256k`, `27b-1m`).
3. Validate each output against `manifest/manifest-dflash-eval.test.ts` gates — acceptance-rate ≥ contractual minimum.
4. Reconcile catalog naming drift (`0_6b`/`1_7b` vs `0_8b`/`2b`) before publishing — `packages/shared/src/local-inference/catalog.ts` is canonical; update PLATFORM_MATRIX, RELEASE_V1, `docs/eliza-1-dflash-catalog-fragment.md`, and the distill script to match.
5. Publish each drafter to `huggingface.co/elizaos/eliza-1/bundles/<tier>/dflash/drafter-<tier>.gguf` via the HF_PUBLISHING runbook (signed commits, LICENSE.dflash bundled, README updated).
6. Cut a manifest version bump in `plugins/plugin-local-inference/src/services/manifest/eliza-1.manifest.v1.json` exposing the new drafters.

**8b — Windows validation (on this VM, after 1 has shipped):**
7. Stage the `eliza-1-0_8b` bundle on this Windows host: `~/.eliza/local-inference/models/eliza-1-0_8b.bundle/{text,dflash,asr,vad,tts/kokoro}/`. Pull from the HF mono-repo.
8. Spawn live DFlash llama-server end-to-end via `plugins/plugin-local-inference/src/services/dflash-server.ts` against the 0_8b bundle: verify `/health`, `/completion`, and that `dflashVerify` SSE events fire.
9. Run all JS tests in `plugins/plugin-local-inference/src/services/` under `bun test` on Windows. Capture which (if any) fail on win32; fix path-separator / spawn / file-locking issues.
10. Run `tsx plugins/plugin-local-inference/native/verify/asr_bench.ts` on Windows.
11. Kokoro TTS smoke: load `tts/kokoro/model_q4.onnx` through `onnxruntime-node` on Windows; synthesize "hello world" → WAV.
12. Record metrics: tokens/sec decode, prefill, DFlash acceptance rate (`n_drafted_accepted_total / n_drafted_total`). File evidence under `verify/evidence/platform/windows-x64-cpu-dflash.json`.

**Done when:** Every tier in `catalog.ts` has a published drafter on HuggingFace. A live llama-server runs the smallest tier with DFlash speculative decoding on Windows CPU. All relevant JS tests pass on win32. Kokoro TTS smoke produces audio bytes. Catalog naming drift resolved across all docs.

---

### STREAM 9 — Streaming reliability fixes

**Owner:** one agent. Estimated effort: 1.5 days. **Depends on:** Stream 1 (needs llama-server to validate locally).

**Reads:** `10-response-streaming.md`.

**Tasks (P0 + P1 from the report):**
1. Wrap `JSON.parse(data)` in `plugins/plugin-local-inference/src/services/dflash-server.ts:2125` (and the trailing flush at `:2241-2242`) in try/catch.
2. Detect cloud-provider non-streaming responses when `stream:true` was requested — log a warning and emit a synthesized one-chunk stream so UX does not silently degrade (`packages/core/src/runtime.ts:4654`).
3. Wire `args.signal.addEventListener('abort', () => abi.eliza_inference_llm_stream_cancel(handle))` in the bun:ffi adapters where mobile FFI cancel is missing. Add a regression test.
4. Honor `res.write` backpressure in `writeChatTokenSse` (`packages/agent/src/api/chat-routes.ts:811`): when it returns `false`, `await` the `'drain'` event.
5. Add `flushSync` or `requestAnimationFrame` batching in `applyStreamingTextModification` (`packages/ui/src/state/useStreamingText.ts:134`) so we do not setState per token when bursts exceed one frame.
6. Send a synthetic `: starting\n\n` heartbeat at request acceptance time so the 60s idle timeout resets after queue wait.
7. Wire `packages/app-core/scripts/streaming-pipeline-bench.ts` as a CI perf gate (first-token latency, mean inter-token interval, total-tokens-per-second).

**Done when:** Streaming-bench passes against the live llama-server from Stream 1; P0+P1 fixes have unit/integration coverage; AbortController teardown verified end-to-end.

---

### STREAM 10 — Build & runtime optimizations (+ micro-arch dispatcher)

**Owner:** one agent. Estimated effort: 2 days. (Independent.)

**Reads:** `08-windows-optimizations.md`.

**Tasks (top of impact list, omitting items already in Stream 1):**
1. `package.json:78,89,91` — drop `--concurrency=1` to `--concurrency=75%`. Cap to 6 if OOMs appear under typecheck.
2. `packages/core/build.ts:73` — default `minify: process.env.NODE_ENV !== "development"`; enable `treeShaking`. Verify `__bundle_safety_*` arrays survive.
3. Renderer chunk-by-feature in `packages/app/vite.config.ts`: split xterm, lazy-load pglite WASM/data behind dynamic import.
4. Strip duplicate splash images in `packages/app/dist/splash-bg.{jpg,png}` — keep one optimized JPG.
5. Move `three/examples/jsm/loaders/FBXLoader.js`, `DRACOLoader.js` out of vite `optimizeDeps.include`.
6. `build.ts` accept `dropDebug = NODE_ENV === "production"` → pass to bun bundler `drop: ["console.debug", "console.trace"]`.
7. For `GOOD` tier CPU-only Windows, bias quant choice to `IQ4_XS` over `Q4_K_M` in `device-tier.ts:43-73`; add a perplexity smoke gate in `local-inference-ablation.mjs`.
8. Add Windows-CPU device-tier policy in `device-tier.ts` pushing `cacheTypeK="q8_0", cacheTypeV="q8_0"` for `OKAY`/`GOOD` tiers; `qjl1_256/tbq3_0` for `MAX` long-context.
9. Wire DFlash draft model into `services/active-model.ts` for Windows desktop GOOD+ tier (pair primary with 0.5B-1B drafter at IQ3_XXS).
10. **Runtime micro-arch dispatcher.** Add `packages/shared/src/local-inference/cpu-features.ts` with a CPUID probe (use `os.cpus()[0].model` + the `cpu-features` npm or a tiny native add-on) returning `{ avx512: bool, avx_vnni: bool, baseline: "avx2" | "avx512" }`. At engine startup in `plugins/plugin-local-inference/src/services/engine.ts`, pick the correct binary set under `bin/dflash/windows-x64-cpu-{avx2,avx512}/` based on the probe. Log the selection. This is what makes the two-build MSIX strategy seamless to the end user.
11. Both binary sets bundled into the MSIX via `runtimeBundleNodeModulesDir` in `electrobun.config.ts`; verify the bundle does not double-ship duplicate `ggml-base.dll` across the two variants (different folders are fine, naming collisions are not).

**Defer:** Native WebView2 build variant (item 8 in report) — feature-flagged, larger scope.

**Done when:** `bun run build` time drops materially on this 12-core; minified core dist; renderer first-paint improvement measurable; perplexity gate green for new quant defaults; CPUID dispatcher selects AVX-512 binary on this Zen4 host at startup; same MSIX runs correctly on an AVX2-only test host (or equivalent stub via env override).

---

### STREAM 11 — Integration capstone: end-to-end Windows chat with 4B model

**Owner:** one agent. Estimated effort: 1 day. **Depends on:** Stream 1, Stream 3, Stream 5/6 mostly done.

**Reads:** `03-windows-build.md`.

**Tasks:**
1. Fix or delete stale `packages/app-core/scripts/build-win.mjs` and `dev-win.mjs` (reference old `apps/app` layout).
2. Implement first-run preflight in `packages/app-core/scripts/desktop-build.mjs` (or a startup hook in the agent) that auto-downloads `eliza-1-2b` GGUF on first launch if `~/.eliza/local-inference/models/` is empty.
3. Fix the `Cannot find module './'` for `@types/react/jsx-dev-runtime.d.ts` blocking `app-training` registration on Windows (`dev-desktop.out.log:4806`).
4. Fix `@orca-so/common-sdk` → `@noble/hashes/sha2` Windows subpath-exports issue blocking `app-steward` (`dev-desktop.out.log:4805`).
5. Investigate `bigint-buffer` pure-JS fallback on Windows (`dev-desktop.out.log:4742`) — install prebuild or document.
6. Run the documented Windows build procedure from `03-windows-build.md` §"Step-by-step" end-to-end on a clean checkout.
7. Type a message in the launched app; assert a streamed reply arrives from the local 4B model.
8. Sign the Inno installer via `sign-windows.ps1`; package via `build-inno.ps1`.

**Done when:** A clean `bun install` → `bun run dev:desktop` → "Hello" produces a streamed local reply on this Windows host with `eliza-1-2b` (or 4B). Installer .exe produced and signed.

---

## D. Schedule (sequenced for max parallelism)

```
Day 0  : Streams 0, 1, 3, 7a, 10 start in parallel (all independent today)
         Stream 8a (drafter training) kicks off on Linux+CUDA box (long-running, background)
Day 1  : Stream 1 completes → Streams 2, 8b, 9 can start
         Stream 3 completes → Streams 4a, 4b can start
         Stream 0 completes → Streams 5, 6 can start
         Stream 7a hits its mid-point → Stream 7b can start in parallel with rest of 7a
Day 2-4: Streams 2, 4a, 4b, 5, 6, 7a, 7b, 8b, 9, 10 in flight
Day 5  : Stream 11 (capstone) starts after S1, S3, S5/6 are mostly done; sandbox demo from S7b
Day 6  : Stream 11 finishes; full Windows demo; S8a drafter publishing wraps for slowest tiers
```

Total wall-clock: ~6 days with 11 parallel agents (S7 split into S7a + S7b, S8 split into S8a training and S8b validation). Single-developer serial path: ~4 weeks.

S7b (sandbox/VM providers) and S8a (drafter training) are the longest serial paths and should start earliest. S6 submission step blocks externally on Partner Center.

---

## E. What this plan does NOT cover

- **Mobile (iOS / Android):** Each report touched mobile briefly; mobile is intentionally out of scope here. Stream 9 includes mobile FFI cancel fix as a low-cost adjacent fix.
- **GPU validation:** This host has no GPU. CUDA, Vulkan, Metal, DirectML kernel evidence requires separate hosts. Stream 2 publishes the CPU evidence; Streams 1 and 8 ship the build flags that those other hosts need.
- **Linux / macOS Windows-Store equivalents:** Mac App Store and Play Store have analogous gating but each warrant their own pass.
- **Real Florence-2 / moondream / llava integration** in plugin-vision — flagged as `florence2-local` deception in 4b but the real-VLM port is its own project (Stream 4b only renames or stubs it honestly).
- **Sandbox/VM mode** for plugin-computeruse (Stream 7 explicitly defers Windows Sandbox / Lume / Docker providers as a follow-up).

---

## F. Resolved decisions (2026-05-14)

1. **GPU validation hosts.** A separate Linux+CUDA box is available — it owns `linux-x64-cuda` / `linux-x64-cuda-fused` evidence (and already has it per `PLATFORM_MATRIX.md`). **CUDA/Vulkan Windows evidence is still out of scope until a Windows+NVIDIA host is provisioned.** Stream 1 must still produce build artifacts for `windows-x64-cuda` and `windows-x64-vulkan` so they're ready for that future host; Stream 2 only records `windows-x64-cpu` evidence on this VM.
2. **Microsoft Partner Center not yet registered.** Stream 6 proceeds through every plumbing item (plugin exclusion, signtool loop, WACK pre-flight, manifest hardening, dev-tool removal, 11.16 disclosure UI). **Stop short of `makeappx pack`-for-submission** — leave the Identity/Publisher fields env-driven so the moment Partner Center returns identity values, a CI run can produce the final MSIX without code changes. Track the registration as an external blocker.
3. **Two-binary AVX dispatch.** Ship a single MSIX containing both an AVX2 baseline binary set and an AVX-512 binary set, with a runtime micro-arch dispatcher choosing at startup. This mirrors `node-llama-cpp`'s existing `ggml-cpu-haswell.dll` / `ggml-cpu-skylakex.dll` / `ggml-cpu-alderlake.dll` pattern. Stream 1 produces both; Stream 10 adds the runtime selector in `packages/app-core/scripts/build-llama-cpp-dflash.mjs` and a startup probe in the engine. The store sees one binary; the user's CPU picks the right DLLs. No separate listings.
4. **Computeruse must be sandboxable.** Stream 7 is upgraded — sandbox/VM providers are **in scope**, not deferred. trycua's Lume is Mac-only and not portable to Windows; the cross-platform providers we actually need are:
   - **Windows Sandbox** (built into Win Pro/Enterprise; thin `.wsb` template + loopback bridge)
   - **Docker / OCI container** (Linux + WSL2 on Windows; matches trycua's `docker` provider)
   - **Cloud** (managed remote desktop; matches trycua's `cloud` provider — likely a thin wrapper around an eliza-cloud-hosted VM pool)
   Lume is explicitly skipped. macOS users get Docker; Linux users get Docker; Windows users get Windows Sandbox or Docker. All three providers expose the same `BaseComputerInterface`-equivalent surface as in-process.
5. **DFlash drafters.** Use the published `Qwen3.5` distillation pipeline. If a tier's drafter is not yet on `huggingface.co/elizaos/eliza-1/bundles/<tier>/dflash/`, **train it and publish it**. Stream 8 expands to include:
   - Run `packages/training/scripts/distill_dflash_drafter.py` against each text tier (`0_8b, 2b, 4b, 9b, 27b, 27b-256k, 27b-1m`).
   - Validate each drafter via the existing `manifest/manifest-dflash-eval.test.ts` gate.
   - Publish to HuggingFace under `elizaos/eliza-1` (use `packages/training/scripts/HF_PUBLISHING.md` as the runbook).
   - This is the highest-leverage publishing task in the plan because every Windows tier validation depends on a drafter being downloadable.

---

## G. Plan deltas applied to the streams

- **Stream 1:** Now produces 4 Windows binary sets — `windows-x64-cpu-avx2`, `windows-x64-cpu-avx512`, `windows-x64-cuda`, `windows-x64-vulkan` (last two staged for the future GPU host). Add micro-arch tagging to `CAPABILITIES.json`.
- **Stream 2:** Only records `windows-x64-cpu` evidence on this VM (both AVX2 and AVX-512 variants on this Zen4 host).
- **Stream 6:** Submission-blocking items deferred until Partner Center registration. All other compliance work in scope.
- **Stream 7:** Expanded scope. Add `src/sandbox/{windows-sandbox,docker,cloud}-provider.ts`. Each provider exposes the same `ComputerUseService` interface over a local IPC bridge (TCP loopback or MCP) into the sandboxed environment. Estimated effort grows from 3–4 days to 5–7 days; consider splitting into S7a (parity primitives — original brief) and S7b (sandbox providers — new).
- **Stream 8:** Expanded scope. Add a drafter training + HF publishing pass. Run on the Linux+CUDA box (Stream 8 brief now requires coordination with that host). Estimated effort grows from 2 days to 3–4 days, with drafter training in the background.
- **Stream 10:** Add the runtime micro-arch dispatcher (probe CPUID at engine startup; load AVX-512 DLLs when supported, else AVX2). Mirror `node-llama-cpp`'s pattern.
