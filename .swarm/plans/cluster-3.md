# Cluster 3 — Build all models & bundles + fine-tune the 0.6b — RESEARCH PLAN

Scope (from `.swarm/TODO.md`): build & stage every device-tier bundle with real
fork-built GGUFs + the Milady kernel/quant stack, distill the DFlash drafters per
tier (really, not stamp-only), fine-tune the 0.6b with APOLLO, eval vs the
benchmarked baseline, conditionally publish weights+datasets+evals, progress the
1.7b SFT, and stage 4b/2b/9b/27b where they fit. **Research-only deliverable;
heavy GPU work goes to the impl phase via `run-on-cloud.sh --yes-i-will-pay`.**

---

## A. Critical assessment — current state

### Bundles staged
- Only **`0_6b` and `1_7b`** bundles exist at `~/.eliza/local-inference/models/eliza-1-{0_6b,1_7b}.bundle/` (2.4 GB / 3.8 GB). `9b`, `27b`, `27b-256k`, `27b-1m` are **not staged at all**.
- Both staged bundles are `releaseState=weights-staged`, `publishEligible=false`, `defaultEligible=false`. `evidence/release.json` `final.{evals,kernelDispatchReports,platformEvidence,sizeFirstRepoIds}=false`. `hf.status=blocked-weights-staged`. The text GGUFs are **substitute bytes** (upstream Qwen3-GGUF re-hosted via the staging scripts), not real fork builds: `provenance: eliza-1-text:Q3_K_M` / `dflash-drafter:stamp-only` / `recipe-output:turbo|fused|qjl|polar`. The 1_7b manifest's `kernels.verifiedBackends` shows several `fail`/`skipped` statuses.
- `base-v1` publish dry-runs already exit `EXIT_RELEASE_EVIDENCE_FAIL` (16) on these bundles (logged in `evidence/base-v1-dry-run-*.log`) — exactly because they're substitute bytes, not a real fork build.
- So: **no real fork-built GGUF exists for any tier yet**; the canonical `elizaos/eliza-1-*` HF repos do not exist; the runtime catalog placeholders re-host upstream Qwen3-GGUF (`benchmarks/MODELS_STATUS.md` confirms).

### Quant-recipe state
- The recipes (`packages/training/scripts/quantization/{turboquant,polarquant,qjl,fused_turboquant,gguf_eliza1}_apply.py`) + `test_recipes_smoke.py` are green on CPU. `gguf_eliza1_apply.py --release-state base-v1` is wired. **Known gap (honestly recorded):** the fork's `convert_hf_to_gguf.py` does **not** yet emit native `q4_polar` weights, so locally-built GGUF bodies are **Q8_0/Q4_K_M with `weight_quant.deferred: true`**; the PolarQuant/QJL/TurboQuant *sidecars* (`polarquant_artifacts.*`, `qjl_config.json`, `turboquant.json`, `eliza1_manifest.json`) are produced and the runtime kernels exist — but the body bytes aren't native-Polar yet. This is a known deferral, not a Cluster-3 fix unless Cluster 2's converter work lands it.

### DFlash drafter
- `distill_dflash_drafter.py` is a real KD pipeline: forward-KL on the target's top-k logits + a CE floor, `AdamW` (the drafter's own optimizer — APOLLO is the 0.6b SFT's optimizer, the drafter recipe is unrelated), asserts byte-identical tokenizers, converts to GGUF via the fork's `convert_hf_to_gguf.py`, stamps `dflash-draft.target_checkpoint_sha256`. Only `--synthetic-smoke` has run (CI, offline). The staged bundles carry **stamp-only** drafters (`provenance: dflash-drafter:stamp-only`). Student bases: Qwen3-0.6B → 1_7b/4b, Qwen3-1.7B → 9b/27b/27b-256k/27b-1m. **0_6b gets no drafter** (no smaller Qwen3 base) — confirmed in `benchmarks/MODELS_STATUS.md`, `catalog.ts`, and the 0_6b APOLLO report §5. Acceptance gates per tier: 0.45/0.50/0.55…
- (There's also a stray `qwen3.5-4b-dflash*.gguf` + `SmolLM2-360M-Instruct-Q4_K_M.gguf` in `~/.eliza/local-inference/models/` from an earlier 4b experiment.)

### Fine-tune pipeline (0.6b)
- **APOLLO is wired and faithful to the paper.** `train_local.py` is APOLLO-only (`--optimizer {apollo,apollo_mini}`, default `apollo`, rank 256 / mini rank 1, scale, `update_proj_gap=200`, fp32 moments under FSDP bf16; muon/adamw are *not exposed*). `scripts/training/optimizer.py` routes only 2-D weight matrices through the projector. `model_registry.py` `qwen3-0.6b` → `Qwen/Qwen3-0.6B`, seq 4096, `apollo_mini` rank-1, bf16, lr 1e-5, epochs 3, grad-ckpt on, ChatML. `run_pipeline.py` orchestrates corpus→base-bench→APOLLO SFT→post-bench→aggregate+gate→quantize→quant-bench→eliza1-bundle(+dflash)→throughput-bench→(publish). `test_optimizer_cpu.py` has a loss-decrease test for both APOLLO recipes.
- **A smoke SFT already ran locally** (`eliza-1-0_6b-apollo-1778551769`): RTX 5080 16 GB, `apollo_mini`, seq 4096, eff. batch 8, 1 epoch over 8000 of 66,861 `data/final/train.jsonl` rows, eval_loss 1.315, ~82 min. Benchmark (`benchmarks/eliza-1-0_6b-apollo-1778551769/{base,finetuned}/`): **beats baseline `Qwen3-0.6B` on every measured axis, regresses none** (`format_ok` 0.0857→0.20, `claude_distill` format 27.3%→63.6%, `reply` parse errors 8→0, gen tps +33%) — but does **not** clear the absolute `format_ok` publish floor (0.20 < 0.5 smoke / 0.7 full) **because it's a 35-row smoke corpus + 1 epoch / 8k rows, not a full-corpus run**. Verdict in `reports/eliza1-0_6b-apollo-sft-2026-05-11.md`: **conditional GO — full-corpus run, then publish; block `defaultEligible` until a green full-corpus `format_ok`**. So Cluster 3's job here is **the real full-corpus run on the H200**, then re-eval, then conditional publish.
- A complete eliza1 sidecar bundle exists from an earlier checkpoint (`1778515903/milady-optimized-gpu/`): GGUF body `Q4_POLAR` (type 47), K-cache `QJL1_256` (46), V-cache `TBQ3_0` (43), `milady_manifest.json` — but it's stale (different weights); must re-run `gguf_eliza1_apply.py` against the chosen `final/` checkpoint.

### Fine-tune corpus
- Two corpora: the broad **`data/final/{train,val,test}.jsonl`** (66,861 train rows, 50 sources) and the focused benchmark-aligned **`datasets/eliza1-sft-0_6b/{train,val,test}.jsonl`** (1,436 train rows: action_selection 62, personality 35, tool_use 653, assistant 686 — built by `build_eliza1_sft_0_6b.py` from `action-selection-cases.ts` + personality-bench calibration + Cerebras `gpt-oss-120b` augmentation; ChatML rows, `train_local.py --train-file` compatible; privacy filter run as defense-in-depth). Cerebras path: `cerebras_client.py` (urllib OpenAI-compatible, `CEREBRAS_MODEL=gpt-oss-120b`, `CEREBRAS_API_KEY` env, retry/backoff, fail-loud).
- **`eliza_native_v1`** is the canonical/preferred direct input shape (`format_for_training.py`): one row per Vercel-AI-SDK model boundary with the exact request + normalized response; the formatter also accepts trainable `eliza.eliza1_trajectory_record.v1` message rows and rendered chat-message rows. `format_for_training.py` runs the canonical Python privacy filter eagerly at import (no bypass). **Cross-cluster gap: the 0.6b corpus currently has NO structured-decode envelope rows (`format_pct` 0.0% — "smoke task mix never emits the TOON envelope") and NO emotion/singing tag rows** — those have to be added (see §D).

### Cloud runners
- **`scripts/cloud/run-on-cloud.sh`** (`--yes-i-will-pay` + fail-closed): `--task train --provider {vast,nebius}` delegates to `train_vast.sh provision-and-train` (canonical) or `train_nebius.sh full` (emergency H200 fallback — `gpu-h200x1` for 0_6b/1_7b/9b, `gpu-h200x2`+FSDP for 27b; needs `NEBIUS_PROJECT_ID`). `--task {kernel-verify,bench}` is **vast-only** (provisions a CUDA 12.8 instance, builds `linux-x64-cuda`, runs `cuda-verify`/bench, pulls JSON, tears down). `tier_to_registry_key`: `0_6b→qwen3-0.6b`, `1_7b→qwen3-1.7b`, `9b→qwen3.5-9b`, `27b*→qwen3.6-27b`. `--dry-run` spends nothing. **Note: TODO.md says "Nebius H200" / "cloud spend approved" while `train_vast.sh` is documented as canonical for 9b/27b — both paths exist; use whichever the operator has creds for.** Nebius CLI on this box is `federation` auth (browser SSO) → `nebius iam whoami` hangs headless → a real provision needs an operator with a live login (documented resume cmd in the 0_6b report §1).

### What fits locally (RTX 5080 Laptop 16 GB, sm_120, CUDA 12.8/13) vs needs the H200
- **Local-capable:** 0_6b APOLLO SFT seq 4096 (~8.5–9 GB peak), 1_7b APOLLO SFT at **seq ≤ 2048** (~15.3 GB; seq 4096 OOMs on the CE step — 152k-vocab logits transient, Liger broken — Triton can't JIT without `python3.12-dev`), 4b *calibration* forwards only, 2b with `--max-samples 1000 --max-seq-len 1024`. The fork CPU/CUDA build + `convert_hf_to_gguf.py` + the quant recipes + the local eliza1-bundle stage + `llama-bench` throughput all run here. The 0_6b/1_7b GGUF conversion + Q4_K_M + sidecars run locally.
- **Needs H200:** 9b full-param APOLLO SFT (~80 GB world budget, single H200/A100-80 — no FSDP), 27b (~190 GB, 2× H200 FSDP — single H200 OOMs even at seq 8k), the 9b/27b GGUF conversions of the *fine-tuned* checkpoints, the bigger DFlash drafters (Qwen3-1.7B student KD for 9b/27b), the 1.7b SFT at the **higher seq-len** (≥4096) once the OOM ceiling is lifted, and **the full-corpus 0.6b APOLLO run** (66k rows × 3 epochs ≈ ~9 GPU-hr locally vs ~1–2 H200-hr — the brief says do it on the H200). `27b-256k`/`27b-1m` long-context GGUFs need the `turbo3_tcq` generic K/V cache type (Cluster 2's `ggml.c` type-traits gap) + a GH200/Hopper aarch64 verify (`gh200_runner.sh`).

### The 0.6b baseline the fine-tune must beat
- `benchmarks/MODELS_STATUS.md` "Run status" row + `benchmarks/eliza-1-0_6b-apollo-1778551769/base/`: **base = upstream `Qwen3-0.6B`** on `data/final/test.jsonl` via `scripts/benchmark/eliza_bench.py` + `native_tool_call_bench.py`. The bar: beat base on `format_ok` (was 0.0857), `claude_distill` format_pct (27.3%), `reply`/`message_handler` parse errors, gen tps (68.5) — **and regress none** — AND clear the absolute publish floor (`format_ok ≥ 0.70` full-mode in `eliza1_gates.yaml` 0_6b row; the 0.55 `text_eval` floor is the v2 quality gate). The smoke run hit the first half but not the floor; the full-corpus run is expected to clear it.

---

## B. The build/stage plan — per tier

> Prereq for **every** real GGUF: Cluster 2 must ship a kernel-complete,
> dispatch-verified `llama-server`/static lib + `convert_hf_to_gguf.py` per
> backend (`build-llama-cpp-dflash.mjs` must exit non-zero on a missing §3
> kernel — no fallback build). Until then, every "real fork build" step below is
> blocked on Cluster 2 and the bundles stay `weights-staged` (honest, not faked).

### `0_6b` (local box)
1. Land the **full-corpus 0.6b APOLLO SFT** (see §C) → `checkpoints/eliza-1-0_6b-apollo-<ts>/final/`.
2. `convert_hf_to_gguf.py` (fork) → `text/eliza-1-0_6b-32k.gguf`, then `gguf_eliza1_apply.py --release-state base-v1` (TurboQuant Q3 + QJL K-cache + PolarQuant V-cache sidecars; body Q4_K_M with `weight_quant.deferred:true` until the converter emits `q4_polar`).
3. No DFlash drafter (no smaller Qwen3 base) — `dflash/` carries no real drafter; `target-meta.json` records "n/a".
4. `stage_eliza1_source_weights.py` + `stage_eliza1_bundle_assets.py` (link-mode hardlink) for tts/asr/vad/embedding(omitted on 0_6b — `--pooling last` on the text backbone)/cache → `~/.eliza/local-inference/models/eliza-1-0_6b.bundle/`.
5. `eliza1_manifest.py` + `eliza1_platform_plan.py` regen → `ELIZA_1_GGUF_{READINESS.md,PLATFORM_PLAN.json}`; `finalize_eliza1_evidence.py`.
6. Runnable-on-base evals: `bun run release:v1:prep` + the per-backend `*-verify` (CPU local; Vulkan Intel-ANV local; CUDA RTX 5080 local; Metal/iOS/Android = needs-hardware), `eliza1_gates_collect.mjs` per backend; e2e/30-turn via `voice:interactive`/`interactive-session.e2e.test.ts`. (NOT the v2 text-quality gate — that's the FINETUNE go/no-go below.)

### `1_7b` (local box for SFT-at-2048 + GGUF; H200 for SFT-at-≥4096)
- SFT: continue the in-progress run at `--max-seq-len 2048` (fits, ~15.3 GB), OR run it on the H200 at seq ≥4096 (the brief says the H200 lifts the seq-len ceiling). `run-on-cloud.sh --provider {vast,nebius} --task train --gpu h200 --tier 1_7b --yes-i-will-pay`.
- GGUF: `convert_hf_to_gguf.py` → `text/eliza-1-1_7b-{32k,64k}.gguf`; `gguf_eliza1_apply.py` (TurboQuant Q3/Q4 + QJL K-cache; ctx 64k uses QJL when ctx>8k).
- DFlash drafter: real KD run — `distill_dflash_drafter.py --tier 1_7b --student-base Qwen/Qwen3-0.6B --target-checkpoint <1_7b final/> --target-gguf <1_7b text gguf> --dataset <SFT corpus>` (fits the 16 GB box for a 0.6B student; or H200 for headroom) → `dflash/drafter-1_7b.gguf` (stamped), then the acceptance-window eval → `dflash/target-meta.json` (gate 0.50). This is the `dflash-draft.target_checkpoint_sha256` coordination point with the drafter side.
- Bundle/manifest/evals as 0_6b.

### `9b` (H200)
- SFT: `run-on-cloud.sh --provider vast --task train --gpu blackwell6000 --tier 9b --yes-i-will-pay` (single 96 GB card, ~83% util at the 80 GB budget) — or `--provider nebius --gpu h200` (`gpu-h200x1`, single H200). Base `Qwen/Qwen3.5-9B` (qwen3_5, text 32 layers, 256 head_dim, 248k vocab), seq 16384, full `apollo`@rank-512. (Note: per the brief the 9b is one of the "stage what fits where" tiers; the user's headline FINETUNE deliverable is the 0.6b — the 9b/27b SFTs are progress-where-budget-allows, not gate-blocking.)
- GGUF: `convert_hf_to_gguf.py` of the fine-tuned (or base, for `base-v1`) checkpoint → `text/eliza-1-9b-{64k,128k}.gguf` + `vision/mmproj-9b.gguf`; `gguf_eliza1_apply.py` (TurboQuant Q4 + QJL + Polar + `turbo3_tcq` for ≥64k). Voice quant `Q8_0` on 9b+.
- DFlash drafter: `distill_dflash_drafter.py --tier 9b --student-base Qwen/Qwen3-1.7B …` on the H200 → `dflash/drafter-9b.gguf` (stamped), acceptance eval (gate 0.55).
- Bundle: `stage_eliza1_bundle_assets.py --tier 9b` (asr = `ggml-org/Qwen3-ASR-0.6B-GGUF` for 9b, `1.7B` for 27b tiers; embedding = `Qwen/Qwen3-Embedding-0.6B-GGUF`); manifest/platform-plan/evidence; `cuda-verify`/`cuda-verify-fused` on the H200 via `run-on-cloud.sh --task kernel-verify --gpu h200`; ROCm = needs an AMD GPU.

### `27b`, `27b-256k`, `27b-1m` (H200×2 / GH200)
- SFT: `run-on-cloud.sh --provider vast --task train --gpu b200 --tier 27b --yes-i-will-pay` (2× B200 ~366 GB FSDP, ~52% util at the 190 GB budget) — or `--provider nebius --gpu h200` (`gpu-h200x2`+FSDP). Base `Qwen/Qwen3.6-27B` (qwen3_6, text 64 layers, 256 head_dim, 248k vocab), seq 65536. **Single H200 OOMs even at seq 8k** — must be 2-GPU FSDP.
- `27b-256k` / `27b-1m` are **context variants of the 27b tier**, not separate trainings — same checkpoint, longer-ctx GGUF (`text/eliza-1-27b-{128k,256k,1m}.gguf`). The 256k/1m K-cache rides `turbo3_tcq` (Cluster 2's `ggml.c` type-traits gap is a hard prereq for these to be a real generic K/V cache type) + a GH200/Hopper aarch64 verify (`verify/gh200_runner.sh`).
- GGUF: `convert_hf_to_gguf.py` → text + `vision/mmproj-27b*.gguf`; `gguf_eliza1_apply.py` (TurboQuant Q4 + QJL + Polar + `turbo3_tcq` + fused-attn); voice `Q8_0`.
- DFlash drafter: `distill_dflash_drafter.py --tier 27b --student-base Qwen/Qwen3-1.7B …` on the H200 → `dflash/drafter-27b.gguf` (stamped, same drafter shared across 27b/27b-256k/27b-1m), acceptance eval (gate 0.55).
- Bundle/manifest/platform-plan/evidence; CUDA verify on H200; GH200 verify for the long-ctx variants.

### `4b` / `2b` (opportunistic — "stage what fits")
- `4b`: full SFT at seq 4096 expects OOM on 16 GB → fall back to: download `Qwen/Qwen3-4B` → Q4_K_M GGUF → bench + run the quant-chain *calibration* forwards (those fit 16 GB). Or a 24 GB card via vast (`--gpu rtx4090`/`l40s`). There's already a stray 4b dflash GGUF in `~/.eliza/.../models/`.
- `2b`: `Qwen3.5-2B` is qwen3_5 VLM + hybrid linear-attn (248k vocab → big CE transient) — needs the qwen3_5 model class loadable + Liger (broken) or a tiny seq; `--max-samples 1000 --max-seq-len 1024` smoke only.

---

## C. The 0.6b fine-tune plan (the headline FINETUNE deliverable)

1. **Data gen via Cerebras `gpt-oss-120b`.** Refresh/extend the corpus:
   - `CEREBRAS_API_KEY=… uv run python scripts/build_eliza1_sft_0_6b.py` → regenerate `datasets/eliza1-sft-0_6b/{train,val,test}.jsonl` **with the cross-cluster additions** (see §D): structured-decode-envelope rows (Cluster 4's Stage-1 envelope / action-params / enums shape — so `format_pct` stops being 0%) + emotion/singing-tag rows (Cluster 5's `replyText` emotion schema — `[happy]`/`[sad]`/`[whisper]`/… + non-verbals). Run `validate_corpus.py`/`validate_eliza1_trajectory_dataset.py` + the privacy filter (`format_for_training.py` does it at import; `build_eliza1_sft_0_6b.py` does it as defense-in-depth).
   - Decide the training set: the full `data/final/` corpus (66k, broad) **concatenated ahead of** the benchmark-aligned `datasets/eliza1-sft-0_6b/` mix-in (the README's recommended composition), so the full-corpus run both gets breadth and stays calibrated to the `format_ok` gate. Run it through `format_for_training.py` (eliza_native_v1 / chat_messages → ChatML).
2. **APOLLO training** on the H200 (the brief: ~1–2 H200-hr, full-corpus):
   `REGISTRY_KEY=qwen3-0.6b bash scripts/cloud/run-on-cloud.sh --provider nebius --task train --gpu h200 --tier 0_6b --yes-i-will-pay` (or `--provider vast`), epochs 3, `apollo_mini` rank-1 (registry default), seq 4096, eff. batch 8 (or `--micro-batch 2 --grad-accum 4` for free throughput), bf16, lr 1e-5, grad-ckpt on. Output: `checkpoints/eliza-1-0_6b-apollo-<ts>/final/` + `gate_report.json` + `pipeline-summary.json` (the cloud script also runs the post-train quantize + base-vs-finetuned bench remotely and rsyncs back). **NOT muon/adamw — APOLLO is the only optimizer the local entrypoints expose, by design.** If the operator has no live Nebius/Vast login the resume command is in the 0_6b report §1; until then the 0.6b stays at the smoke-run state (honest).
3. **Eval vs the benchmarked baseline.** `run_pipeline.py` stage 1/3/4 (or `scripts/benchmark/eliza_bench.py` + `native_tool_call_bench.py` on `data/final/test.jsonl` in **full mode**, not the 35-row smoke slice) + `scripts/eval/eliza1_eval_suite.py` for `text_eval` + `eliza1_gates_collect.mjs` for the structural gates → `evals/aggregate.json` + `gate_report.json`. The bar: beat upstream `Qwen3-0.6B` on every axis, regress none, **and** clear `format_ok ≥ 0.70` (full-mode 0_6b gate). The smoke run already beats the baseline qualitatively; the full-corpus run is the one that has to clear the absolute floor.
4. **Re-stamp the eliza1 bundle** against the new `final/`: `gguf_eliza1_apply.py` → `text/eliza-1-0_6b-32k.gguf` (`Q4_POLAR` body if the converter supports it by then, else Q4_K_M+`deferred`), sidecars, manifest, `finalize_eliza1_evidence.py`; stage the bundle as a **candidate revision** (not `defaultEligible`).
5. **Conditional HF publish** (`packages/training/scripts/publish/orchestrator.py` + `HF_PUBLISH_PLAN.md` repo plan, `HF_TOKEN` with write to `elizaos`):
   - **If it beats the baseline AND clears `format_ok`:** publish `elizaos/eliza-1-0_6b` (the canonical *bundle* repo — fine-tuned text GGUF at `text/eliza-1-0_6b-32k.gguf`, manifest, auto-rendered README, `recommended` channel — drop the `base-v1` banner; `defaultEligible` flips true only if every required kernel is verified on every supported backend AND every required eval passes — realistically `defaultEligible: false` until Metal/iOS/Android verify lands), `elizaos/eliza-1-0_6b-sft` (raw un-quantized TRL `final/` safetensors via `push_model_to_hf.py`/`publish_eliza1_model.py`), the adapted **datasets** (`elizaos/eliza-1-training` SFT split refresh via `publish_dataset_to_hf.py` + `elizaos/eliza-1-sft-0_6b` if the manifest names a tier repo), and the **eval/bench results** (`elizaos/eliza-1-evals` — baseline-vs-finetuned table, `eliza1_eval_suite` outputs, kernel-verify evidence we have, `gate_report.json`, throughput snapshots).
   - **If it does NOT beat the baseline / clear the floor:** publish **nothing model-side** (the orchestrator refuses on a red gate, by design — don't override). Still publish the datasets + the negative result honestly to `elizaos/eliza-1-evals` (`HF_PUBLISH_PLAN.md` "conservative subset"). Report why in `reports/`.
6. The 1.7b SFT continuation rides the same machinery (§B `1_7b`) — it's "in progress" (seq 2048 after a seq-4096 CE OOM); the H200 lifts the seq-len ceiling, so re-run at seq ≥4096 there, then bench/quant/bundle. Not a gate-blocking deliverable, but on the list.

---

## D. Cross-cluster dependencies

1. **Cluster 2 → Cluster 3 (hard blocker for every real GGUF + every kernel-verified bundle).** No real fork-built `text/*.gguf` (or drafter GGUF) for any tier until `build-llama-cpp-dflash.mjs` + `aosp/compile-libllama.mjs` + the iOS xcframework build produce a kernel-complete, dispatch-verified `llama-server`/static lib **per backend** (`build-llama-cpp-dflash.mjs` must exit non-zero on a missing §3 kernel — no fallback build), and `convert_hf_to_gguf.py` is the fork's. The `turbo3_tcq` `ggml.c` type-traits gap (block layout exists in `ggml-common.h`, no type-traits entry) blocks `27b-256k`/`27b-1m` being a real generic K/V cache type. Until those land, the bundles stay `weights-staged` (honest placeholder, never a fabricated hash) — exactly the current state. The native-`q4_polar` converter gap (Cluster 2's converter work) gates whether GGUF bodies are native-Polar or `Q4_K_M`+`deferred`.
2. **Cluster 4 → Cluster 3 (corpus shape).** The 0.6b fine-tune corpus must include the **structured-decode shape** — the Stage-1 envelope / action-param / evaluator-param / enum surface (`buildResponseGrammar`/`ResponseSkeleton`/the `eliza_prefill_plan` "narrow-to-singleton → auto-complete + advance" behavior) so the model learns to emit a well-formed TOON/JSON document (today `format_pct` is 0% in the smoke mix). Coordinate the exact envelope JSON with Cluster 4's audit; feed it into `build_eliza1_sft_0_6b.py` (a new `structured_decode` task) + the Cerebras augmentation prompts.
3. **Cluster 5 → Cluster 3 (corpus shape).** The corpus must include **emotion/singing tags** in the voice-output `replyText` — the omnivoice-singing vocabulary (`[singing]`/`[happy]`/`[sad]`/`[whisper]`/`[angry]`/`[nervous]`/`[calm]`/`[excited]` + preserved non-verbals `[laughter]`/`[sigh]`) parsed out and passed to OmniVoice's emotion controls. Coordinate the emotion-tag schema with Cluster 5's emotion sub-agent (it may also grow a `replyText.emotion` field that Cluster 4's structured-decode handles); feed it into `build_eliza1_sft_0_6b.py` (a new `voice_emotion` task) + the augmentation prompts. The training target is the `eliza_native_v1` trajectory shape **including** the structured-output envelope **and** the voice-emotion fields.
4. **Cluster 3 → Cluster 5 (model artifact).** Cluster 5's two-agents-talking e2e benchmark runs the **0.6b then 1.7b** as agents A/B — so Cluster 3's fine-tuned (or, until the FINETUNE go/no-go is green, base-v1) bundle is the artifact Cluster 5 consumes. The fine-tuned drafter (1.7b+) feeds Cluster 5's `dflash_acceptance` / `dflash_speedup` metrics.
5. **Cluster 3 → Cluster 1 (hygiene).** New/changed training scripts must pass `bunx tsc --noEmit` (for any TS) + `py_compile`/the training test suites; new transform/synthesize scripts must run through `validate_corpus.py` (CLAUDE.md mandate). `uv.lock` churn is Cluster 1's, but a 0.6b run that adds a `[train]` dep would touch it — coordinate.

---

## E. Blockers / open questions

- **The fork build (Cluster 2) is the gate** — nothing real ships until it does. Current bundles are honest `weights-staged` placeholders.
- **Cloud creds.** Nebius CLI on this box is `federation`/browser-SSO → headless `nebius iam whoami` hangs; vast needs `VAST_API_KEY`. A real H200/B200 run needs an operator with a live login (resume cmds documented). Cloud spend is "approved" per TODO.md, but the impl phase still needs the creds present.
- **Liger is broken** (Triton can't JIT without `python3.12-dev`) → 1.7b SFT can't do seq 4096 / 2b can't do seq 8192 on 16 GB locally; the H200 sidesteps it. Either fix the python env (Cluster 1?) or accept the H200 detour.
- **Native `q4_polar` converter gap** — GGUF bodies stay `Q4_K_M`+`weight_quant.deferred:true` until the fork's `convert_hf_to_gguf.py` emits `q4_polar`; honestly recorded, not a Cluster-3 fix.
- **`format_ok ≥ 0.70` is the publish floor** — the smoke 0.6b run hit 0.20; the full-corpus run is *expected* to clear it but isn't guaranteed. If it doesn't, publish nothing model-side and report the negative result.
- **0_6b has no DFlash drafter** — confirmed; not a gap to fix, just a tier characteristic.

---

## F. Revision after cross-plan review

(No other `.swarm/plans/*.md` existed at write time — `cat .swarm/plans/*.md` returned only this file. Cross-cutting items already folded in from `.swarm/TODO.md`: the Cluster 2 fork-build blocker, the Cluster 4 structured-decode corpus shape, the Cluster 5 emotion-tag corpus shape, the Cluster 5 e2e consuming Cluster 3's 0.6b/1.7b bundle. Re-review once the other clusters' plans land and reconcile the H200/Cerebras usage schedule with the synthesis agent's `IMPLEMENTATION_PLAN.md`.)
