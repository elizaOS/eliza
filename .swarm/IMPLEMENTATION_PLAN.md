# Eliza-1 "grind it down" — unified implementation plan (Phase 2 synthesis)

> Synthesis of `.swarm/plans/cluster-{2,3,4,5}.md` + `.swarm/TODO.md`'s
> Cluster-1 section (cluster-1's standalone plan file did not land before the
> synthesis cutoff; its scope — hygiene / lint / typecheck / CI — is taken from
> `.swarm/TODO.md` directly). Dependency-ordered, grouped into workstreams.
> **Honesty contract throughout:** no fabricated hashes / evidence / benchmarks;
> `needs-hardware` / `needs-host` placeholders stay honest; the documented
> reduced-optimization fallback (`MILADY_LOCAL_ALLOW_STOCK_KV=1`) is the answer
> where a backend genuinely can't dispatch a §3 kernel yet — not a silent skip.

## 0. Resource ledger (what's actually available)

- **Local box:** RTX 5080 Laptop (Blackwell sm_120, CUDA 12.8 at
  `/usr/local/cuda-12.8`, 16 GB VRAM), Intel ARL / Mesa ANV iGPU (Vulkan 1.4),
  x86-64 CPU (AVX2 + AVX-VNNI, 24 cores / ~31 GB RAM — RAM-contended;
  serialize big CUDA builds), KVM for Cuttlefish `cvd`. No Apple, no AMD, no
  Windows, no Android phone, no GH200 locally.
- **Cloud (spend approved):** Nebius H200 via
  `packages/training/scripts/cloud/run-on-cloud.sh --provider nebius --task … --yes-i-will-pay`
  (or `--provider vast` for H100/B200/RTX5090/MI300 kernel-verify + bench).
  **Caveat (from cluster-3 §E):** Nebius CLI on this box is `federation`/browser-SSO
  → headless `nebius iam whoami` hangs; a real provision needs an operator with a
  live login or `VAST_API_KEY` present. If creds are missing the cloud jobs stay
  queued (documented, not faked) and the bundles stay `weights-staged`.
- **Cerebras `gpt-oss-120b`** for training-data gen — needs `CEREBRAS_API_KEY`.
- **HF publishing under `elizaos/*`** — needs `HF_TOKEN` with write to `elizaos`.

If `CEREBRAS_API_KEY` / `HF_TOKEN` / cloud creds are absent at impl time: do
everything that doesn't need them, leave the rest queued, note it in the DONE
section. Do **not** stub or fabricate.

## 1. Cross-cutting conflicts — resolved (canonical decisions)

These three knobs are touched by ≥2 clusters; pick one shape so the workstreams
don't collide:

1. **Structured-decode envelope on-wire form (C3 corpus ↔ C4 GBNF ↔ C5 emotion field).**
   Canonical: **JSON**, exactly what `@elizaos/core` `buildResponseGrammar` emits
   today (the `ResponseSkeleton` flat span list + the lazy GBNF + the
   `eliza_prefill_plan` runs). Cluster-3's plan calls it "the TOON envelope" — that
   is wrong for the runtime path; the action/Stage-1 model call uses JSON. **Action
   for C3:** generate the `structured_decode` corpus rows by running
   `buildResponseGrammar` on a synthetic action set + `compilePrefillPlan` to get
   the byte-exact stream — do **not** hand-author TOON. (If a TOON surface exists
   somewhere it's a different consumer; the fine-tune corpus matches the runtime
   model call, which is JSON.)
2. **Emotion field shape (C3 corpus ↔ C4 schema ↔ C5 TTS controls).** Canonical:
   **inline omnivoice-singing tags in `replyText`** — `[happy] [sad] [angry]
   [nervous] [calm] [excited] [whisper] [singing]` + preserved non-verbals
   `[laughter] [sigh]`. This is a `free-string` span (no grammar change). Define one
   TS constant `EXPRESSIVE_TAGS` near `ELIZA_1_VOICE_CAPABILITIES` in
   `packages/app-core/src/services/local-inference/manifest/schema.ts`, and a
   `parseExpressiveTags(replyText)` helper in `voice/expressive-tags.ts`. *Optional
   add-on, not required:* a Stage-1 `emotion` enum field-evaluator — if C5 wants it,
   it auto-flows into skeleton+grammar+prefill with zero special-casing; one-line
   registration in `response-grammar.ts`. **Default: inline tags only.**
3. **Fused `libelizainference` ABI (C2 builds it ↔ C4's W7 streaming decoders ↔
   C5's duet bridge).** Canonical: the existing fused ABI in `omnivoice-fuse/ffi.h`
   (`eliza_inference_tts_synthesize`, `/v1/audio/speech`) is unchanged; C4 *adds*
   `eliza_inference_{asr,tts}_stream_*` + `eliza_inference_set_verifier_callback`
   (the "W7" surface, today honest stubs returning `*_supported()==0`). Emotion is
   threaded as an optional `emotion_spec` string param on the stream-open call (or
   via `speaker_preset_id`). C2 owns building this lib for every `*-fused` target;
   C4 owns the decoder bodies inside it. The fork pin (`packages/inference/llama.cpp`
   submodule) bump is **C2's** — C4 hands C2 the source graft + `prepare.mjs` block.
   A regex `kernel-patches/` edit is **not** acceptable for the decode-loop changes
   (structural) — must be a real fork commit + a submodule bump.
4. **Latency-trace checkpoints (C5 defines ↔ C1 must keep biome-clean).** C5 adds
   `peer-utterance-end` (the headline t0 for the duet), `audio-first-into-peer-ring`,
   `replyText-first-emotion-tag` to `VOICE_CHECKPOINTS` in `latency-trace.ts`, plus
   the derived keys (`ttftFromUtteranceEndMs` = headline) — these are pure data
   additions that the dev endpoint + `voice-latency-report.mjs` pick up by iterating
   the key array. C1's job: keep `tsc --noEmit` + `biome check src` green through it.

## 2. Sequencing (the dependency graph)

```
C1 (hygiene)  ── runs in parallel with everything; gates the final "all green"
C2 (fork build matrix + kernel parity + turbo3_tcq type-traits)
   └─ gates → C2 H200 jobs (full ggml-cuda build, sm_90a, kernel-verify on cloud)
   └─ gates → C3 (real fork-built GGUFs for every tier — nothing real ships w/o this)
C3 (model builds + 0.6b fine-tune + drafters)
   └─ needs ← C4's structured-decode schema (the structured_decode corpus task)
   └─ needs ← C5's emotion-tag schema (the voice_emotion corpus task)
   └─ gates → C5's duet (the model artifact A/B run on)
C4 (guided structured decode fast-forward + W7 fused streaming decoders)
   └─ gates → C5's e2e (streaming TTFT) and the structured-decode-token-savings metric
   └─ needs ← C2 (the *-fused build targets to land the streaming decoders inside)
   └─ needs ← C3 (the OmniVoice/Qwen3-ASR GGUFs for live verification)
C5 (two-agents duet harness + latency instrumentation + emotion fidelity metric)
   └─ needs ← C2 (kernel-complete llama-server) + C3 (the bundle) + C4 (decode + streaming)
   └─ the duet *wiring* + the stub-backend e2e test + the latency trace additions
      can land now (don't gate on C2/C3/C4); only the *real-output* run is gated.
```

**Practical impl order:**
A. (now, parallel) C1 hygiene sweep; C2 `turbo3_tcq` type-traits + local verify
   re-run; C4's runtime-side guided-decode (already in tree — verify + bench; the
   fork fast-forward is a fork commit, queued behind C2's pin bump); C5's duet
   harness wiring + `latency-trace.ts` checkpoint additions + stub-backend e2e test;
   C2's `android-x86_64-cpu` target + Cuttlefish `cvd` smoke; C2's Android-fused /
   iOS-xcframework `--dry-run` + host-needed docs; C4's W7 streaming-decoder source
   (built + unit-tested on `linux-x64-cpu-fused`/`linux-x64-vulkan-fused`).
B. (when cloud creds present) C2's H200 jobs (full `ggml-cuda` build, sm_90a P2/P3
   verify, native-NVIDIA/AMD Vulkan, ROCm `hip_verify`); C3's H200 jobs (the
   full-corpus 0.6b APOLLO SFT, 1.7b SFT at seq≥4096, 9b/27b/27b-256k/27b-1m
   builds + their drafters).
C. (when C2's fork pin + GGUFs land) C3's real fork-built GGUFs per tier →
   `release:v1:prep` + the gate harnesses; C4's fork fast-forward consuming
   `eliza_prefill_plan`; C5's real-output duet run on 0.6b then 1.7b → the latency
   report + emotion fidelity metric; conditional HF publish of the fine-tuned 0.6b.
D. (always) doc/contract updates: `kernel-contract.json`, `PLATFORM_MATRIX.md`,
   `AGENTS.md` §3/§4, `RELEASE_V1.md`, `needs-hardware-ledger.md`, `eliza1_gates.yaml`.

## 3. Workstreams (impl-agent lanes — explicit file/area scopes, no collisions)

### WS-1 — Hygiene / CI (scope: build/test/lint config, top-level scripts, non-`src` biome)
- Per-package `bunx turbo run lint` is the CI contract — **already green (138/138)**.
  The repo-wide `bunx biome check .` has ~2.3k errors in `benchmarks/`, `scripts/`,
  test fixtures, AI-generated JSON — the user wants the *whole* tree clean. Fix
  properly, no blanket ignores. Lane: everything *not* under a package's `src/`.
- `bunx tsc --noEmit` per package. **Known break:** `@elizaos/agent#typecheck` (56
  errors) — `auth-store.ts` `SQL<unknown>` from two physically-distinct
  `drizzle-orm@0.45.2+<hash>` install dirs (`@elizaos/agent` reaches drizzle via
  `plugins/plugin-sql`'s copy, `@elizaos/app-core` via its own — incompatible
  declaration identities). Fix: dedup drizzle-orm to one physical install (a
  `overrides`/`resolutions` pin in root `package.json`, or align peer-dep sets so
  bun hoists one copy), then re-run `turbo run typecheck`. **High priority — this is
  the `bunx tsc -p packages/app-core/tsconfig.json --noEmit` clean gate the swarm
  needs for merging.**
- CI infra (the `Tests` workflow): `bun install --ignore-scripts` skips the `bun`
  npm package's own `install.js` → placeholder `bun` binary → `bun run postinstall`
  fails partway → `ensure-workspace-symlinks.mjs`/`ensure-native-plugins-linked.mjs`
  don't run → `Failed to resolve entry for @elizaos/capacitor-llama` / `@elizaos/app-wallet`
  in Client Tests + `Cannot find package 'ethers'` in Plugin Tests. Fix: make the
  "Materialize bun npm package binary" step in `.github/actions/setup-bun-workspace/action.yml`
  reliable, or split postinstall so the `node` symlink steps run even if a `bun
  scripts/…` step earlier fails, or run `node scripts/ensure-workspace-symlinks.mjs &&
  node scripts/ensure-native-plugins-linked.mjs` explicitly after postinstall in the
  composite action. **Caught locally already:** `@elizaos/plugin-suno#format:check`
  (fixed), 5 electrobun test files importing `bun:test` instead of `vitest` (fixed).
- `packages/training/uv.lock` churn (resolution-marker reordering) — stabilize.
  `hypothesis` + any declared-but-not-installed test dep — ensure the python env
  installs them (`uv sync --all-extras` in the python CI job, or move them to a
  base group).
- `vulkan-dispatch-smoke` vs the committed fork pin — cluster-2 §H.4 says this is
  already reconciled (the harness `#include`s only the builders the pin exports);
  verify `make -C packages/inference/verify vulkan-dispatch-smoke cpu-dispatch-smoke`
  passes.
- Update parent `/home/shaw/milady/CLAUDE.md`'s env-var section to the `ELIZA_*`
  convention (note `MILADY_*` aliases still honored).
- `bun run build` / `bun run test` / `bun run test:e2e` green except documented HW
  cases; fix the `node:fs/promises`/`conversationRegistry` `vi.mock`-not-restored
  leak so `bun test packages/app-core/src/services/local-inference` is fully green
  (it's green via `bunx vitest run` — find the `bun test`-only leak).
- "Remove on sight" the overengineering surfaced along the way (AGENTS.md mandate).

### WS-2 — Kernel parity + `turbo3_tcq` type-traits (scope: `packages/inference/llama.cpp` submodule, `packages/inference/verify/`, `kernel-patches/`)
- **`turbo3_tcq` type-traits** (cluster-2 §A.3 — high value, runnable locally): add
  `[GGML_TYPE_TBQ3_TCQ] = {...}` to `ggml.c` (the `to_float`/`from_float_ref`/`vec_dot`
  entry — block layout already in `ggml-common.h`) using the Viterbi encoder +
  sliding-window decoder from `reference/turbo_kernels.c`; extend
  `patchServerKvCacheTypeNames` to add `turbo3_tcq` to `kv_cache_types`; re-run
  `make -C packages/inference/verify {vulkan,cuda}-verify` + the dispatch smokes +
  a `llama-server --cache-type-k turbo3_tcq` graph-build smoke. **Prereq for the
  27b/27b-256k/27b-1m tiers (WS-4).** This is a fork commit + a submodule bump +
  a new kernel-patch.
- **CUDA full `ggml-cuda` integration build** (cluster-2 §A.2 — ~30 GB peak, OOMs
  locally): do it on the H200 (`run-on-cloud.sh --provider vast --task kernel-verify
  --gpu h100 --yes-i-will-pay`) → `evidence/platform/linux-x64-cuda.json`. Native
  sm_120 SASS wiring is done; `cuda-verify` 8/8 is done; CUDA P3 (DP4A default,
  occupancy, `__ldg`) landed (commit `c5e1fa97be`). CUDA P2 (cp.async/TMA on
  sm_90a): cluster-2's verdict is **not worth it** without a 4-byte-aligned cache
  repack — document the decision.
- **CPU TBQ/Polar standalone graph op** — verdict: leave `reference-only` (no public
  CPU ggml graph builder in the pin; CPU users get QJL already; reduced-mode is the
  hatch). Document in `kernel-contract.json`.
- **ROCm/HIP** — write `verify/hip_verify.cu` (mirrors `cuda_verify.cu`, HIP
  `__device__` kernels, same fixture bytes, same `qjl_polar_ref.o`) — author it; run
  it on a vast.ai `gfx*` box if available, else `authored-pending-hardware`. Making
  the production `.cu` kernels HIP-compilable is a stretch goal; the reduced-mode +
  loud warning stays the ROCm story if not done.
- **Vulkan native graph dispatch beyond Intel ANV** — native AMD (RADV) + native
  NVIDIA Vulkan: rent a vast.ai box (`--task kernel-verify` builds `linux-x64-vulkan`
  then `vulkan-dispatch-smoke`); Adreno/Mali = `needs-hardware`.
- **Metal fused attention** (`metal/fused_attn_qjl_tbq.metal` + `…_qjl_polar.metal`
  + `polar_preht.metal` byte-faithful ports per the existing design doc, + the
  `cases`-array path in `verify/metal_verify`) — `authored-pending-hardware` (needs
  an Apple-Silicon Mac to verify). `fused_attn` stays optimization-on-top until a
  Metal smoke lands, then promote to `requiredRuntimeCapabilityKeys` + a manifest
  kernel name.
- Local verify gate to keep green: `make -C packages/inference/verify
  {kernel-contract,reference-test,vulkan-verify,vulkan-verify-multiblock,
  vulkan-verify-fused,cuda-verify,cuda-verify-fused,cpu-bench,cpu-dispatch-smoke}`.

### WS-3 — Build matrix (scope: `build-llama-cpp-dflash.mjs`, `aosp/compile-libllama.mjs`, `ios-xcframework/build-xcframework.mjs`, `aosp/`, the `omnivoice-fuse/` graft, `kernel-contract.json`, `PLATFORM_MATRIX.md`)
- **`android-x86_64-{cpu,vulkan}-fused`** — add as real targets (cluster-2 §B "new
  target"): `compile-libllama.mjs` already has the `x86_64` ABI entry — make the
  metal/vulkan/cpu kernel patches + the dflash-drafter-arch patch apply on it; add
  to `SUPPORTED_TARGETS` / `kernel-contract.json` `platformTargets` / `PLATFORM_MATRIX.md`.
  Run the **Cuttlefish `cvd` smoke** on the local box under KVM
  (`aosp/smoke-cuttlefish.mjs` + `avd-test.mjs` + `boot-validate.mjs` + `e2e-validate.mjs`)
  → make `reports/porting/.../cuttlefish-x86_64-smoke.md` a real 8-step-pass artifact.
  Vulkan-on-Cuttlefish (gfxstream/SwiftShader) = best-effort, document whether it's a
  real ICD or a software fallback (software → no recordable evidence per fail-closed).
- **`android-arm64-{cpu,vulkan}-fused` cross-builds** (NDK + zig) — build on the
  local box, no device verify; the NDK cross-build of `omnivoice-core` + the fused
  server inside the AAR (`libelizainference` alongside `libllama.so`); device run +
  Adreno/Mali graph dispatch = `authored-pending-hardware` with the exact `adb` cmd.
- **Android in-process voice path** (cluster-2 §E): the `common_speculative_*` shim
  (`aosp/llama-shim/eliza_llama_shim.c` exporting the fork's `common_speculative_*`
  ABI backed by the in-process libllama) so the DFlash spec loop runs in-process
  ("path b") instead of spawning a cross-compiled server ("path a"); `AospDflashAdapter`
  prefers the shim when present, path a stays fallback. Capacitor mic/audio/ONNX
  bridges (`Microphone`→`PushMicSource`, native `AudioTrack`→`PcmRingBuffer`,
  `onnxruntime-mobile` for Silero VAD) wired through `plugin-capacitor-bridge`'s
  `mobile-device-bridge-bootstrap.ts` + `LocalInferenceEngine`'s voice bridge. An
  `aosp/deploy-pixel.mjs` one-step build+install+launch+smoke. Unit-test everything;
  phone bits = `authored-pending-hardware`.
- **Windows / iOS / macOS targets** — wire the cmake/xcframework configs, run
  `--dry-run`, document the host needed (native Windows / Snapdragon X+MSVC-arm64 /
  macOS+Xcode). `windows-x64-{cpu,cuda,vulkan}(+cuda-fused)`, `windows-arm64-{cpu,vulkan}`,
  `darwin-arm64-metal(+fused)`, `ios-arm64-metal(+fused,+simulator)`.
- **`linux-x64-cuda-fused`** — build on the H200 (~30 GB, OOMs locally) →
  `OMNIVOICE_FUSE_VERIFY.json` + the GPU TTS RTF + `e2e_loop_bench.mjs`.
  **`linux-x64-vulkan-fused`** — build locally (lighter), weight-backed
  `/v1/audio/speech` smoke.
- **MLX backend as a runtime path** (cluster-2 §C): an MLX adapter under
  `packages/app-core/src/services/local-inference/` mirroring `dflash-server`'s
  spawn-and-route shape but for `mlx_lm.server`; engine routing picks it on Apple
  Silicon when `mlx-lm` + an MLX-format eliza-1 model are present. **Not
  `defaultEligible`** (no TurboQuant/QJL/Polar in MLX — same class as reduced-mode);
  **not** the voice path (MLX doesn't carry OmniVoice/Qwen3-ASR). Wire + unit-test
  (mock `/v1/models` + `/v1/chat/completions`); Mac smoke = needs-hardware. Document
  MLX is a convenience-not-publish path.
- **TPU/NPU verdict** (cluster-2 §D): **not a target this wave** — the text model
  doesn't fit an Edge TPU's 8 MB SRAM, the sidecars don't win enough, the Android GPU
  (Vulkan) is the on-device accelerator, NNAPI is deprecated. A `ELIZA_VAD_QNN_DELEGATE=1`
  flag for Silero VAD on the NPU in always-listening mode is a *battery* optimization
  (stretch, not core). Document in `PLATFORM_MATRIX.md`/`needs-hardware-ledger.md`.
  Do **not** add a `plugin-coral`/`plugin-qnn`.

### WS-4 — Models & bundles + 0.6b fine-tune + drafters (scope: `packages/training/scripts/`, `benchmarks/`, the bundle staging scripts, HF publish)
- **Every tier is gated on WS-2/WS-3** producing a kernel-complete, dispatch-verified
  `llama-server`/static lib + the fork's `convert_hf_to_gguf.py`
  (`build-llama-cpp-dflash.mjs` must exit non-zero on a missing §3 kernel — no
  fallback build). Until then the `0_6b`/`1_7b` bundles stay `weights-staged`
  (honest — the text GGUFs are substitute upstream-Qwen3 bytes, not fork builds; the
  `9b`/`27b`/`27b-256k`/`27b-1m` bundles aren't staged at all; `elizaos/eliza-1-*` HF
  repos don't exist). The native-`q4_polar` converter gap means GGUF bodies stay
  `Q4_K_M`+`weight_quant.deferred:true` (sidecars produced) until the fork's converter
  emits native Polar — that's a WS-2 converter item, honestly recorded.
- **0.6b fine-tune (the headline FINETUNE deliverable):**
  1. Data gen via Cerebras `gpt-oss-120b` (`CEREBRAS_API_KEY`): regenerate
     `datasets/eliza1-sft-0_6b/{train,val,test}.jsonl` *with* the cross-cluster
     additions — a `structured_decode` task (byte-exact Stage-1-envelope assistant
     turns from `buildResponseGrammar`+`compilePrefillPlan` — so `format_pct` stops
     being 0%) + a `voice_emotion` task (inline `[happy]`/`[whisper]`/… tags +
     non-verbals per WS-5's schema). Run `validate_corpus.py` + the privacy filter.
     Training set: full `data/final/` (66k) concatenated ahead of the benchmark-aligned
     mix-in, through `format_for_training.py` (eliza_native_v1 / chat → ChatML).
  2. APOLLO training on the H200 (NOT muon/adamw — APOLLO is the only optimizer the
     local entrypoints expose, by design): `REGISTRY_KEY=qwen3-0.6b bash
     scripts/cloud/run-on-cloud.sh --provider nebius --task train --gpu h200 --tier
     0_6b --yes-i-will-pay` (or `--provider vast`), epochs 3, `apollo_mini` rank-1,
     seq 4096, eff. batch 8, bf16, lr 1e-5, grad-ckpt on. ~1–2 H200-hr. Output:
     `checkpoints/eliza-1-0_6b-apollo-<ts>/final/` + `gate_report.json`. (A 35-row /
     8k-row smoke run already beats the upstream `Qwen3-0.6B` baseline on every
     measured axis but doesn't clear the absolute `format_ok ≥ 0.70` publish floor —
     the full-corpus run is the one that has to clear it.)
  3. Eval vs the benchmarked baseline (upstream `Qwen3-0.6B` on `data/final/test.jsonl`
     in **full mode**, not the 35-row smoke slice): `run_pipeline.py` stages 1/3/4 +
     `scripts/eval/eliza1_eval_suite.py` (`text_eval`) + `eliza1_gates_collect.mjs`.
     Bar: beat the baseline on every axis, regress none, **and** clear `format_ok ≥ 0.70`.
  4. Re-stamp the eliza1 bundle against the new `final/` (`gguf_eliza1_apply.py`,
     sidecars, manifest, `finalize_eliza1_evidence.py`); stage as a **candidate
     revision**, not `defaultEligible`.
  5. **Conditional HF publish** (`packages/training/scripts/publish/orchestrator.py`,
     `HF_TOKEN` with write to `elizaos`): if it beats the baseline AND clears
     `format_ok` → publish `elizaos/eliza-1-0_6b` (fine-tuned bundle, `recommended`
     channel, drop the `base-v1` banner; `defaultEligible` only when every required
     kernel verifies on every backend AND every eval passes — realistically `false`
     until Metal/iOS/Android verify lands), `elizaos/eliza-1-0_6b-sft` (raw TRL
     safetensors), the adapted datasets (`elizaos/eliza-1-training` refresh +
     `elizaos/eliza-1-sft-0_6b`), and the eval/bench results (`elizaos/eliza-1-evals`).
     If it does NOT beat the baseline / clear the floor → publish **nothing
     model-side** (the orchestrator refuses on a red gate — don't override); still
     publish the datasets + the negative result honestly; report why in `reports/`.
- **1.7b SFT** — continue at seq ≤2048 locally OR re-run on the H200 at seq ≥4096
  (the H200 lifts the OOM ceiling); then bench/quant/bundle. Not gate-blocking.
- **9b / 27b / 27b-256k / 27b-1m** — H200 jobs (`run-on-cloud.sh --provider {vast,nebius}
  --task train …`); 9b single H200/B6000, 27b 2× H200 FSDP; 27b-256k/27b-1m are
  context variants of the 27b checkpoint (longer-ctx GGUF, K-cache rides `turbo3_tcq`
  — needs WS-2's type-traits fix + a GH200/Hopper aarch64 verify). "Stage what fits."
- **4b / 2b** — opportunistic (4b: download → Q4_K_M GGUF → bench + calibration
  forwards, or a 24 GB vast card; 2b: tiny-seq smoke only — qwen3_5 VLM + hybrid
  linear-attn, 248k vocab → big CE transient, Liger broken).
- **DFlash drafters per tier** — real KD (`distill_dflash_drafter.py` — forward-KL on
  the target's top-k logits + a CE floor, AdamW *for the drafter* (APOLLO is the 0.6b
  SFT's optimizer, separate), byte-identical-tokenizer assert, GGUF via the fork's
  converter, `dflash-draft.target_checkpoint_sha256` stamp), then the acceptance-window
  eval → `dflash/target-meta.json` (gates 0.45/0.50/0.55 per tier). Students:
  Qwen3-0.6B → 1_7b/4b, Qwen3-1.7B → 9b/27b/27b-256k/27b-1m. **0_6b gets no drafter**
  (no smaller Qwen3 base) — `target-meta.json` records "n/a". The bigger ones go on the
  H200.
- **`kernel-contract.json` / manifest / `eliza1_platform_plan.py`** stay consistent
  after every bundle change; `bun run release:v1:prep` + the gate harnesses
  (`eliza1_gates_collect.mjs`, `bargein_latency_harness.mjs`,
  `thirty_turn_endurance_harness.mjs`, `dflash_drafter_runtime_smoke.mjs --bench`) on
  the runnable-on-base evals.

### WS-5 — Guided structured decode fast-forward + W7 fused streaming decoders (scope: `packages/inference/llama.cpp` submodule decode loop, `omnivoice-fuse/src/`, `packages/app-core/src/services/local-inference/dflash-server.ts`, `structured-output.ts`)
- **Guided structured decode** — the producer (`buildResponseGrammar`/`ResponseSkeleton`),
  the plan (`compilePrefillPlan`/`ElizaPrefillPlan`/`eliza_prefill_plan` request field),
  the runtime wiring (`dflash-server.ts` folds in `grammar`/`grammar_lazy`/`grammar_triggers`/
  `prefill`/`eliza_prefill_plan` when an `elizaSchema` carried a plan), the off switch
  (`MILADY_LOCAL_GUIDED_DECODE=1` / `providerOptions.eliza.guidedDecode`), the build
  reporter (`server-structured-output.mjs`), the tests, and the static token-savings
  bench (`verify/guided_decode_token_bench.mjs`, ≈28% aggregate forced) are **all in
  tree and correct** (this landed — commits up to `fdba7f8033`). The **gap** is the
  fork-side forced-token fast-forward: a server decode-loop change that consumes
  `eliza_prefill_plan` (parse in `server-task.cpp`, splice each `run.text`'s token ids
  without a forward pass, advance to the next free param) — turning ≈28% "tokens the
  grammar forces" into ≈28% **fewer `decode()` calls**. This is a **real fork commit**
  (structural — not a regex `kernel-patches/` patch) + a submodule bump (C2 owns the
  pin); the runtime already sends `eliza_prefill_plan` and degrades to grammar-only
  (byte-identical output) when the server doesn't consume it. Also make the dflash
  drafter draft the *value* tokens so the forced spans cost zero draft/verify cycles
  (the spec loop is in `tools/server/server-context.cpp`). Extend `dflash-structured.test.ts`
  with a fork-level equivalence test (real model, plan vs no-plan → identical output +
  fewer `decode()` calls) before shipping the fast-forward.
- **W7 fused streaming decoders** — implement `eliza_inference_{asr,tts}_stream_*` +
  `eliza_inference_set_verifier_callback` in the fused `libelizainference` (today
  honest stubs): OmniVoice incremental synth emitting PCM as decoded (mind the
  vocoder's minimum-lookahead floor — measure + document the first-PCM-byte lower
  bound, don't pretend it's zero), Qwen3-ASR incremental decode emitting partials.
  Wire the ring-buffer hand-off (stage N's output ring = stage N+1's input ring — the
  JS side already has `InMemoryAudioSink`/`PushMicSource`/`PcmRingBuffer`; this is the
  *native* side feeding them chunk-by-chunk instead of one batch buffer at end-of-turn).
  Implement the within-turn `madvise(MADV_DONTNEED)` RSS trim seam (the ASR-phase seam
  partly exists per commit `48425d0b24`). **Weight-fusion verdict** (cluster-4 §B.5):
  "fuse the model graphs into one ggml graph" is **not tractable / not worth it** —
  the text model is a decoder-only transformer, OmniVoice is an AR codec model + a
  non-transformer vocoder; they don't share KV configs/layer counts/op sets and run at
  different cadences (ASR windowed / text per-token / TTS per-codec-frame) with
  *streaming* dependencies, not a static DAG. AGENTS.md §4 already has the correct
  decomposition (shared scheduler + mmap + kernel set + budget, not shared KV memory).
  What ships: one process, one llama.cpp lib, one ggml ABI; shared weight `mmap`;
  shared kernel set + budget; the verifier callback coupling the spec loop + TTS
  chunker in-process; zero IPC / zero file writes. Document the "fuse the models
  directly" idea as a future *model-architecture* direction (an omni model that trains
  the ASR encoder + text decoder to share a backbone — Cluster 3 territory) in
  `AGENTS.md` §4 / `RELEASE_V1.md`, don't gate v1 on it. Build + unit-test the
  streaming decoders on `linux-x64-cpu-fused`/`linux-x64-vulkan-fused` (locally); the
  iOS/Android in-process path = needs-hardware. The streaming entry points need a
  per-backend dispatch-verify smoke too.

### WS-6 — Two-agents duet harness + latency instrumentation + emotion fidelity (scope: `packages/app-core/scripts/voice-duet.mjs`, `voice-interactive.mjs`, `latency-trace.ts`, `voice/expressive-tags.ts`, the e2e test, `eliza1_gates.yaml`, `reports/`)
- **`voice-duet.mjs`** (`bun run voice:duet`) — extend `voice-interactive.mjs`: two
  `LocalInferenceEngine` instances (one process or two behind a flag), same tier bundle
  (0.6b first, then 1.7b), different `Character` JSON each → different room+system
  prompt+persona; A's `replyText` → A's TTS → PCM → an `InMemoryAudioSink` → a
  `PcmRingBuffer` that is B's `PushMicSource` → B's VAD+streaming transcriber → B's
  `VoiceTurnController.generate` (the real Stage-1 forced-grammar message-handler path)
  → B's `replyText` → … endless (or `--turns N`). All tricks on (DFlash, KV prewarm,
  guided structured decode, fused streaming, reduced-mode fallback only if a backend
  can't dispatch). `--model`, `--turns`, `--character-a/-b` (default two baked-in
  personas — runs with no extra files), `--seed-text`, `--report out.json`, `--ring-ms`,
  + the sweep knobs (`--parallel`, `--draft-max`, `--ctx-size-draft`, `--prewarm-lead-ms`,
  chunker thresholds). Honesty: if the bundle / fused lib / DFlash binary / required
  kernels are missing → print the checklist + exit non-zero, no silent stub-TTS duet.
- **Automated e2e test** — `voice-duet.e2e.test.ts` (or extend `interactive-session.e2e.test.ts`):
  *wiring* (unconditional, stub backends): two engines + stub TTS + a `DuetAudioBridge`
  + two `TestTranscriber`s + two fake echoing `generate`s → assert A's TTS PCM lands in
  B's ring, B sees it → B's reply lands in A's ring, `--turns 3` runs without deadlock,
  both tracers recorded ≥1 turn, the cross-ring stays bounded. *real-output* (`it.skipIf(!realBackendPresent)`):
  the existing `realBackendPresent` probe (catalog kernels advertised + fused build) →
  a real 3-turn duet on `eliza-1-0_6b`, assert >0 PCM crosses each direction, no crash,
  the report JSON validates. **Don't fake a "real" run.**
- **Latency instrumentation** — `latency-trace.ts`: add `peer-utterance-end` (the
  duet's headline t0 — when the producing agent drained its last PCM into the cross
  ring), `audio-first-into-peer-ring` (replaces `audio-first-played` in the duet — no
  speakers), `replyText-first-emotion-tag`; derived: `ttftFromUtteranceEndMs`
  (peer-utterance-end → llm-first-token — **THE headline number**),
  `replyTextFirstCharFromUtteranceEndMs`, `firstTtsPcmFromUtteranceEndMs`,
  `firstAudioIntoPeerRingFromUtteranceEndMs`. Extend `LATENCY_DERIVED_KEYS` + the
  `DERIVED_SPANS` table — the dev endpoint + `voice-latency-report.mjs` pick them up by
  iterating the key array. A sibling `VoiceRunMetrics` accumulator: DFlash accept-rate
  (server `/metrics` `n_drafted_accepted/n_drafted`), structured-decode token-savings %
  (feed `guided_decode_token_bench.mjs`'s counter), tok/s, RSS-over-the-run (server
  `VmHWM` via `/proc/<pid>/status`, flag `leakSuspected` if monotone-increasing). One
  `reports/porting/<date>/voice-duet-bench-<model>.json` (+ a `.md`), schema-aligned
  with `eliza1_gates.yaml` so `eliza1_gates_collect.mjs` ingests it.
- **`eliza1_gates.yaml`** — point `first_token_latency_ms` at `ttftFromUtteranceEndMs.p50`
  (the correct anchor for "speech-end → first token"); add `duet_round_trip_ms`
  (peer-utterance-end → first-audio-into-peer-ring), `structured_decode_token_savings_pct`;
  the new gates land `provisional: true` until a real-HW run calibrates them; flip
  `expressive_tag_faithfulness`/`expressive_mos`/`expressive_tag_leakage` to be measured
  by the emotion-fidelity harness (still provisional).
- **The scientific grind** — `verify/voice_duet_sweep.mjs`: run `voice-duet.mjs --turns 20
  --report …` across a grid of the sweep knobs (DFlash `--parallel`/`--draft-max`/`--ctx-size-draft`,
  chunker phrase-flush thresholds, `--prewarm-lead-ms`, `--ring-ms`, KV-cache types,
  backend selection), collect p50/p90/p99 + accept-rate + tok/s + RSS into one CSV, emit
  a before/after table. Profile → tune the dominant stage → re-run → repeat until the
  round-trip plateaus, on 0.6b then 1.7b. Document the winning config per tier in the
  manifest's `evals` block + a `reports/` artifact. (On CPU today TTS dominates — RTF
  ~6–10× — so the real grind waits on WS-3's GPU-fused build + WS-5's streaming TTS; on
  a GPU-fused build the LLM TTFT + prewarm + chunker thresholds become the lever.)
- **Emotion through the pipeline:**
  - *Schema:* the omnivoice-singing inline-tag vocabulary verbatim (decision #2 above):
    `EXPRESSIVE_TAGS` constant + `parseExpressiveTags(replyText): { cleanText, segments:
    [{text, emotion, singing}] }` in `voice/expressive-tags.ts`. Tags inline, scoped
    until the next tag or end-of-phrase (matches the chunker's split).
  - *Generation:* the voice-output prompt instructs the model to emit emotion markup
    with `replyText` (and this goes in WS-4's `voice_emotion` corpus task). It's a
    `free-string` span — no grammar change. (Optionally a Stage-1 `emotion` enum
    field-evaluator if WS-6 wants it — auto-flows into skeleton+grammar+prefill.)
  - *Parse → TTS:* `parseExpressiveTags` extracts the tags; pass the in-scope emotion
    to OmniVoice's controls (the `emotion_spec` param on `tts_synthesize` /
    `tts_synthesize_stream` — decision #3). `makeTextToSpeechHandler` already does NOT
    strip tags (passes "singing, emotion tags, lyrical phrasing" through).
  - *Perceive:* check whether the GGUF-converted Qwen3-ASR emits an emotion label in
    the transcript (a `<emotion>…</emotion>` span / a special token in
    `eliza-1-asr-mmproj.gguf`'s special-token map). If it does → tag the transcript
    with it. If it doesn't → fall back to a tiny emotion-from-audio head (Silero-sized
    classifier) OR a pitch/energy-contour heuristic in `transcriber.ts` — recorded as
    "approximated", not faked.
  - *Fidelity metric:* compare the emotion B's ASR *perceives* in A's speech against the
    emotion A *intended* (the tag A emitted) — an emotion-fidelity score across the loop,
    reported alongside the latency numbers. Provisional gates in `eliza1_gates.yaml`.

## 4. H200 / Cerebras / HF job list (exact invocations — run when creds present)

> All cloud spend is approved; `--yes-i-will-pay` is the gate. If the operator has
> no live Nebius/Vast login or no `CEREBRAS_API_KEY`/`HF_TOKEN`, these stay queued
> (documented in the DONE section), not faked.

**Cerebras data gen (WS-4 step 1):**
```
CEREBRAS_API_KEY=…  CEREBRAS_MODEL=gpt-oss-120b  uv run python packages/training/scripts/build_eliza1_sft_0_6b.py
# (with the structured_decode + voice_emotion task additions)
```

**H200 — 0.6b full-corpus APOLLO SFT (the headline FINETUNE):**
```
REGISTRY_KEY=qwen3-0.6b  bash packages/training/scripts/cloud/run-on-cloud.sh \
  --provider nebius --task train --gpu h200 --tier 0_6b --yes-i-will-pay
# (or --provider vast; epochs 3, apollo_mini rank-1, seq 4096, eff. batch 8, bf16, lr 1e-5, grad-ckpt on)
```

**H200 — 1.7b SFT at seq ≥4096:**
```
bash packages/training/scripts/cloud/run-on-cloud.sh --provider nebius --task train --gpu h200 --tier 1_7b --yes-i-will-pay
```

**H200×1 / B6000 — 9b SFT; H200×2 FSDP — 27b SFT:**
```
bash packages/training/scripts/cloud/run-on-cloud.sh --provider vast --task train --gpu blackwell6000 --tier 9b --yes-i-will-pay
bash packages/training/scripts/cloud/run-on-cloud.sh --provider vast --task train --gpu b200 --tier 27b --yes-i-will-pay
# (or --provider nebius --gpu h200: gpu-h200x1 for 0_6b/1_7b/9b, gpu-h200x2+FSDP for 27b)
```

**H100/H200 — full ggml-cuda integration build + kernel-verify + e2e bench (WS-2/WS-3):**
```
bash packages/training/scripts/cloud/run-on-cloud.sh --provider vast --task kernel-verify --gpu h100 --yes-i-will-pay
bash packages/training/scripts/cloud/run-on-cloud.sh --provider vast --task bench --gpu h100 --tier 0_6b --yes-i-will-pay
# native-NVIDIA Vulkan: pick a vast box with a desktop NVIDIA GPU for the same kernel-verify
# ROCm: --gpu mi300 if available → rocm_runner.sh --report + hip_verify
# linux-aarch64-cuda / GH200: --gpu gh200 if vast has it (rare) → gh200_runner.sh --report (27b-256k/27b-1m)
```

**HF publish (WS-4 step 5 — only on a green gate):**
```
HF_TOKEN=…(write to elizaos)  uv run python packages/training/scripts/publish/orchestrator.py …
# elizaos/eliza-1-0_6b (bundle, recommended channel), elizaos/eliza-1-0_6b-sft (raw safetensors),
# elizaos/eliza-1-training (SFT refresh), elizaos/eliza-1-sft-0_6b, elizaos/eliza-1-evals
# refuses on a red gate — don't override; still publish datasets + the negative result honestly
```

## 5. Verify gates (Phase 4 — must all pass or be documented-HW-gated)

```
make -C packages/inference/verify \
  kernel-contract reference-test vulkan-verify vulkan-verify-multiblock vulkan-verify-fused \
  cuda-verify cuda-verify-fused cpu-bench cpu-dispatch-smoke
# + the H200 ones via run-on-cloud.sh (the ~30 GB ggml-cuda build, the e2e CUDA bench)
bun run release:v1:prep
node packages/inference/verify/eliza1_gates_collect.mjs
node packages/inference/verify/bargein_latency_harness.mjs
node packages/inference/verify/thirty_turn_endurance_harness.mjs
node packages/inference/verify/dflash_drafter_runtime_smoke.mjs --bench
bun run voice:duet --turns 3 --report …            # (gated on the real bundle)
bun run voice:interactive --list-active             # (and --platform-report)
python3 -m pytest packages/training/scripts/
bunx turbo run lint                                  # 138/138
NODE_OPTIONS='--max-old-space-size=8192' bunx turbo run typecheck --concurrency=1 --filter='!@elizaos/example-code'
bunx biome check .                                   # whole tree — the stretch goal
bun run build && bun run test && bun run test:e2e
gh run list / gh workflow list                       # every workflow green
```

## 6. Status — DONE section (updated as work lands)

> _(Phase 5 fills this in: what landed, what's genuinely HW/credential-gated, the
> latency/emotion benchmark numbers, what got published to HF.)_

### Director session 2026-05-12 (single-agent — no `Agent`/`Task` tool available; the
### implementation "swarm" is the concurrent automation sessions on `develop`)
- Phase 1: 4/5 research plans landed (`.swarm/plans/cluster-{2,3,4,5}.md`); cluster-1's
  plan file didn't land — its scope is in `.swarm/TODO.md` §"Cluster 1" and is folded
  into WS-1 above.
- Phase 2: this `IMPLEMENTATION_PLAN.md`.
- Direct fixes landed by the director (CI gates that were red on `develop`):
  - `plugin-suno` biome `format:check` failure (commit `54669611f0`) — was breaking the
    `Quality (Extended)` workflow's Format Check job.
  - 5 electrobun RPC contract test files imported `bun:test` but the runner is vitest
    (commit `b913e884d4`) — was breaking the `Electrobun Desktop Contract` Tests job.
- Identified-but-not-yet-fixed CI breakages (for WS-1): `@elizaos/agent#typecheck` 56
  errors from a split `drizzle-orm@0.45.2+<hash>` install (needs a root `overrides` pin
  or peer-dep alignment); the `Tests` workflow's `bun install --ignore-scripts` →
  placeholder-`bun`-binary → partial-postinstall → missing workspace symlinks cascade
  (`Failed to resolve entry for @elizaos/capacitor-llama`/`@elizaos/app-wallet`,
  `Cannot find package 'ethers'`) — a `.github/actions/setup-bun-workspace/action.yml`
  fix; `packages/training/uv.lock` churn + missing `hypothesis` test dep.
