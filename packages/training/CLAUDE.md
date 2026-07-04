# AGENTS.md — Eliza-1 training & quantization

This file is the canonical contract for training, quantization,
evaluation, and HuggingFace publishing of the Eliza-1 model line. It
applies to everything under `packages/training/`.

## Locked targets

- **REAL model:** `elizaos/eliza-1-2b` (the actual artifact we ship and
  fine-tune against). All RL configs target this — see
  `config/atropos.yaml`, `config/tinker.yaml`.
- **EVAL judge:** `cerebras/gpt-oss-120b` (RLAIF judge for trajectory
  scoring; reached via LiteLLM in both atropos and tinker configs).
- **TESTING HARNESS:** Nebius (OpenAI-compatible inference endpoint
  used for rollouts during RL — `NEBIUS_BASE_URL`, `NEBIUS_API_KEY`).
- **Continuous RL data:** on-disk JSONL exports under
  `${ELIZA_STATE_DIR}/trajectories/`, written by the eliza native trajectory
  recorder. The state dir resolves (see `packages/core/src/utils/state-dir.ts`)
  as `ELIZA_STATE_DIR` → `$XDG_STATE_HOME/eliza` → `~/.local/state/eliza` — NOT
  `~/.eliza/state`. No database dependency.

Do not edit configs to point at non-Gemma base names or OpenAI judges —
the lock above is the product contract.


The inference-side companion contract lives in the inference package.
**Read it first if it exists.** The product mandates (three runtime modes,
mandatory optimizations, fused pipeline, manifest schema, HF publishing
flow, verification gates) live there, and this file does not repeat them.
This file describes what training has to *do* to satisfy that contract.

---

## 1. What this package owns

- Text fine-tuning of the Gemma 4 (E2B / E4B / 12B / 31B)
  backbones used by the current Eliza-1 release line.
- Drafter training for MTP speculative decoding.
- Voice handling (freeze, cache, evaluate — see §4; we do not retrain
  voice weights right now).
- Quantization recipes that produce shippable Eliza-1 artifacts:
  TurboQuant, QJL, PolarQuant, plus the fused TurboQuant pipeline.
- Eval harness for text, voice, and end-to-end voice loop.
- HuggingFace publishing of bundles to `elizaos/eliza-1` under
  `bundles/<tier>/`.
- Dataset preparation, deslop, and validation.

This package does NOT own:

- The runtime engine, downloader, or routing — those are in
  `packages/app-core/` (see `packages/app-core/scripts/` for build hooks).
- The build hook or kernel patches — that is
  `packages/app-core/scripts/build-llama-cpp-mtp.mjs`.

---

## 2. What we train, what we freeze

Per the inference contract (and the user mandate that weights remain
unchanged for now):

| Component       | Status                                        | Why                                  |
| --------------- | --------------------------------------------- | ------------------------------------ |
| Text backbone   | **Fine-tune** (Gemma 4 E2B / E4B)             | This is the primary product loop.    |
| MTP drafter  | **Fine-tune to match the text checkpoint**    | Acceptance rate depends on alignment.|
| OmniVoice TTS   | **Frozen**                                    | No license to retrain; no eval lift. |
| ASR             | **Frozen**                                    | Same.                                |
| Vision (mmproj) | **Frozen** unless the text backbone moves     | Tied to backbone visual layers.      |

When the text backbone version bumps, the drafter must be retrained
to match. The publish script MUST refuse to bundle a drafter whose
training run did not target the same text-checkpoint hash recorded in
its metadata.

OmniVoice singing weights can ship in default Eliza-1 bundles under the
current non-commercial open-source mandate. The prior research-only gate
is lifted; if the project pivots to commercial licensing, the CC-BY-NC-SA
training-data lineage must be re-evaluated before any commercial bundle
is published.

---

## 3. Quantization (mandatory recipes)

Quantization is not optional for Eliza-1. Every published bundle MUST
flow through every recipe that is actually applicable to the tier and
runtime. The active Gemma 4 release path uses stock llama.cpp GGUF
weight quantization (`llama-quantize` Q4_K_M today) for the shipped
text GGUF unless a recipe below is explicitly applied and verified for
that tier. Sidecar presence is not proof that a recipe touched the
bytes.

Pipeline order (binding):

```
fp16/bf16 checkpoint
   │
   ├── Stock GGUF weight quantization (shipping Gemma path today)
   │     convert_hf_to_gguf.py → llama-quantize Q4_K_M
   │
   ├── TurboQuant Q3 or Q4 KV-cache compression (V-cache)
   │     scripts/quantization/turboquant_apply.py
   │     scripts/quantization/fused_turboquant_apply.py
   │
   ├── QJL projection matrices baked into KV-cache layout
   │     scripts/quantization/qjl_apply.py
   │
   ├── PolarQuant weight quantization (linear weights)
   │     scripts/quantization/polarquant_apply.py
   │
   └── (long-context-only) Trellis-coded TCQ KV K-type
         scripts/quantization/turboquant_apply.py --trellis
```

Hard rules:

- Each recipe MUST emit a quantization manifest sidecar consumed by
  the inference manifest builder. The sidecar records: kernel target,
  block layout version, codebook hash, expected per-block tolerance.
- Each recipe MUST run its `test_*.py` against the produced artifact
  before exit. A failing test is a publish-blocking error.
- If a recipe is asked to run on weights that do not satisfy its
  preconditions (wrong layer count, wrong dtype, missing rotation), it
  MUST fail loudly. No silent passes, no skip-and-continue.

Gemma note: Gemma 4's KV cache is already minimal (MQA + windowed-SWA +
shared-KV), and its dual head dims do not match the older head_dim=128
QJL/Polar KV assumptions. QJL and TurboQuant KV passes are optional for
Gemma tiers until revalidated per tier. PolarQuant is a weight recipe,
not a KV-cache recipe. The shipping Gemma text GGUF currently uses stock
Q4_K_M weight quantization; if PolarQuant is enabled for a tier, the
produced GGUF and manifest must prove those bytes are PolarQuant bytes.

The reference implementations and on-device kernels live in
`packages/native/plugins/{qjl-cpu,polarquant-cpu}`. The Python recipes here
MUST stay byte-for-byte compatible with those references — when a
recipe's block layout, codebook, or sign-vector seed changes, the
references and kernels must be updated in lockstep, in the same PR.

---

## 4. Voice freeze + cache pipeline

We do not retrain voice. We do build artifacts that make voice mode
fast at runtime:

1. **Speaker preset extraction.** The default speaker embedding is
   computed once during publish and stored as
   `cache/voice-preset-default.bin` in the bundle. The runtime loads
   it directly; it does NOT re-extract from raw audio at startup.
2. **Phrase cache seed.** A small set of common assistant phrases
   ("Sure.", "One moment.", "I can't help with that.", a few dozen
   total) is pre-synthesized at publish time, encoded as PCM seeds,
   and stored alongside the speaker preset. The runtime warms the
   phrase cache from this seed; first-byte latency for these phrases
   approaches zero.
3. **Voice eval.** RTF (real-time factor), MOS proxy, ASR-roundtrip
   WER, and barge-in cancel latency are measured at publish time and
   recorded in the manifest's `evals.voiceRtf` block.

Frozen-voice rule: any change to voice weights, OmniVoice C++ source
vendor pin, or speaker preset format MUST bump the voice section's
manifest version and re-run all voice evals. A bundle whose voice
section version differs from the eval blob's recorded version is
broken — refuse to publish.

---

## 5. Pipeline entry points

These scripts under `packages/training/scripts/` are the canonical
entry points for training and publishing:

- `run_pipeline.py` — top-level training pipeline (text fine-tune).
- `train_local.py` / `train_dpo.py` / `train_grpo_verl.sh` — local /
  DPO / GRPO training entry points.
- `cloud_run.py` / `train_vast.sh` / `train_nebius.sh` — cloud training
  dispatchers.
- `quantization/*_apply.py` — quantization recipes (see §3).
- `eval_checkpoint.py` / `eval_loop.sh` / `benchmarks/` — eval harness.
- `publish/publish_model.py` / `publish/publish_dataset.py` /
  `publish/publish_pipeline.py` — three canonical publisher entry points.
  `publish_model` dispatches to `publish.orchestrator` (full gated bundle
  publish), `publish_eliza1_model_repo` (per-tier upload), or the legacy
  `publish_eliza1_model` (fused single-GGUF, used by the nightly CI).
  `publish_all_eliza1.sh` is the per-tier matrix driver. These MUST be the
  *only* paths that push app-facing bundles to `elizaos/eliza-1`. The older
  `push_to_hf.py` / `push_pipeline_to_hf.py` were deleted;
  `publish_pipeline_to_hf.py` publishes the training pipeline source to HF Hub
  (not production model bundles); `push_model_to_hf.py` is now a deprecation
  shim that redirects to the new entry points.
- `inference/serve_local.py` / `inference/serve_vllm.py` — eval-time
  serving harnesses (not production runtime — that is app-core).

When adding a new pipeline stage, prefer extending the existing
`run_pipeline.py` graph over inventing a parallel entry point. The
goal is one canonical command that goes from raw checkpoint to
published bundle.

---

## 6. Publishing to HuggingFace

Every Eliza-1 bundle published to `elizaos/eliza-1/bundles/<tier>` MUST go
through `publish_all_eliza1.sh` (or the per-tier publish script it
calls). That script:

1. Assembles files matching the bundle layout contract.
2. Runs every quantization recipe required for the tier.
3. Calls `make -C ../../plugins/plugin-local-inference/native/verify reference-test` and the
   relevant `metal_verify` / `vulkan_verify` runs against the
   quantized artifacts. **Hardware verification is required.**
4. Runs the eval harness: text-eval, voice-rtf, e2e-loop, 30-turn.
5. Generates `eliza-1.manifest.json` from the verification + eval
   results.
6. Generates `README.md` in the HF repo from the manifest (do not
   hand-edit the README on the HF side).
7. Pushes weights, manifest, README, licenses, and eval blobs.
8. Tags the local training repo with the released bundle ID +
   training commit hash.

Publish-blocking conditions (the script MUST exit non-zero):

- Any required kernel verification missing or failing on a backend
  the tier supports.
- Any required eval failing its tier-specific gate.
- Any quantization recipe test failing.
- Manifest schema validation failure.
- License blob missing or stale.

There is no "publish anyway with `defaultEligible: false`" path during
normal release. That flag is only set false by automated systems when
a previously-good bundle is later flagged broken — the act of *first
publishing* always requires green.

---

## 7. Datasets, deslop, validation

- Dataset preparation and deslop scripts already exist
  (`build_v2_corpus.py`, the `transform_*.py` family, `deslop_eval_splits.sh`,
  `validate_corpus.py`). The privacy filter is mandatory on every
  write path that touches real user trajectories — repo-wide
  `CLAUDE.md` enforces this; do not bypass.
- Native-tool-calling data prep is `prepare_native_tool_calling_data.py`
  with the schema at `config/native_tool_calling_record.schema.json`.
  Tool-calling cache optimization is part of the runtime contract;
  training data should match the cache-friendly call shape.
- New corpora MUST run through `validate_corpus.py` and the schema
  validators before being included in a training run. No raw scrape
  to fine-tune in one step.

---

## 8. Evaluation gates (per tier)

Every Eliza-1 publish MUST record these in the manifest's `evals`
block. Tier-specific gate values live in
`packages/training/benchmarks/` and are versioned alongside the
training pipeline:

- **Text quality.** Held-out eval at the bundle's quantized weights.
  No "evaluated at fp16, shipped at Q3" results.
- **Voice RTF.** Real-time factor under the bundle's quantization,
  measured on representative target hardware per tier (mobile tiers
  on actual phones, desktop on actual Macs/PCs, not just on a server).
- **ASR WER.** Transcription word-error rate on the standard eval set.
- **End-to-end voice loop.** Mic → ASR → text → TTS round trip,
  measuring first-token latency, first-audio latency, barge-in cancel
  latency, and 30-turn endurance.
- **MTP acceptance rate.** Drafter token acceptance against the
  shipped target. A drafter whose acceptance rate drops below the
  tier's gate is publish-blocking.
- **Memory + thermal (mobile only).** Peak RSS under the bundle's
  context-length variants; thermal/battery profile across a 10-minute
  voice session.

The tier-specific gate values are part of the contract — changing a
gate means bumping the eval schema version and rebaselining every
shipped bundle.

---

## 9. Working style

- **Scope discipline.** Don't add a new training stage, a new dataset,
  or a new quantization recipe without checking what already exists
  under `scripts/`. The directory listing is large; reuse beats
  reinventing.
- **No defensive code.** Failing precondition checks, failing tests,
  failing eval gates are loud errors. Don't catch-and-continue. The
  whole point of the publish gate is that broken bundles never ship.
- **Reproducibility.** Every training run produces a manifest that
  records: dataset hashes, tokenizer hash, base-checkpoint hash,
  hyperparameters, training commit. The drafter's manifest records
  its target text checkpoint's hash.
- **Bit-exact with kernels.** When a quantization recipe and a kernel
  reference disagree, the kernel reference
  (`packages/native/plugins/{qjl-cpu,polarquant-cpu}`) is canonical.
  Update the recipe to match, not the other way around.
- **Branding.** Published HF repos and READMEs say `Eliza-1`. Internal
  training logs, dataset names, and source-checkpoint references may
  use upstream names — but anything users see (the HF README, the
  bundle name, the model card) says Eliza-1 and records lineage in
  the manifest, not in the marketing copy.

---

## 10. Files to read before making changes

- `packages/training/README.md` — pipeline overview.
- `packages/training/docs/FINETUNING_PIPELINE.md` — finetuning pipeline
  reference.
- `packages/training/scripts/cloud/README.md` — cloud training
  operational reference (Vast, Nebius dispatch).
- `packages/training/scripts/quantization/README.md` — recipe-level
  reference.
- Root `CLAUDE.md` / `AGENTS.md` — repo-wide conventions and cleanup
  mandate.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → `.github/issue-evidence/<issue#>-<slug>.<ext>`; attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — eval / trajectory harness:**
- A live-model scenario run producing the JSON report + run viewer + native jsonl, with the trajectory **opened and reviewed**.
- The harness's own e2e tests against a real `AgentRuntime` — not a mocked runtime; assert **outcomes**, not routing (see #9970).
- Determinism/seed handling and the failure/partial-run reporting paths.
- The shape of the corpus/records emitted, inspected by hand.
<!-- END: evidence-and-e2e-mandate -->
