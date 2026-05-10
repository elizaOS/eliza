# Larp / Stub / Unfinished-Item Inventory (baseline 2026-05-09)

This is the W2 verification checklist. Every item below was flagged as "looks
real but isn't", "promised but not plumbed", or "stub left behind by an earlier
sweep" by the Wave-0 audit subagents. After Wave-1/Wave-2 land, each item must
either be (a) genuinely implemented end-to-end or (b) explicitly removed.

Source audits (extracted from `/tmp/claude-1000/-home-shaw-milady-eliza/4b3bac68-b53d-4cf6-9d19-164ea09586c1/tasks/`):
- `audit-android-aosp` (a49591e328d1d7822)
- `audit-ios-macos-metal` (a13e70a33e16d3d95)
- `audit-gpu-kernels` (a56f0317a7de986f4)
- `audit-cpu-native-quant` (ab44a4069bc79f828)
- `audit-local-inference-ts` (a7357f42991b22cf2)
- `audit-kv-cache-128k-embedding` (a7324d3b1731c4bb8)
- `audit-dflash` (a8306cbd7ba76dcb8)
- `audit-prompt-caching` (aaf12088c04af0f79)

Confidence labels match the originating audit (HIGH / MED / LOW).

---

## A. Catalog / runtime metadata larps

### A1. "128k context" claims with no `contextLength` plumbing [HIGH]
Marketing strings claim 128k+ context, but until the audit landed, several
catalog entries had no `contextLength` field at all and no path to set
`n_ctx` past the loader's default.

- `packages/app-core/src/services/local-inference/catalog.ts` lines
  206 (`qwen2.5-coder-7b`), 485 (`deepseek-r1-distill-qwen-32b`),
  517 (`eliza-1-9b`), 531 (`eliza-1-27b`).
- The catalog now sets `contextLength: 131072` on these (verified in
  `catalog-coverage.md`); however four hidden DFlash drafters still have
  no `contextLength`:
  - `qwen3.5-4b-dflash-drafter-q4`
  - `qwen3.5-9b-dflash-drafter-q4`
  - `bonsai-8b-dflash-drafter`
  - `qwen3.6-27b-dflash-drafter-q8`
- Even with `contextLength` set, the desktop `node-llama-cpp` backend
  drops it on the floor — `engine.ts:169` calls
  `model.createContext({ sequences: poolSize })` with no `contextSize`.
- AOSP path (`aosp-llama-adapter.ts:844`) hard-codes
  `args.contextSize ?? readEnvInt("ELIZA_LLAMA_N_CTX", 16384)` — i.e.
  16k by default, not 128k.

W2 acceptance: every entry that advertises a long context must (a) have
`contextLength` set in the catalog and (b) have it threaded through to
`createContext({ contextSize })` on every backend.

### A2. `POST /api/local-inference/active` rejects KV-cache overrides [HIGH]
The route accepts only `{ modelId }` and silently drops any
`cacheTypeK` / `cacheTypeV` the caller sends.

- `packages/agent/src/api/compat-routes.ts:536-559` (per audit).
- `LocalInferenceLoadArgs.cacheTypeK / cacheTypeV` exist in the type
  (`active-model.ts:30-31`) but the route is the bottleneck.

W2 acceptance: route accepts overrides and the backend honors them, or
the field is removed from `LocalInferenceLoadArgs` entirely.

### A3. "TurboQuant KV-cache compression" advertised but desktop drops it [HIGH]
- `engine.ts:206-209` only consumes `useMmap`, `useMlock`,
  `flashAttention` from load args; `cacheTypeK` / `cacheTypeV` reach
  the function but never reach `node-llama-cpp` (the binding has no
  cache-type API today).
- The Bonsai and Qwen3-Coder catalog entries declare `kvCache`, so a
  desktop user opening these models gets fp16 KV silently — not the
  TBQ4_0/TBQ3_0 the catalog advertises.

W2 acceptance: either node-llama-cpp grows a cache-type knob (and we
wire it) or the catalog entry stops claiming TBQ on desktop.

### A4. Recommendation hardcoded ladders [MED]
- `recommendation.ts:29-130` are static per-platform lists. New models
  must be hand-edited into 6 ladders or they become unrecommendable.
- No VRAM gating: `assessCatalogModelFit()` (line 185) checks RAM and
  file size but never reads `hardware.gpu.totalVramGb`.

W2 acceptance: ladders generated from catalog metadata, or VRAM gating
added with a real fallback ("smallest fit"), not silent unrecommendable
status.

### A5. Downloader has no disk-quota pre-flight [MED]
- `downloader.ts` writes until ENOSPC; no warning or pre-check.

W2 acceptance: pre-flight check against `node:fs.statfs()` before
spawning the download, with a structured error (not silent fill).

### A6. No tokenizer-family validation in catalog test [MED]
- `catalog.test.ts:19-34` resolves drafter id but does not assert
  `target.tokenizerFamily === drafter.tokenizerFamily`.
- `tokenizerFamily` is now set on every catalog entry (verified in
  `catalog-coverage.md`), so the assertion is mechanically possible.

W2 acceptance: test asserts tokenizer-family match for every
DFlash target/drafter pair.

---

## B. Provider / slot larps

### B1. `TEXT_EMBEDDING` slot unimplemented in local provider [MED]
- `packages/app-core/src/services/local-inference/providers.ts:83-112`
  advertises only `TEXT_SMALL` and `TEXT_LARGE`.
- `backend.ts:72-95` and `aosp-llama-adapter.ts:68-71` already implement
  the embed interface but it is not wired into the provider contract.

W2 acceptance: the local provider exposes `TEXT_EMBEDDING` and routes
to the existing embed path on at least one platform end-to-end.

### B2. Streaming hard-disabled for DFlash [LOW]
- `dflash-server.ts:875` hard-codes `stream: false`.

W2 acceptance: either streaming is wired through SSE or the comment
gets a permanent reason.

### B3. `category: "tools"` on `hermes-3-llama-8b` with no tool slot [LOW]
- `catalog.ts:217` claims function-calling / JSON mode; provider has no
  matching slot.

W2 acceptance: either remove the misleading category or add a real
tool/structured-output slot.

---

## C. Plugin layout larps (W1-H scope)

### C1. `plugins/plugin-local-inference` is a re-export stub [HIGH]
- `plugins/plugin-local-inference/src/index.ts` is ~11 lines and re-exports
  `local-inference-routes` only. It is NOT the real inference engine.
- The actual engine lives under
  `packages/app-core/src/services/local-inference/`.

W1-H must: delete the plugin or fold its real responsibilities into
`packages/app-core`. knip already lists it under unused (see
`knip-scoped.txt`).

### C2. `plugins/plugin-local-ai` is legacy / unused [MED]
- ~43 KB index file; not registered by the runtime; knip flags multiple
  files (`index.browser.ts`, `index.node.ts`, `index.d.ts`,
  `generated/specs/specs.ts`, `utils/runtime_test.ts`) as unused.
- Declared unused dep `stream-browserify`, `uuid`.

W1-H must: delete or absorb. Same for the "embedding" twin (C3).

### C3. `plugins/plugin-local-embedding` partially dead [MED]
- knip flags `src/utils/runtime_test.ts` unused.
- Declared unused deps: `nodejs-whisper`, `stream-browserify`, `uuid`,
  `whisper-node` — the package leaks "speech-to-text" deps but only
  exposes a node-llama-cpp-backed embedder.
- Test coverage is `__tests__/smoke.test.ts` only ("module exports").
- Single backend, no fallback, no chunking — so claims of "production
  embeddings" are aspirational at best.

W1-H scope explicitly calls for deleting two of these three plugins;
the third needs honest scope reduction.

### C4. `packages/native-plugins/llama/src/web.ts` unused [LOW]
- knip flags it. Either it's a build artifact or genuine dead code.

### C5. `packages/native-plugins/shared-types.ts` unused [LOW]
- Same — knip flag, no consumer found.

### C6. Multiple `electrobun/src/index.ts` files unused [LOW]
- camera, canvas, desktop, gateway, location, screencapture, swabble,
  talkmode — knip flags every one.

---

## D. Service-layer larps

### D1. `services/local-inference/dflash-doctor.ts` flagged unused [MED]
- knip lists both
  `packages/app-core/src/services/local-inference/dflash-doctor.ts` and
  `packages/ui/src/services/local-inference/dflash-doctor.ts` as unused
  files. The audit (audit-dflash) confirmed the CLI command exists at
  `packages/app-core/src/cli/program/register.doctor.ts` — so knip is
  picking up the UI twin and possibly the entry path.

W2 acceptance: confirm whether the UI twin is dead, then delete it.
The app-core copy is wired and must stay.

### D2. `services/local-inference/index.ts` flagged unused [LOW]
- knip lists `packages/app-core/src/services/local-inference/index.ts`
  AND `packages/ui/src/services/local-inference/index.ts`. The UI side
  also shows `router-handler.ts` and `routing-policy.ts` as unused.

W2 acceptance: prune the UI duplicate or wire it through.

---

## E. Native libraries larps (W1-A, W1-B scope)

### E1. QJL CPU library: scalar+SIMD landed but never wired into libllama.so [HIGH]
- `packages/native-plugins/qjl-cpu/` is solid (audit-cpu-native-quant).
- But: NO `block_qjl1_256` GGML type, NO `GGML_OP_ATTN_SCORE_QJL`, NO
  `quantize_qjl1_256` / `dequantize_row_qjl1_256` symbols in the shipped
  libggml-base.so or libllama.so on android-arm64-cpu /
  android-arm64-vulkan / linux-x64-cpu / linux-x64-vulkan (verified —
  see `aosp-symbols-pre.txt`, zero matches for QJL keys).
- `aosp-llama-adapter.ts:858` references `qjl1_256` cache type but the
  code path can never load.

W1-A acceptance: post-W1 `aosp-symbols-pre.txt` diff must show new
QJL exports landing in libggml-base.so / libllama.so.

### E2. PolarQuant `block_q4_polar` (Q4_POLAR=45): scalar only, no GGML hook [HIGH]
- `packages/native-plugins/polarquant-cpu/` ships scalar implementation
  + Python GGUF converter; NEON/AVX2/llama.cpp integration explicitly
  deferred per its README.
- Catalog has no `block_q4_polar` entry; symbols absent in shipped libs.

W1-B acceptance: post-W1 symbol dump shows `quantize_q4_polar` /
`dequantize_row_q4_polar` / `GGML_TYPE_Q4_POLAR` in libggml-base.so.

### E3. TBQ3_0 / TBQ4_0 documented as shipped — but symbol dump says no [HIGH]
- `audit-android-aosp` says TBQ3/TBQ4 are "verified in shipped libs"
  per docs lines 54-65.
- Symbol dump (`aosp-symbols-pre.txt`) shows ZERO TBQ symbols across
  all four backends/architectures we have built locally
  (`~/.eliza/local-inference/bin/dflash/`).
- This either means (a) the locally cached libs are an older build
  predating TBQ, or (b) the docs claim is itself a larp.

W2 acceptance: either rebuild and verify TBQ symbols land, or correct
the docs.

### E4. `libeliza-llama-shim.so` not built locally [HIGH]
- `aosp-llama-adapter.ts` depends on
  `eliza_llama_context_params_set_type_k/v` from this shim.
- No `libeliza-llama-shim.so` exists under
  `~/.eliza/local-inference/bin/dflash/*/`.
- Therefore: any cache-type plumbing through the shim is currently
  unreachable on this dev box.

W1 acceptance: shim is built and staged for both arm64-v8a and x86_64
ABIs; symbol dump shows the setter symbols.

---

## F. GPU kernel larps (W1-D, W1-E scope)

### F1. Vulkan turbo3/turbo4/turbo3_tcq compute shaders: 0/8 PASS [HIGH]
- `local-inference/kernels/README.md:3-9` — "KNOWN-BROKEN".
- `local-inference/kernels/vulkan/turbo3.comp`, `turbo4.comp`,
  `turbo3_tcq.comp` are still callable via
  `ELIZA_DFLASH_PATCH_VULKAN_KERNELS=1` (default OFF).

W1-E acceptance: shaders pass against CUDA-generated fixtures (not
reference-C-generated stubs), or are deleted.

### F2. Metal turbo3/turbo3_tcq DRAFT, never run on hardware [MED]
- `local-inference/kernels/metal/turbo3.metal`, `turbo4.metal`,
  `turbo3_tcq.metal` — DRAFT marker.
- `patchMetalTurbo4` (build-llama-cpp-dflash.mjs:537) is always-on
  but routing to it is "likely still OFF in practice" per the audit.
- `patchMetalTurbo3Tcq` (line 718) is gated by
  `ELIZA_DFLASH_PATCH_METAL_TURBO3=1` (default OFF).

W1-D acceptance: kernels run on real Apple Silicon hardware, fixtures
regenerated from CUDA, gating env vars removed (or kernel deleted).

### F3. Verification fixtures generated from C reference, not CUDA [HIGH]
- `local-inference/kernels/verify/gen_fixture.c` notes:
  fixtures are stubs vs real CUDA. Any shader that "passes" them is
  not actually validated against CUDA output.

W1-D / W1-E acceptance: fixtures regenerated from real CUDA build and
checked into the repo (or the harness deleted, since stubs validating
against stubs is worse than nothing).

---

## G. DFlash larps

### G1. Acceptance-rate telemetry promised by `--metrics`, never scraped [MED]
- `dflash-server.ts:725-795` passes `--metrics` to llama-server.
- The adapter never scrapes `/metrics` or parses stderr for
  `n_drafted` / `n_decoded` counters.

W2 acceptance: metrics scraped + surfaced in the doctor report or the
UI; or the `--metrics` flag is removed.

### G2. AOSP DFlash adapter source landed, llama-server never built for arm64 [HIGH]
- `plugins/plugin-aosp-local-inference/src/aosp-dflash-adapter.ts` is
  370 lines of real implementation.
- `compile-libllama.mjs:635-645` cross-compiles llama-server but the
  resulting binary is NOT staged on this dev box (`~/.eliza/.../
  dflash/android-arm64-cpu/llama-server` does exist locally per the
  symbol dump prep, but the audit says May-5 hot-patch required for
  the bundle anyway, suggesting CI does not yet rebuild).

W2 acceptance: e2e validation script exercises DFlash on cuttlefish
end-to-end, not just probes binary existence.

### G3. `maybeRepairDflashDrafter` is now redundant for current pair [LOW]
- `dflash-server.ts:313-402` injects merges metadata. With Qwen3-0.6B
  drafter (matched vocab) this is a no-op.

W2 decision: keep as safety net (audit says yes), or remove if no
catalog pair will ever need it.

---

## H. iOS / macOS Metal larps

### H1. iOS Metal kernel integration is opaque [MED]
- `llama-cpp-capacitor` v0.1.5 prebuilt; we cannot inspect whether
  `-DGGML_METAL=ON` was used or whether DFlash symbols are present.
- `patchMetalTurbo4` / `patchMetalTurbo3Tcq` never apply to iOS — no
  iOS target in `SUPPORTED_TARGETS` (build-llama-cpp-dflash.mjs:39-50).

W1-D acceptance: either ship our own iOS framework via
build-llama-cpp-dflash.mjs, or document that the npm prebuilt is
fixed at vendor publish time.

### H2. iOS DFlash claim depends on undocumented native plugin method [MED]
- `ios-local-agent-kernel.ts:1202` sets `mobileSpeculative: true` etc.
- The native plugin `setSpecType()` is optional and not verified to
  exist in the shipped npm package.

W2 acceptance: feature-detect at runtime and surface a real
"DFlash unavailable on iOS" diagnostic if the method is missing.

### H3. iOS cache-type hints warn-and-continue if `setCacheType` missing [MED]
- `capacitor-llama-adapter.ts:467` warns when the plugin lacks
  `setCacheType`. Caller has no way to know whether KV compression
  is actually active.

W2 acceptance: surface the result back to the caller (boolean) or
fail closed.

---

## I. KV / prompt-cache larps

### I1. Cache key drops to "" on missing `promptCacheKey` [MED]
- `extractPromptCacheKey()` (cache-bridge.ts:235-242) returns `null`
  when the runtime forgets to populate `providerOptions.eliza
  .promptCacheKey`. Callers then fall back to `cacheKey=""` →
  `deriveSlotId("", parallel) = -1` (any-free-slot), i.e. cold prefill
  every turn.
- Audit notes this is "by design" but it is a silent regression vector:
  one missing call site and prefix reuse is gone.

W2 acceptance: log + counter when this fallback fires; or assert in
dev builds.

### I2. Disk slot eviction runs once at startup [LOW]
- `cache-bridge.ts:150-183` implements TTL eviction; called only from
  `dflash-server.ts:719` at server startup. No periodic sweep.

W2 acceptance: schedule periodic eviction (every 5 min?) or document
the disk-fill failure mode.

### I3. No conversation→session pinning [LOW]
- `ensure-local-inference-handler.ts:159-200` re-extracts cache key
  per request; LRU pool can evict an active conversation if N+1
  conversations have distinct keys.

W2 acceptance: explicit `openSession()/closeSession()` API with slot
reservation, or a documented "size `--parallel` to peak concurrency"
warning surfaced in the UI.

---

## J. Bench harness larps

### J1. Per-call cache-type override unsupported by API [HIGH]
- `scripts/benchmark/profile-inference.mjs` documents this in its
  header (lines 41-54): `POST /api/local-inference/active` reads
  cacheTypeK/V from the catalog only; per-load overrides require
  `ELIZA_LLAMA_CACHE_TYPE_K/V` env vars on the agent process.
- This is the same bug as A2 above, surfaced as a harness limitation.

W2 acceptance: same as A2.

---

## Summary

| Category | Items | High | Med | Low |
|---|---|---|---|---|
| A. Catalog / runtime metadata | 6 | 3 | 2 | 1 |
| B. Provider / slot | 3 | 0 | 1 | 2 |
| C. Plugin layout | 6 | 1 | 2 | 3 |
| D. Service layer | 2 | 0 | 1 | 1 |
| E. Native libraries | 4 | 4 | 0 | 0 |
| F. GPU kernels | 3 | 2 | 1 | 0 |
| G. DFlash | 3 | 1 | 1 | 1 |
| H. iOS / macOS Metal | 3 | 0 | 3 | 0 |
| I. KV / prompt cache | 3 | 0 | 1 | 2 |
| J. Bench harness | 1 | 1 | 0 | 0 |
| **Total** | **34** | **12** | **12** | **10** |
