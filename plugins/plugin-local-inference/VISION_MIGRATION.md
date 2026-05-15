# Vision migration: Florence-2 → Qwen3-VL via llama.cpp mmproj

## Decision

**Chosen VLM: Qwen3-VL family** (Qwen3.5-VL for the 0.8B–9B tiers,
Qwen3.6-VL for the 27B family), with the mmproj component shipped per
tier as `vision/mmproj-<tier>.gguf` and consumed by llama.cpp's `mtmd`
multimodal path (`--mmproj <path>` on `llama-server`, `llama-mtmd-cli`
for verification). Florence-2 (and the Transformers.js runtime that
hosted it) is removed.

## Why this VLM, not the alternatives

| Criterion                                  | Qwen3-VL                                                                 | LLaVA-1.6 / OneVision                                | MiniCPM-V                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------- |
| llama.cpp mmproj support                   | Native (`projector: qwen3vl_merger`, validated on Metal in `vision-smoke-9b-current-fix-20260513.json`) | Supported via LLaVA mmproj                           | Supported via `minicpmv_version` projector path            |
| Tokenizer / chat template alignment with eliza-1 base | Identical — eliza-1 *is* Qwen3.5/3.6                          | Distinct (Vicuna / Mistral templates)                | Distinct                                                   |
| Smallest tier viability (0.8B class)       | Qwen3.5-0.8B-VL: text 0.5 GB + mmproj ~220 MB Q4_K_M (per `ELIZA_1_BUNDLE_EXTRAS.json`) | LLaVA's smallest path is 7B; far too large for 0.8B  | MiniCPM-V 2.6 is ~8B; OK on 9B but blows the 0.8B floor    |
| OCR / screen content quality               | Qwen3-VL has dedicated OCR-and-document training; smoke shows correct screenshot caption ("A pixelated blue and white image of a person with glasses holding a cane.") | LLaVA's OCR is weaker than dedicated OCR training    | MiniCPM-V OCR is good but model size disqualifies on the floor |
| Mmproj weight already published / verifiable | Yes — `vision/mmproj-9b.gguf` (~875 MB Q8_0) is on disk and verified by `eliza1_vision_smoke.mjs` | Would need re-quantization                           | Same                                                       |

Qwen3-VL is the only option that satisfies all four hard constraints
(llama.cpp-supported mmproj GGUF, fits the 0.8B-class memory floor when
quantized Q4_K_M, OCR/screen-content quality at least equivalent to
Florence-2, and tokenizer/template parity with the existing eliza-1
text backbone). The smoke output in
`native/verify/vision-smoke-{9b,0_6b}-current-fix-20260513.json` confirms
the path runs end-to-end on Metal today; the missing-on-disk mmproj for
the 0.8B and 2B tiers is a publish task tracked in
`packages/shared/src/local-inference/catalog.ts` (see
`ELIZA_1_TIER_PUBLISH_STATUS` notes), not a runtime gap.

### Why not Florence-2

Florence-2 is a Transformers.js / ONNX-Runtime model. It does not run
through llama.cpp at all. Keeping it would mean keeping a second
inference engine resident (with its own kernels, model cache, and
threading model) only for IMAGE_DESCRIPTION. The mandate is that
llama.cpp is the *only* execution path for local inference, including
vision; Florence-2 is therefore deleted.

## Wiring overview

The wiring lives entirely against the existing `dflash-server` interface
(via `DflashLlamaServer`). The HTTP route is the `llama-server` `/completion`
endpoint with `image_data: [{ data, id }]`; the mmproj is loaded at
process spawn via `--mmproj <path>` (already implemented in
`services/dflash-server.ts` at the `args.push("--mmproj", mmproj)` site
and resolved from the catalog by `resolveMmprojPath` in
`services/active-model.ts`).

### Surface changes

1. `DflashLlamaServer` (services/dflash-server.ts) gains a
   `describeImage(...)` method that POSTs to its own `/completion`
   endpoint using the same `[img-N]` placeholder convention the
   `llama-server` vision backend already encapsulates in
   `services/vision/llama-server.ts`.
2. `BackendDispatcher` (services/backend.ts) exposes
   `describeImage(...)` so the IMAGE_DESCRIPTION provider handler can
   route through the dispatcher without knowing which concrete backend
   is loaded.
3. The `LocalInferenceRuntimeService.describeImage` call site in
   `provider.ts` is unchanged — it already prefers the WS2 arbiter
   path, then falls through to `service.describeImage`. With the
   dispatcher's new method present, that fallthrough lands on llama.cpp
   instead of Florence-2.
4. The Florence-2 `VisionManager` and its `describeImage` wrapper in
   `adapters/node-llama-cpp/index.ts` are deleted, along with the
   Florence-2 entries in `adapters/node-llama-cpp/types.ts` and the
   Transformers.js dependency.

### Forward-compatibility with the in-process FFI unification

A separate agent is unifying llama.cpp invocation behind a single FFI
that subsumes `dflash-server` and `node-llama-cpp` adapters. This
migration is built against the `DflashLlamaServer` HTTP interface today;
once the FFI lands, the `describeImage` implementation collapses into
the same FFI call the rest of `generate()` uses, and the
`createLlamaServerVisionBackend(currentBaseUrl())` adapter is replaced
by `loadNodeLlamaCppVisionBackend({ mtmd })`. Both paths terminate at
llama.cpp's mtmd encode + decode, so the swap is mechanical and the
arbiter wiring (`createVisionCapabilityRegistration`) stays identical.

## Image preprocessing

Qwen3-VL's CLIP loader (see `clip_model_loader` block in the smoke
output) handles the resize / normalization / token-merge in C++ as part
of the mtmd encode pass. The JS layer only forwards the raw image
bytes (PNG / JPEG) base64-encoded; we do not preprocess on the JS side.
This matches the `llama-server` `image_data` contract documented at the
top of `services/vision/llama-server.ts`.

## Memory budget

- Smallest tier (0.8B): text 512 MB + mmproj ~220 MB Q4_K_M = ~730 MB
  resident when both are loaded. Under arbiter pressure the projector
  evicts at the same `vision` resident-role priority the catalog
  already assigns (priority 20 in `SharedResourceRegistry`).
- 2B tier (default first-run): text 1.4 GB + mmproj ~361 MB Q8_0 =
  ~1.8 GB.
- 9B tier (validated): text 5.3 GB + mmproj ~875 MB Q8_0 = ~6.2 GB
  (matches the `minimumMappedWeightsGiB: 6.146` figure in the
  2026-05-13 smoke report).

## Verification

- Existing smoke: `node plugins/plugin-local-inference/native/verify/eliza1_vision_smoke.mjs` against the 9B bundle on Metal.
  Result already on disk (`vision-smoke-9b-current-fix-20260513.json`):
  pass, end-to-end image describe via `llama-mtmd-cli` + `mmproj-9b.gguf`.
- New unit/integration coverage added under
  `plugins/plugin-local-inference/__tests__/florence2-removed.test.ts`
  and `plugins/plugin-local-inference/__tests__/vision-llama-server-route.test.ts`.

## What this migration does not do

- No retraining of the mmproj — per `packages/training/AGENTS.md` §2,
  the vision projector is frozen unless the text backbone moves.
- No new fallback path. The Florence-2 fallback is gone; if mmproj is
  missing or llama.cpp's mtmd path returns an error, IMAGE_DESCRIPTION
  fails loudly. (Per the architecture commandments: no defensive
  fallbacks.)
