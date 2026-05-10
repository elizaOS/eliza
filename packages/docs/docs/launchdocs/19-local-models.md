# Launch Readiness 19: Local Models

## Second-Pass Status (2026-05-05)

- Current: `prefer-local` still chooses one provider and rethrows on generation failure despite routing-policy comments that imply fallback behavior.
- Still open: Hugging Face download preflight/allowlist checks are thin, Ollama import is still a no-op through app-training, local-only mode also disables non-text cloud services, and hardware fit is heuristic.
- Launch gate: add router fallback-on-error tests, strict local-text-vs-local-all mode tests, real GGUF smoke, and mobile device-bridge validation before claiming local models are complete.

Worker: 19  
Date: 2026-05-04  
Scope: local model runtime UX/settings, local-only mode, cloud APIs/RPC nuance, data cleaning/training/evals, Hugging Face model/data references, hardware optimization, model downloads, fallback routing, mobile/desktop implications.

## Current State

Eliza has a substantial local model subsystem in `packages/app-core/src/services/local-inference` plus HTTP routes, settings UI, desktop `node-llama-cpp`, mobile `llama-cpp-capacitor`, AOSP FFI hooks, device-bridge routing, Hugging Face search, resumable downloads, external model scanning, slot assignments, and cross-provider routing preferences.

The main app-core route surface is `packages/app-core/src/api/local-inference-compat-routes.ts`. It exposes hub, hardware, catalog, installed models, downloads with SSE progress, providers, routing preferences, assignments, device bridge status/stream, Hugging Face GGUF search, active model load/unload, verify, and uninstall endpoints (`local-inference-compat-routes.ts:107-590`).

Settings surface exists in `packages/app-core/src/components/settings/ProviderSwitcher.tsx` and `packages/app-core/src/components/local-inference/*`. The local provider panel renders `LocalInferencePanel` (`ProviderSwitcher.tsx:1038-1060`), and advanced "Model settings" render providers plus `RoutingMatrix` (`ProviderSwitcher.tsx:1299-1303`). `LocalInferencePanel` covers hardware, device bridge status, first-run download offer, active model bar, curated/search/download tabs, slot assignments, devices, discovered external models, verify, redownload, activate, and uninstall.

The curated local model catalog is GGUF-focused, Hugging Face-backed, and Eliza-1 only. It exposes the Eliza-1 lite, mobile, desktop, pro, and server tiers, with download URLs constructed from `hfRepo` + exact `ggufFile`, optionally via `ELIZA_HF_BASE_URL` mirrors.

Downloads are resumable and stream from Hugging Face into `$STATE_DIR/local-inference/downloads/<id>.part`, then atomically rename into the Eliza-owned model dir, hash the final file, register it, and auto-assign empty slots (`downloader.ts:1-15`, `downloader.ts:123-158`, `downloader.ts:198-311`). Installed model verification checks GGUF magic and SHA256 against the locally recorded hash (`verify.ts` inspected).

Hardware sizing exists but is heuristic. `probeHardware` tries `node-llama-cpp` for GPU backend/VRAM and otherwise falls back to OS memory; bucket recommendation uses Apple Silicon shared memory and VRAM/system-RAM heuristics (`hardware.ts:1-10`, `hardware.ts:81-145`, `hardware.ts:155-170`).

Runtime routing is unified through a top-priority router. `ensureLocalInferenceHandler` can register AOSP native FFI, Capacitor, device bridge, or desktop `node-llama-cpp` loaders, then installs the router (`ensure-local-inference-handler.ts:335-460`). The router intercepts each model slot at `Number.MAX_SAFE_INTEGER`, reads policy/preferences, picks a provider, calls the chosen handler directly, and records latency (`router-handler.ts:1-23`, `router-handler.ts:121-165`, `router-handler.ts:177-198`). Policies include `manual`, `cheapest`, `fastest`, `prefer-local`, and `round-robin` (`routing-policy.ts:1-23`, `routing-policy.ts:153-210`).

Mobile support is real but only unit-validated here. `@elizaos/capacitor-llama` wraps `llama-cpp-capacitor`, loads GGUF paths with GPU layers, generates text, supports optional embeddings, and registers as `localInferenceLoader` (`capacitor-llama-adapter.ts:192-360`). The app starts a mobile device bridge in `cloud-hybrid` or `local` modes (`packages/app/src/main.tsx:779-835`). Mobile runtime boot gates local inference on `ELIZA_DEVICE_BRIDGE_ENABLED=1` or `ELIZA_LOCAL_LLAMA=1` (`mobile-local-inference-gate.ts:1-26`).

Training has both local-ish prompt optimization and cloud fine-tuning paths. The privacy filter redacts handles, privacy-level private contacts, credentials, and coordinates before export (`privacy-filter.ts:1-17`, `privacy-filter.ts:83-129`, `privacy-filter.ts:241-260`). `native` training is not model-weight fine-tuning; it runs local optimizer loops over JSONL datasets through runtime `useModel` and writes optimized prompts (`plugins/app-training/src/backends/native.ts:1-17`, `native.ts:73-190`). Dataset generation and Vertex orchestration require Anthropic/OpenAI teacher keys unless a training data path or roleplay input is provided (`training-routes.ts:581-620`, `training-routes.ts:981-1115`). Vertex tuning is explicitly Gemini/Google Cloud (`training-routes.ts:885-927`).

## Evidence

- Local-inference API: `packages/app-core/src/api/local-inference-compat-routes.ts:107-590`.
- Settings local provider UX: `packages/app-core/src/components/settings/ProviderSwitcher.tsx:654-681`, `ProviderSwitcher.tsx:1038-1060`, `ProviderSwitcher.tsx:1299-1303`.
- Model catalog and HF references: `packages/app-core/src/services/local-inference/catalog.ts:1-248`.
- Resumable download, progress, hash, auto-assignment: `packages/app-core/src/services/local-inference/downloader.ts:1-15`, `downloader.ts:123-158`, `downloader.ts:198-311`.
- Hardware probe/fit: `packages/app-core/src/services/local-inference/hardware.ts:81-170`.
- HF GGUF search: `packages/app-core/src/services/local-inference/hf-search.ts:149-235`.
- Runtime local loader registration: `packages/app-core/src/runtime/ensure-local-inference-handler.ts:335-460`.
- Router/policy: `packages/app-core/src/services/local-inference/router-handler.ts:121-165`, `packages/app-core/src/services/local-inference/routing-policy.ts:153-210`.
- Mobile adapter/device bridge: `packages/native-plugins/llama/src/capacitor-llama-adapter.ts:192-360`, `packages/app/src/main.tsx:779-835`, `packages/app-core/src/runtime/mobile-local-inference-gate.ts:1-26`.
- Training privacy/native/cloud split: `plugins/app-training/src/core/privacy-filter.ts:1-17`, `plugins/app-training/src/backends/native.ts:1-17`, `plugins/app-training/src/routes/training-routes.ts:581-620`, `training-routes.ts:885-927`, `training-routes.ts:981-1115`.

## What I Validated

Command:

```bash
bunx vitest run --config packages/app-core/vitest.config.ts packages/app-core/src/api/local-inference-compat-routes.test.ts packages/app-core/src/services/local-inference/routing-policy.test.ts packages/app-core/src/services/local-inference/routing-preferences.test.ts packages/app-core/src/services/local-inference/assignments.test.ts packages/app-core/src/services/local-inference/downloader.test.ts packages/app-core/src/services/local-inference/hardware.test.ts packages/app-core/src/runtime/mobile-local-inference-gate.test.ts
```

Result:

```text
Test Files  7 passed (7)
Tests       70 passed (70)
Duration    25.17s
```

Command:

```bash
bunx vitest run eliza/packages/native-plugins/llama/src/index.test.ts
```

Run from `/Users/shawwalters/eliza-workspace/milady` because the root Vitest include patterns are anchored with `eliza/...`.

Result:

```text
Test Files  1 passed (1)
Tests       5 passed (5)
Duration    677ms
```

Attempted command:

```bash
bunx vitest run --config packages/native-plugins/llama/vitest.config.ts packages/native-plugins/llama/src/index.test.ts
```

Result:

```text
Startup Error: Cannot resolve entry module packages/native-plugins/llama/vitest.config.ts
```

The plugin has no local `vitest.config.ts`; the subsequent root-pattern run above passed.

## What I Could Not Validate

- No real GGUF downloads, large-file hash passes, or interrupted download resumes. Those would be heavyweight.
- No real `node-llama-cpp` model load/generate on desktop GPU/CPU.
- No mobile device bridge end-to-end with an actual iOS/Android device.
- No AOSP `libllama.so` FFI load or Android thermal/battery behavior.
- No live Hugging Face search/download network call beyond code inspection; tests cover mocked/bounded paths.
- No Vertex tuning, teacher-model dataset generation, roleplay execution, or native optimizer quality evals.
- No full UI visual/browser validation of Settings -> Local provider due to task scope and time.

## Bugs And Risks

### P0

None found in the bounded review.

### P1

1. **`prefer-local` does not actually fall back after local failure.**  
   The policy docs say "try local first; if it fails ... fall through" (`routing-policy.ts:16-17`), but the router picks one provider and rethrows any handler error (`router-handler.ts:154-165`). If the assigned local model is corrupt, unloaded incorrectly, missing a native binding, times out, or device bridge is disconnected, a user on `prefer-local` can get hard failures instead of cloud/subscription fallback. This is a launch-risk mismatch between UX wording and behavior.

2. **Training "Import to Ollama" appears to be a no-op in the inspected service.**  
   `TrainingService.importModelToOllama` only finds a model and returns it; it does not create an Ollama Modelfile, call Ollama, copy/export an adapter, or validate a resulting local model (`plugins/app-training/src/services/training-service.ts:141-149`). The API route validates loopback `ollamaUrl` and calls this method (`training-routes.ts:449-477`), and docs/UI can imply a complete import/activation flow. If this is the production service path, the feature is not launch-complete.

### P2

1. **Local-only mode wipes all cloud service routing, including RPC/media/tts/embeddings.**  
   The Settings "Local only" button sets `cloud.enabled=false`, disables `inference`, `media`, `tts`, `embeddings`, and `rpc`, and sets `serviceRouting: null` (`ProviderSwitcher.tsx:654-681`). That is correct for strict offline mode, but the Cloud guide says users should be able to keep Cloud linked for RPC/media while local models handle LLM text (`docs/guides/cloud.md:261-275`, inspected). The UX lacks a local-inference-only option that preserves cloud RPC or wallet execution.

2. **Arbitrary HF ad-hoc specs have weak preflight limits.**  
   `POST /api/local-inference/downloads` accepts a whole `CatalogModel` spec from the client (`local-inference-compat-routes.ts:220-241`). The downloader sanitizes final filenames and requires sensitive-route auth, but there is no hard max size, disk-space check, license acknowledgement, repo allowlist, or HEAD preflight before streaming. A bad or stale HF result can still fill disk or surprise users with a huge file.

3. **"Fastest" policy cold-start behavior can prefer native priority, not measured health.**  
   The policy assigns untracked providers `Infinity` and falls back to priority tie-break (`routing-policy.ts:173-185`). There is no warmup/probe or success-rate penalty; failed calls record latency but are still only latency samples, so a fast failing provider can remain attractive for some policies.

4. **Desktop/mobile hardware fit is coarse.**  
   Hardware sizing has no thermal/battery, quant-specific KV-cache, context-size, disk-space, or mobile memory-pressure model. The hardware API may return CPU-only `os-fallback` when `node-llama-cpp` is absent and still recommend buckets from system RAM (`hardware.ts:91-106`). This is useful but not enough for launch claims like "runs on phones" without device-matrix evals.

5. **Embeddings are only locally registered when the active loader exposes `embed`.**  
   Desktop `node-llama-cpp` path registers text generation but not a desktop embedding handler unless a loader service has `embed` (`ensure-local-inference-handler.ts:429-457`). Local embedding plugin registry entries exist, but this local-inference hub does not by itself guarantee local vector search.

### P3

1. **Hugging Face search metadata is heuristic.**  
   Parameter count, category, min RAM, and chosen quant are inferred from names/tags and sibling filenames (`hf-search.ts:76-133`, `hf-search.ts:207-232`). Good enough for exploration, but search results should be labeled less authoritatively than curated catalog entries.

2. **Provider cost table will drift.**  
   `routing-policy.ts` hardcodes relative costs (`routing-policy.ts:52-80`). This is acceptable for rough order but should not power billing-adjacent decisions without current pricing data.

3. **Local-only wording may overpromise offline capability.**  
   The button says "Local only"; if no local model is downloaded/assigned or no backend is available, the user can still end up without working inference. The panel does surface model management, but the mode switch itself does not appear to block on readiness.

## Codex-Fixable Work

- Implement true fallback retry in `router-handler.ts`: for fallback-capable policies, attempt the selected provider, catch known provider/local errors, mark provider unhealthy for the request/window, and try the next eligible candidate. Add tests for local failure -> cloud/subscription fallback and manual-local -> no fallback.
- Add preflight to `Downloader.start`: HEAD/metadata fetch, size cap, free disk check, and clear error before streaming. Persist license/source metadata for HF ad-hoc downloads.
- Split Settings actions into "Strict local/offline" and "Use local inference for text" so users can preserve `serviceRouting.rpc`, media, or TTS when desired.
- Add local-readiness gating to "Local only": require installed+assigned model or explicit confirmation that chat may stop working.
- Add explicit desktop local embedding support or UI messaging that local-inference text models do not automatically provide local embeddings.
- Replace `TrainingService.importModelToOllama` no-op with a real import path or hide/mark as pending when only the stub service is active.
- Add route tests for download spec validation, local-only config preservation, router fallback-on-error, and active model assignment with missing file.

## Human Work Needed

- Decide product semantics for "local-only" vs "local inference with cloud RPC/media". This is a product/privacy policy decision, not just code.
- Validate model catalog licenses, sizes, and filenames against current Hugging Face repos before launch. The catalog explicitly depends on exact upstream filenames (`catalog.ts:4-7`).
- Define hardware support matrix and minimum acceptable latency/quality for desktop, Android, iOS, AOSP, and device-bridge modes.
- Decide whether ad-hoc HF downloads need license click-through, enterprise allowlists, or model safety labeling.
- Decide whether training should promise model-weight fine-tuning, prompt optimization, Vertex tuning, or Ollama import. Current code mixes these meanings.
- Run real-device thermal/battery/privacy QA for mobile local inference.

## Recommended Tests And Evals

- Router fallback eval: local model missing/corrupt/binding unavailable/generate timeout should fall back for `prefer-local`, `fastest`, and `cheapest`, but not for strict manual local.
- Local-only config tests: strict local disables all cloud routes; local-inference-only preserves `rpc`/media/TTS when selected.
- Download tests: HEAD size cap, disk-space failure, cancelled/resumed range request, checksum mismatch, invalid HF spec, stale catalog filename.
- Real GGUF smoke: smallest curated model download, activate, TEXT_SMALL/TEXT_LARGE generate, unload, verify, uninstall.
- Desktop performance: macOS Apple Silicon Metal, Windows CUDA/Vulkan/no-GPU, Linux CUDA/no-GPU; capture tokens/sec, memory, cold load time, failure messages.
- Mobile performance: iOS and Android with 360M/1B/3B models; measure startup, tokens/sec, app background/foreground, battery/thermal throttling, memory pressure.
- Device bridge e2e: remote agent + phone bridge reconnect, pending request persistence, auth/token rejection, disconnected timeout.
- Training privacy tests: secrets, handles, precise coordinates, and private contacts are redacted/dropped before exports.
- Training product tests: native optimizer over a tiny JSONL fixture; Vertex orchestration with mocked GCS/Vertex; real Ollama import once implemented.

## Changed Paths

- `launchdocs/19-local-models.md` only.
