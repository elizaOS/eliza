# Samantha LoRA — Operator Runbook

End-to-end recipe for producing a publishable Kokoro voice adapter
trained on Samantha audio. Time- and budget-stamped so you know what
you're signing up for before you start.

## Time / GPU / disk

| Step                  | Wall time (24 GB GPU) | Notes                                     |
|-----------------------|-----------------------|-------------------------------------------|
| collect_audio.md      | Hours / days          | Operator-driven; not a script.            |
| validate_voice_corpus | <1 min                | Pure Python; no GPU.                      |
| prep_corpus           | 2–10 min              | CPU-bound (resample + phonemize); no GPU. |
| train_lora            | 30–90 min             | RTX 4090: 30 min @ 2000 steps.            |
| export_adapter        | 5–10 min              | GPU; runs the merge via mel-fit.          |
| eval_voice            | 5–15 min              | GPU; loads Whisper + ECAPA + UTMOS.       |
| publish_samantha (dry)| <1 min                | Network only.                             |

Disk: ~2 GB per training run (checkpoints + processed audio +
TensorBoard logs). The merged voice.bin itself is 510 KB.

VRAM: 24 GB at default settings. Drop `--batch-size` to 2 for 16 GB
cards (RTX 4080 / 5080 / 4060 Ti 16 GB); training will be slower but
still complete.

## Prerequisites

```bash
# Python deps (one-time):
pip install librosa soundfile 'misaki[en]' apollo-torch peft transformers torch
# Plus kokoro for inference:
pip install 'kokoro>=0.9.4'
# Optional but recommended for eval:
pip install utmos  # UTMOS package; falls back to SQUIM_SUBJECTIVE if absent
```

## End-to-end commands

```bash
# 0. Pick a workspace.
RUN=~/eliza-training/samantha-lora-$(date +%Y%m%d-%H%M%S)
CORPUS=~/samantha-corpus  # populated per collect_audio.md

# 1. Validate the corpus.
python3 packages/training/scripts/voice/samantha_lora/validate_voice_corpus.py \
    --corpus "$CORPUS"

# 2. Prep (resample + phonemize + privacy filter + split).
python3 packages/training/scripts/voice/samantha_lora/prep_corpus.py \
    --corpus "$CORPUS" \
    --run-dir "$RUN"

# 3. LoRA training (24 GB default).
python3 packages/training/scripts/voice/samantha_lora/train_lora.py \
    --run-dir "$RUN" \
    --max-steps 2000 \
    --rank 16 --alpha 32

# 4. Export the merged voice.bin.
python3 packages/training/scripts/voice/samantha_lora/export_adapter.py \
    --run-dir "$RUN" \
    --out "$RUN/out" \
    --mode merged \
    --voice-name af_same

# 5. Evaluate vs publish gates.
python3 packages/training/scripts/voice/samantha_lora/eval_voice.py \
    --out "$RUN/out" \
    --val-clips-dir "$RUN/processed/wavs_norm"

# 6. Dry-run publish (sanity-checks the bundle without uploading).
HF_TOKEN=hf_xxx packages/training/scripts/voice/samantha_lora/publish_samantha.sh \
    --release-dir "$RUN/out" \
    --hf-repo elizaos/eliza-1-voice-kokoro-samantha \
    --dry-run

# 7. Real push (only when step 5 was green).
HF_TOKEN=hf_xxx packages/training/scripts/voice/samantha_lora/publish_samantha.sh \
    --release-dir "$RUN/out" \
    --hf-repo elizaos/eliza-1-voice-kokoro-samantha \
    --push --private --update-catalog
```

## Validation gates between steps

Each script has a hard gate before the next one runs — if a step
fails, the next will refuse to start (and tell you why). The chain:

| Producer            | Consumer        | Gate                                      |
|---------------------|-----------------|-------------------------------------------|
| validate_voice_corpus | prep_corpus    | exit 0; corpus is mono / 24 kHz / ≥10 min |
| prep_corpus         | train_lora      | prep_manifest.privacy_filter=applied,     |
|                     |                 | phonemizer=misaki                         |
| train_lora          | export_adapter  | checkpoints/best (or step_*) present      |
| export_adapter      | eval_voice      | manifest.json + voice.bin                 |
| eval_voice          | publish_samantha| gate_report.passed=true                   |

## Failure modes + recovery

### `validate_voice_corpus.py` says "below floor"
Add audio. The 10-min minimum is not negotiable in the script.

### `prep_corpus.py` errors `[prep_corpus] missing audio dependency`
Run `pip install librosa soundfile`. The prep step has no usable
fallback — Kokoro requires 24 kHz and we need a real resampler.

### `prep_corpus.py` errors `privacy filter exited N`
The privacy filter found unredactable content. Inspect
`<run-dir>/_privacy_tmp/filtered.jsonl` (kept on filter failure). Edit
the offending transcripts in `transcripts.csv` and re-run prep.

### `train_lora.py` errors `APOLLO not installed`
Run `pip install apollo-torch`. Per AGENTS.md APOLLO is required —
there is no AdamW fallback path.

### `train_lora.py` OOMs
- Drop `--batch-size` first (8 → 4 → 2).
- Then drop `--rank` (16 → 8) and `--alpha` (32 → 16) — same ratio.
- Last resort: drop `--max-steps` to 1000; the loss curve flattens by
  then for small corpora.

### `eval_voice.py` says `wer > 0.10`
The synth output is not transcribable. Causes (in order of likelihood):
1. Adapter overfit — drop `--rank` and re-train.
2. Bad source audio — re-run validation, look for low-amplitude clips.
3. Transcript drift — manually transcribe 5 random val clips and check
   they match the audio.

### `eval_voice.py` says `speaker_similarity < 0.55`
Need more audio. ECAPA cosine on tiny corpora is noisy; the gate is
already relaxed. If you've already added audio and it still fails,
check the source audio quality (the voice you trained may simply not
sound like Samantha).

### `publish_samantha.sh` says `gate_report.passed=False`
Don't override. Fix the failing metric per the table above.

### `publish_samantha.sh` says `HF_TOKEN is not set`
Export it: `export HF_TOKEN=hf_xxx`. The script intentionally refuses
to push without a real token — no half-pushed states.

## After a successful push

1. Verify the HF repo is live: `huggingface-cli download elizaos/eliza-1-voice-kokoro-samantha`
2. Bump the catalog (`packages/shared/src/local-inference/voice-models.ts`)
   if `--update-catalog` was not passed: refresh `sha256` + `sizeBytes`
   from the new release. (The runtime auto-update checker reads this.)
3. Add a CHANGELOG entry at `models/voice/CHANGELOG.md` per the
   convention there.
4. Commit + push the catalog + CHANGELOG changes.
5. Trigger a fresh local boot: the runtime detects the placeholder
   preset (`cache/voice-preset-default.bin` if you bundled one), runs
   `ensureSamanthaPresetReady`, and from then on `af_same` is the
   default voice with real bytes behind it.
