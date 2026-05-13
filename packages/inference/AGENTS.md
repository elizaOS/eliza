# AGENTS.md — Eliza-1 inference (kernels + runtime)

This file is the canonical contract for any agent working on the Eliza-1
on-device inference stack. It applies to everything under
`packages/inference/`, the runtime under
`packages/app-core/src/services/local-inference/`, the dflash build hook
at `packages/app-core/scripts/build-llama-cpp-dflash.mjs`, and any
mobile/desktop bridges that consume the same artifacts.

The training-side companion is at [`packages/training/AGENTS.md`](../training/AGENTS.md).
Read both before changing anything that crosses the boundary (artifacts,
manifest, kernel ABI, GGML pin).

**Fork source.** The patched llama.cpp ships in-tree as a git submodule at
[`packages/inference/llama.cpp`](llama.cpp) — `elizaOS/llama.cpp @ v1.0.0-eliza`
(commit `08032d57`; `git submodule update --init --recursive`, which `bun install`
runs). This is the unified fork: TurboQuant (turbo3/turbo4/turbo3_tcq) + QJL
(`block_qjl1_256`, `GGML_OP_ATTN_SCORE_QJL`, `GGML_OP_FUSED_ATTN_QJL_TBQ`) +
PolarQuant (`block_q4_polar`, `Q4_POLAR=47`) + the eliza Metal/Vulkan/CUDA
kernels + DFlash spec-decode (`--spec-type dflash`, the `dflash-draft` GGUF arch)
+ the post-refactor `llama-server` (`server-task.cpp` / `server-common.cpp` with
`grammar_lazy` / `json_schema` / `response_format` / `prefill_assistant`), on
upstream b8198. Both build paths consume it: `build-llama-cpp-dflash.mjs`
(desktop/server/Windows/iOS) and `aosp/compile-libllama.mjs` (Android) default to
the submodule checkout. `ELIZA_DFLASH_LLAMA_CPP_REMOTE` / `_REF` (or `--cache-dir`
/ `--src-dir`) still force a standalone clone for fork bisects. (`v1.0.0-eliza` is
the same tree as the prior `v0.4.0-eliza` tag, re-tagged on the elizaOS rename. A
full rebase onto a recent upstream llama.cpp remains a **deferred** follow-up — not
a blocker for structured output (the b8198 base already has `grammar_lazy` /
`json_schema` / `response_format` / `prefill_assistant`); the conflict-prone files
are the quant-slot enums in `ggml-common.h` / `ggml.h` and the `Q1_0` block layout,
which upstream redefined incompatibly with the fork's. Full cost / conflict surface
/ trigger conditions: [`docs/porting/upstream-rebase-plan.md`](../../docs/porting/upstream-rebase-plan.md).)

---

## 1. What we are building

**Eliza-1** is a single product line of on-device fused models. From the
user's perspective there is exactly one default option per device tier;
they pick a size, they get one bundle, it does text + voice + vision.
Underneath it is a manifest-described bundle of GGUF/metallib/SPIR-V
files plus kernel capability metadata. There is no "pick the text model"
or "pick the TTS" — that is a runtime concern, not a user concern.

Backbones (do not change without explicit human approval):

- **Text/vision:** Qwen3.5 family only for the current release line:
  0.6B, 1.7B, and 4B. Larger historical 9B/27B hardware tiers are hidden
  placeholders until final Eliza-1 weights and evidence exist. We
  do not name these as "Qwen" in any user-facing string. Internally,
  manifests record the upstream lineage and license; the UI shows
  "Eliza-1 <tier>".
- **Voice (TTS):** OmniVoice (Qwen3-TTS lineage). The upstream repo at
  `https://github.com/ServeurpersoCom/omnivoice.cpp`, mirrored for builds at
  `https://github.com/elizaOS/omnivoice.cpp`, is the C++ source we fuse with
  llama.cpp. The omnivoice-singing variant adds an
  emotion + singing tag vocabulary (`[singing]`, `[happy]`, `[sad]`,
  `[whisper]`, `[angry]`, `[nervous]`, `[calm]`, `[excited]`, and
  preserved non-verbals `[laughter]`, `[sigh]`). Per Wave-6 user
  direction (2026-05-10), the prior "research-only until legal review"
  gate is **lifted for non-commercial use**: Eliza-1 is non-commercial
  open source under CC-compatible terms. omnivoice-singing CAN ship as
  part of default bundles. If the project ever pivots to commercial
  licensing, CC-BY-NC-SA training-data lineage (GTSinger, RAVDESS,
  Expresso) must be re-evaluated and likely re-trained on
  commercially-licensed corpora — until then, ship it.
- **ASR:** Qwen3-ASR (`ggml-org/Qwen3-ASR-0.6B-GGUF` for
  lite/mobile/desktop tiers, `ggml-org/Qwen3-ASR-1.7B-GGUF` for
  pro/server). These are the only public GGUF ASR artifacts currently
  available; do not invent ASR source repos with a Qwen3.5 prefix. The released
  Eliza bundle may wrap them under `elizaos/eliza-1-*`, but provenance
  must record the real upstream. whisper.cpp is **not** the default — it
  vendors its own ggml, violating the one-llama.cpp-build / one-GGML-pin
  contract in §4.
- **VAD:** Silero VAD (MIT, ~2 MB ONNX). Ships in every voice-enabled
  bundle. Drives barge-in cancellation; gates ASR to skip silent frames.
- **Wake word:** openWakeWord (Apache-2.0, ~3 MB). Opt-in, local-mode
  only. Hidden in cloud mode per three-mode hide-not-disable.
- **Embedding:** `0_6b` and `1_7b` reuse the active text backbone with
  `--pooling last` — no duplicate weights in the mobile/default tiers.
  Larger tiers may ship a dedicated `embedding/` artifact (1024-dim
  Matryoshka, 32k ctx) when the manifest records a real source artifact and
  evidence. Do not fabricate embedding source repos, and do not silently
  fall back on larger tiers when the manifest says a dedicated region is
  required.
- **Drafter:** DFlash. Always present in the bundle. Always wired in.
  Speculative decoding is mandatory, not optional (see §3).

Three runtime modes — every code path must work in all three:

| Mode      | Local models? | Cloud models? | Remote control? |
| --------- | ------------- | ------------- | --------------- |
| `local`   | yes (default) | optional      | exposes itself  |
| `cloud`   | hidden        | yes (default) | hidden          |
| `remote`  | via target    | no            | yes             |

Settings rules (enforce in UI + API layer, not just docs):
- `cloud` mode hides every local-model UI surface, every
  `ELIZA_LOCAL_*` setting, and the local-inference settings panel
  entirely. The cloud setting page is the only model-related surface.
- `local-only` mode (a sub-state of `local`) hides every cloud setting
  and every cloud-routed provider. The user must not be able to
  accidentally route a request to cloud.
- `remote` mode connects to a *local* instance only. It must refuse to
  point at a cloud instance. Changing cloud settings in remote mode
  mutates the *target's* cloud settings (i.e. the local agent the
  remote is controlling), not the remote-control client.

These three modes are not feature flags or A/B variants. They are the
top-level shape of the product. New code that adds a model surface MUST
state explicitly which modes it lives in, and MUST be removed from
modes where it does not belong.

---

## 2. Single fused bundle per device tier

Eliza-1 ships as **one logical bundle per tier**. The user sees one
download. Internally a bundle is a manifest plus several files, all
hosted under the `elizaos` HuggingFace org under `eliza-1-<tier>`.

### Tier matrix (binding)

| Tier            | Tagline                       | Text  | Voice          | Vision | Context  | DFlash | Quant default                   |
| --------------- | ----------------------------- | ----- | -------------- | ------ | -------- | ------ | ------------------------------- |
| `0_6b`       | low-RAM phones, CPU fallback   | 0.6B  | OmniVoice small | no     | 32k      | yes    | TurboQuant Q3 + Polar Q4 KV     |
| `1_7b`         | modern phones                  | 1.7B    | OmniVoice small | no     | 32k      | yes    | TurboQuant Q4 + QJL K-cache     |
| `4b`         | flagship phones, small desktops| 4B    | OmniVoice small | mmproj | 64k      | yes    | TurboQuant Q4 + QJL + Polar     |
| `9b`         | hidden future placeholder       | TBD   | TBD             | TBD    | TBD      | yes    | TBD after final weights         |
| `27b`        | hidden future placeholder       | TBD   | TBD             | TBD    | TBD      | yes    | TBD after final weights         |
| `27b-256k`  | hidden future placeholder       | TBD   | TBD             | TBD    | TBD      | yes    | TBD after final weights         |
| `27b-1m`    | hidden future placeholder       | TBD   | TBD             | TBD    | TBD      | yes    | TBD after final weights         |

Context-length variants (32k / 64k / 128k / 256k) are *not* separate
tiers — they are dimensions inside a tier. A tier's manifest lists which
context lengths are available; the runtime picks the largest that fits
the device's RAM budget at activation time.

### Bundle layout (binding)

A bundle on HuggingFace is a single repo with this layout. The manifest
is the source of truth; never derive contents from filenames.

```
elizaos/eliza-1-<tier>/
  eliza-1.manifest.json          # canonical schema, see §6
  text/
    eliza-1-<tier>-<ctx>.gguf    # text + vision (mmproj inlined where supported)
  tts/
    omnivoice-<size>.gguf
    omnivoice-tokenizer-<size>.gguf
  asr/
    <native package or gguf>
  vision/
    mmproj-<tier>.gguf           # only where not inlined into text gguf
  dflash/
    drafter-<tier>.gguf
    target-meta.json             # acceptance windows, kernel caps
  cache/
    voice-preset-default.bin     # speaker embedding + phrase cache seed
  evals/
    text-eval.json
    voice-rtf.json
    e2e-loop.json
  licenses/
    LICENSE.text
    LICENSE.voice
    LICENSE.dflash
    LICENSE.eliza-1
  README.md                      # auto-generated from manifest
```

A literal single `.gguf` containing all of text + voice + ASR + vision
+ drafter is **not** the deliverable — that requires either a custom
container format or major upstream work in llama.cpp's GGUF graph, and
is explicitly out of scope until the bundle ships and is stable. The
single user-visible *download action* IS the deliverable: one click,
one progress bar, one bundle on disk.

If that constraint changes (i.e. someone wants a literal one-file
artifact later), define an `.eliza` container format with a manifest +
multiple GGUFs concatenated, and update §6 — do not silently change the
GGUF schema.

---

## 3. Mandatory optimizations (never skip, error if missing)

Every Eliza-1 bundle MUST run through every applicable optimization.
The runtime MUST refuse to load a bundle that is missing any required
artifact for its tier. There is no "fast path that skips X" and no
"fallback to unoptimized". A bundle that cannot satisfy the contract
must be marked broken in `eliza-1.manifest.json` and not served from
the recommended-models endpoint.

### Required for ALL tiers

1. **TurboQuant** on the text model. Q3 for `lite`, Q3/Q4 for `mobile`,
   Q4 for `desktop`/`pro`/`server`. The KV cache MUST use TurboQuant Q3
   or Q4 quantization. See `vulkan/turbo3.comp`, `vulkan/turbo4.comp`,
   `vulkan/turbo3_tcq.comp`, `metal/turbo3.metal`, `metal/turbo4.metal`,
   `metal/turbo3_tcq.metal`. Verification: `verify/metal_verify` and
   `verify/vulkan_verify` MUST report 8/8 PASS on the target backend
   for the bundle's `dtype` before publish.
2. **QJL** on the K-cache when context > 8k. See `vulkan/qjl*.comp` and
   `metal/qjl.metal`. The reference is `packages/native-plugins/qjl-cpu`.
3. **PolarQuant** on the V-cache when context > 8k. See `vulkan/polar*.comp`
   and `metal/polar.metal`. The reference is
   `packages/native-plugins/polarquant-cpu`.
4. **DFlash speculative decoding** with the bundle's drafter. Always wired,
   always running in voice mode. The DFlash drafter participates in voice
   generation — proposed text tokens that survive verification are
   immediately handed to the TTS pipeline; rejected tokens roll back the
   TTS chunker (see §4 for the streaming contract).
5. **Fused kernels.** TurboQuant + QJL + Polar must compile into the same
   shipped llama.cpp build via the patch hooks in
   `packages/app-core/scripts/build-llama-cpp-dflash.mjs`. The runtime
   MUST log the kernel set on startup; missing kernels = startup error.

### Required for `desktop`/`pro`/`server` tiers

6. **TCQ trellis-coded quantization** for desktop/pro/server and any
   long-context text variant. `turbo3_tcq.comp` / `turbo3_tcq.metal`.
7. **CPU-offloaded KV cache** for context > 64k where device RAM is
   insufficient. The runtime MUST implement spill, not just refuse the
   request.

### Failure handling

If a required kernel fails to load, fails verification, or is missing
from the build:

- **Build time:** `build-llama-cpp-dflash.mjs` MUST exit non-zero, and
  the published artifact MUST NOT include a "kernels-missing" fallback
  build. There is no fallback build.
- **Runtime:** the engine MUST refuse to activate the bundle and surface
  a structured error to the UI. It MUST NOT silently fall back to
  unoptimized inference. It MUST NOT log-and-continue.

The Metal and Vulkan kernel patchers run unconditionally for matching
build targets. Build outputs can record shipped shader symbols
separately from runtime-ready graph dispatch, but only runtime-ready
capabilities may satisfy this contract. Treat any builder/runtime that
disables a required patch as broken.

---

## 4. Fused pipeline (mic → speech, end-to-end)

The streaming contract for voice mode. Every Eliza-1 runtime MUST
implement this exact graph; integrations that need a subset (e.g.
text-only) must reach the same nodes via the same scheduler, not via a
parallel codepath.

```
mic / file → ASR → text tokens
                    ↓
                  scheduler ──→ DFlash drafter (proposes N tokens)
                                       ↓
                                  target verifier (text model)
                                       ↓
                              accepted tokens → phrase chunker
                                       ↓                       ↘
                            speaker preset (cached)        rollback queue
                                       ↓                       ↙
                                  OmniVoice TTS  ←── on-reject: cancel chunk
                                       ↓
                                  PCM ring buffer → audio out
```

### Hard requirements

- **One process, one llama.cpp build, one GGML pin.** Text and voice
  share the same llama.cpp library. omnivoice.cpp is fused into the
  same build at the source level (vendored, not a sidecar). If the
  GGML version pin used by omnivoice.cpp diverges from the text model,
  the build MUST fail.
- **Shared KV cache scheduling, not shared KV memory.** Text and voice
  have their own KV caches (different layer counts, different head
  configs, different quantizations). What they share is the scheduler,
  the mmap region for weights, the kernel set, and the memory-budget
  policy.
- **Streaming handoff.** When DFlash + target produce an accepted
  text token, the phrase chunker MUST hand the chunk to TTS within the
  same scheduler tick — no buffering past phrase boundaries. Phrase
  boundaries are punctuation + a max-N-token cap (configurable per
  tier).
- **Barge-in cancellation.** When the mic detects new user speech, the
  TTS PCM ring buffer MUST drain immediately, the phrase chunker queue
  MUST flush, and any in-flight TTS forward pass MUST be cancelled at
  the next kernel boundary.
- **Speaker preset caching.** The default voice ships as a precomputed
  speaker embedding in `cache/voice-preset-default.bin`. Loading a
  voice MUST NOT re-extract the embedding from raw audio on every
  startup. A precomputed phrase cache for common assistant utterances
  ("Sure.", "One moment.", "I can't help with that.") MUST be used as
  a first-byte-latency win.
- **DFlash↔TTS coupling.** When DFlash proposes text tokens that are
  later rejected by the target, the TTS chunker's rollback queue MUST
  drop the corresponding (not-yet-spoken) audio chunks. Audio that has
  already left the ring buffer is gone — design the chunker so this is
  rare (small chunk = low latency cost on rollback).

### What we do NOT do

- We do not run text and voice in two processes communicating over IPC.
  That regresses memory and adds a 1–10ms scheduling tax per turn.
- We do not run a "TTS-only mode" that skips DFlash. DFlash is always
  on. If the user disables speculative decoding for debugging, that is
  a developer-only flag (`ELIZA_DFLASH_DISABLE=1`), it is not a user
  setting, and it MUST log a loud warning every turn.
- We do not split voice into "fast TTS" and "high-quality TTS" tiers.
  One voice model per tier, fused, optimized.

---

## 5. Three modes — code organization

Every entry point that touches a model MUST be classified into one or
more of `local`, `cloud`, `remote`. The classification lives in code,
not in docs.

- `packages/app-core/src/services/local-inference/` is the `local` and
  `local-only` surface. It MUST have a hard import boundary against
  cloud-only modules.
- Cloud-routing code is in the cloud package and MUST NOT be imported
  by the local-inference service except through a typed mode-aware
  router that the runtime mode gates.
- `remote` mode is implemented as a thin client over the local
  instance's HTTP API. It does NOT have its own model surfaces — every
  setting it changes maps to a setting on the target.

Hide-not-disable rule: when a mode hides a setting, the UI must omit
the surface entirely, the API must reject mutations to that setting
with a 4xx, and the persisted setting must be inert (no background job
acts on it). "Hidden" without "inert" is a leak.

---

## 6. Manifest schema (binding)

`eliza-1.manifest.json` is the source of truth for every Eliza-1
bundle. The runtime, the recommendation engine, the downloader, the
mobile catalogs, and the build script all read this file. Do not let
catalogs drift from it — generate them.

```json
{
  "$schema": "https://elizalabs.ai/schemas/eliza-1.manifest.v1.json",
  "id": "eliza-1-4b",
  "tier": "4b",
  "version": "1.0.0",
  "publishedAt": "2026-MM-DDTHH:MM:SSZ",
  "lineage": {
    "text": { "base": "qwen3.5-4b", "license": "..." },
    "voice": { "base": "omnivoice-1_7b", "license": "..." },
    "drafter": { "base": "dflash-4b-drafter", "license": "..." }
  },
  "files": {
    "text":    [{ "path": "text/eliza-1-4b-64k.gguf", "ctx": 65536, "sha256": "..." }],
    "voice":   [{ "path": "tts/omnivoice-1_7b.gguf",          "sha256": "..." }],
    "asr":     [{ "path": "asr/...",                          "sha256": "..." }],
    "vision":  [{ "path": "vision/mmproj-4b.gguf",    "sha256": "..." }],
    "dflash":  [{ "path": "dflash/drafter-4b.gguf",   "sha256": "..." }],
    "cache":   [{ "path": "cache/voice-preset-default.bin",   "sha256": "..." }]
  },
  "kernels": {
    "required": ["turboquant_q4", "qjl", "polarquant", "dflash", "turbo3_tcq"],
    "optional": [],
    "verifiedBackends": {
      "metal":  { "status": "pass", "atCommit": "...", "report": "..." },
      "vulkan": { "status": "pass", "atCommit": "...", "report": "..." },
      "cuda":   { "status": "pass", "atCommit": "...", "report": "..." },
      "cpu":    { "status": "pass", "atCommit": "...", "report": "..." }
    }
  },
  "evals": {
    "textEval":      { "score": 0.0, "passed": true },
    "voiceRtf":      { "rtf": 0.0,   "passed": true },
    "e2eLoopOk":     true,
    "thirtyTurnOk":  true
  },
  "ramBudgetMb": { "min": 7000, "recommended": 9500 },
  "defaultEligible": true
}
```

**Rules:**

- Every published bundle MUST have `defaultEligible: true` only if every
  required kernel is verified on every supported backend for that tier
  AND every eval has `passed: true`. The recommendation engine MUST
  refuse to surface a bundle with `defaultEligible: false` as a default.
- HF-search results from outside `elizaos/eliza-1-*` MUST never set
  `defaultEligible: true`. They are user-installed customs only.
- The runtime MUST validate the manifest against `kernels.required`
  before activating the bundle. A capability mismatch is a hard error.

---

## 7. HuggingFace publishing & auto-download

Every Eliza-1 release lives at `https://huggingface.co/elizaos`. The
device-side downloader MUST:

1. Read the manifest from the bundle's repo before downloading any
   weight file. Verify schema version, kernel caps against the device,
   RAM budget against device hardware. Refuse incompatible bundles
   with a structured error.
2. Download every file in `manifest.files.*`. Verify `sha256` for each.
   Resume on partial download.
3. Check the device's available kernels (Metal/Vulkan/CUDA/CPU/MLX/NEON)
   against `manifest.kernels.required`. If any required kernel is
   unavailable on this device, the download MUST be aborted with a
   structured error before any weight bytes are fetched. There is no
   "download anyway, hope it works" path.
4. Materialize the bundle to the local cache, run a one-time
   verify-on-device pass (load → 1-token text generation → 1-phrase
   voice generation → barge-in cancel test), and only then mark the
   bundle `ready` in the local catalog.

Publishing flow (training side, see [`packages/training/AGENTS.md`](../training/AGENTS.md)):

- Training produces text + drafter weights.
- Quantization recipes in `packages/training/scripts/quantization/`
  apply TurboQuant + QJL + Polar.
- A publish script (one of the `publish_*` scripts in
  `packages/training/scripts/`) assembles the bundle, generates the
  manifest, runs `verify/metal_verify` + `verify/vulkan_verify` against
  the bundle's quantized artifacts, populates `kernels.verifiedBackends`,
  runs the eval suite, and pushes to HF.
- The publish script MUST refuse to upload if any required eval fails
  or any required kernel is unverified.

---

## 8. Verification gates (what "done" means)

A bundle is shippable when, on each supported backend:

- `make -C packages/inference/verify reference-test` is clean.
- `verify/metal_verify` reports 8/8 PASS for `turbo3`, `turbo4`,
  `turbo3_tcq`, `qjl`, `polar` against the bundle's quantized weights
  (not just synthetic fixtures — fixtures regenerated from the actual
  shipped weights).
- `verify/vulkan_verify` reports 8/8 PASS for the same set.
- The CUDA path (where applicable) reproduces the same outputs to the
  same numerical tolerance.
- A 30-turn end-to-end voice loop runs without crash, without leak,
  without exceeding `manifest.ramBudgetMb.recommended`.
- First-token latency, first-audio latency, RTF, ASR WER, peak RSS,
  thermal/battery (mobile), and DFlash acceptance rate are recorded
  in the manifest's `evals` block and meet tier-specific gates.

A code change that touches kernels, the build script, the dflash
server, or the bundled-models catalog MUST run the relevant subset of
these gates locally before merge. CI runs the full set per supported
backend nightly.

---

## 9. Working style

- **Scope discipline.** The kernels in this directory are a contract.
  Do not invent new quantization formats, new fusion graphs, or new
  KV-cache layouts without a written design doc that explains why the
  existing five (`turbo3`, `turbo4`, `turbo3_tcq`, `qjl`, `polar`) are
  insufficient.
- **No defensive code.** A missing kernel, a missing manifest field,
  or a verification failure is a hard error. Do not add fallbacks. Do
  not log-and-continue. The whole point of the contract is that we
  ship one optimized path, not three with conditional branches.
- **Mirror the references bit-for-bit.** Metal/Vulkan kernels MUST
  produce numerically identical output (within published tolerance) to
  the C reference in `packages/inference/reference/` and to the
  upstream CUDA implementation in
  `packages/native-plugins/{qjl-cpu,polarquant-cpu}` and the `elizaOS/llama.cpp`
  fork. New kernels follow the same pattern: ship the C reference and
  a JSON fixture before shipping the Vulkan/Metal port.
- **Hardware verification is non-optional.** A "compiles cleanly"
  badge is not a "passes" badge. The README's verification matrix
  marks rows as `NEEDS HARDWARE` until `metal_verify` / `vulkan_verify`
  reports 8/8 on a real device. Do not flip a row to ✓ without that
  evidence.
- **Stay aligned with the training side.** Quantization recipes, weight
  layouts, and bundle structure cross the boundary between training
  and inference. Read [`packages/training/AGENTS.md`](../training/AGENTS.md)
  before changing the manifest schema or any quantization op.
- **Branding.** User-facing strings and logs say `Eliza-1`. They do
  not say `Qwen`, `Llama`, `OmniVoice`, `DFlash`, or `TurboQuant`.
  Internal logs, stack traces, and developer-mode UI surfaces may
  reference upstream names — anywhere a user can see, the name is
  Eliza-1.

---

## 10. Files to read before making changes

- `packages/inference/README.md` — kernel-level technical reference and
  current verification matrix. The single source of truth for what is
  hardware-verified vs. compile-only.
- `packages/app-core/src/services/local-inference/README.md` — runtime
  contract for the engine, downloader, recommendation, and routing.
- `packages/app-core/scripts/build-llama-cpp-dflash.mjs` — the build
  hook. Every kernel patch lives here. It (and the AOSP cross-compile at
  `packages/app-core/scripts/aosp/compile-libllama.mjs`) default to building
  from the in-repo `packages/inference/llama.cpp` submodule.
- `packages/training/AGENTS.md` — the training-side contract, including
  what the bundle/publish flow expects.
- the repo-root `AGENTS.md` — repo-wide cleanup mandate and conventions
  (port handling, scope discipline, elizaOS naming). The non-negotiable
  architecture rules apply here too: dependencies point inward, no
  polymorphism for runtime branching in code (kernels are a registry,
  not an `if`), no `try/catch` that swallows.
