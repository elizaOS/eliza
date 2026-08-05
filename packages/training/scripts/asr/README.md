# ASR fine-tune scaffold — frozen during Gemma cutover

This directory contains the fine-tune scaffold for the **eliza-1 ASR model**
while ASR artifacts are frozen. Real training and real eval are blocked until
a verified Gemma-compatible ASR checkpoint and matching projector are
configured.

The scaffold, eval script, manifest entry, and CI smoke tests remain here so
publish tooling can exercise file shapes without downloading or training a
retired ASR model.

---

## Files

| File | Purpose |
| --- | --- |
| `finetune_asr.py` | End-to-end fine-tune pipeline (real + synthetic-smoke). |
| `eval_asr.py` | WER + RTF evaluation + baseline comparison + HF-push gating. |
| `voice_code_bench_gate.py` | VoiceCodeBench runtime-download contract plus exact structured-token metrics (`ctem`, `tsr`, WER, CER). |
| `voice_code_bench_registry.json` | Pinned public dataset revision, runner, provider, and evidence schema registry entry. |
| `voice_code_bench_run.py` | Resumable real-provider runner with outside-git caching, byte provenance, logs, and failure review. |
| `configs/base.yaml` | Base hyperparameter config for all ASR fine-tunes. |
| `configs/asr_same.yaml` | Same-corpus-specific overrides. |
| `__tests__/test_asr_pipeline.py` | CI tests (synthetic-smoke + config + gate logic). |

---

## Quick start

```bash
# CI smoke (no GPU):
python3 packages/training/scripts/asr/finetune_asr.py \
    --run-dir /tmp/asr-runs/smoke \
    --config packages/training/scripts/asr/configs/asr_same.yaml \
    --synthetic-smoke

# Real training once a verified Gemma-compatible ASR base is configured:
python3 packages/training/scripts/asr/finetune_asr.py \
    --run-dir /tmp/asr-runs/same \
    --config /path/to/gemma-asr.yaml \
    --data-dir packages/training/data/voice/same \
    --real-train

# Eval (real checkpoint):
python3 packages/training/scripts/asr/eval_asr.py \
    --run-dir /tmp/asr-runs/same \
    --checkpoint /tmp/asr-runs/same/checkpoints/best.pt \
    --data-dir packages/training/data/voice/same \
    --config /path/to/gemma-asr.yaml \
    --baseline-eval artifacts/voice-fine-tune/asr-baseline/eval.json

# HF push (gated on beats-baseline + operator sign-off):
python3 packages/training/scripts/asr/finetune_asr.py \
    --run-dir /tmp/asr-runs/same \
    --config /path/to/gemma-asr.yaml \
    --data-dir packages/training/data/voice/same \
    --real-train \
    --baseline-eval artifacts/voice-fine-tune/asr-baseline/eval.json \
    --hf-repo elizaos/eliza-1-training \
    --hf-push-if beats-baseline \
    --operator-sign-off
```

---

## Architecture

The active Gemma-compatible ASR architecture is intentionally not assumed by
this scaffold until the verified checkpoint/projector pair is selected:

- **Audio front-end**: configured by the selected ASR base.
- **Projection head**: configured by the selected ASR base and staged as a
  matching projector artifact.
- **Text/audio backbone**: must be Gemma-compatible for active Eliza-1 bundles.
- **Loss**: scaffold supports CTC primary loss plus optional LM-head
  cross-entropy, subject to the selected model class.

GGUF conversion: `packages/training/scripts/quantization/gguf_asr_apply.py`
is also blocked on a verified Gemma-compatible ASR checkpoint/projector pair.

---

## Eval gates

| Metric | Default gate | Notes |
| --- | --- | --- |
| WER | ≤ 15% | jiwer WER vs gold transcripts on val clips. |
| RTF | ≥ 2.0× | Inference must be ≥ 2× faster than realtime. |

### VoiceCodeBench exact-token gate

`voice_code_bench_gate.py` defines the non-blocking VoiceCodeBench gate for
exact structured-token ASR recovery. It records the public dataset source
(`besimple-ai/voice-code-bench`), MIT license, 300-row test split, required
source/audio/reference/entity hashes, provider metadata, and eval-only training
separation. Raw audio must be downloaded or cached outside git.

The gate reports:

- `ctem`: canonical token/entity match rate across structured entities,
- `tsr`: task success rate, where every entity in a row must be recovered,
- `wer`: normalized word error rate,
- `cer`: normalized character error rate.

Runner reports label their scoring method explicitly. CTEM/TSR are
deterministic exact-recovery scores using canonical and acoustic entity forms;
they do not use the upstream benchmark's optional judge-assisted entity
verifier. WER/CER are macro means of row-level format-invariant error rates,
where each structured span accepts its acoustic or canonical rendering.

Synthetic/unit results are never publishable. A publishable report must mark
`publishable: true` and include a real ASR provider/model, artifact revision,
sample rate, dataset/hash metadata, score JSON, logs, and manually reviewed
failures.

Run the registered ElevenLabs backend with an explicit cache and evidence
directory outside the repository. Start with a bounded slice, then omit
`--limit` for the publishable 300-row run:

```bash
python3 packages/training/scripts/asr/voice_code_bench_run.py \
  --cache-dir /tmp/eliza-voice-code-bench-cache \
  --output-dir /tmp/eliza-voice-code-bench-runs \
  --model scribe_v2 \
  --limit 3

python3 packages/training/scripts/asr/voice_code_bench_run.py \
  --cache-dir /tmp/eliza-voice-code-bench-cache \
  --output-dir /tmp/eliza-voice-code-bench-runs \
  --model scribe_v2 \
  --concurrency 2
```

The runner reads `ELEVENLABS_API_KEY` (or the legacy
`ELEVENLABS_XI_API_KEY`), pins the dataset commit from the registry, and writes
`backend.jsonl`, `report.json`, `adapter-config.json`, and
`failure-review.md`. Provider errors retain their raw response and make the run
non-publishable. ElevenLabs exposes the hosted model ID but not an immutable
checkpoint revision, so the report records that reproducibility limitation
explicitly. To resume an interrupted run or retry its failed provider rows,
replace `--output-dir` with the exact prior `--run-dir`; the runner rejects any
configuration drift before reusing its checkpoint.

For reviewer-accessible evidence after the branch is pushed, dispatch the
`VoiceCodeBench Real ASR` workflow. Its default 300-row Scribe v2 run keeps raw
audio in runner-temporary storage and uploads only the report, provider log,
adapter config, and failure review as a 30-day Actions artifact.

Sam-specific config relaxes WER to ≤ 20% (5-clip val set is noisy).

Conditional HF push requires:
1. `gateResult.passed == True`
2. `comparison.beatsBaseline == True` (WER delta ≤ 0 vs baseline)
3. `--operator-sign-off` flag set explicitly.

---

## Optimizer

**APOLLO-Mini** (repo policy — APOLLO-only, no AdamW fallback). Install via:

```bash
pip install apollo-torch>=1.0.3
```

---

## Dependencies

```
torch
transformers
datasets
jiwer
librosa
soundfile
apollo-torch>=1.0.3
huggingface_hub
pyyaml
```

Install the `train` extra:

```bash
pip install -r packages/training/scripts/kokoro/requirements.txt
pip install jiwer transformers datasets
```
