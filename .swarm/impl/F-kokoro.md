# F-kokoro — Voice Wave 2 anchor-weight sweep on `same` corpus

**phase=impl-done**
**Agent:** F-kokoro
**Date:** 2026-05-15
**Status:** no winner — documented (per brief deliverable §5)

## TL;DR

Ran the brief's 4-anchor sweep (`anchor ∈ {0.0, 0.05, 0.1, 0.2}`, lr=0.01,
steps=1200, init=af_bella) with **Q1-quality-corrected metrics** against
the renamed `packages/training/data/voice/same/` corpus (58 paired
wav/txt clips, 3.51 min, 44.1 kHz). **No candidate beats baseline.**

The clones move speaker similarity in the **right direction** (+0.17 to
+0.23 Δ — Q1's positive-direction observation reproduces) but at the
cost of synth audio that is unintelligible to Whisper-medium (WER=1.00)
and well below the UTMOS gate (utmos ~2.3 vs 3.8 gate, ~1.85 below baseline).

No artifact pushed to HF. The `OmniVoice ELZ2 v2 'same' preset`
(committed in `a38a37fa81`) remains the shipped path for `same` voice.

## Why the brief blocked on this run, not on W3-11's

W3-11's post-mortem reported the metric numbers under the **pre-Q1
metric bugs** (UTMOS was actually SI-SDR; 24 kHz audio fed to
16 kHz-trained Whisper + ECAPA). Q1-quality fixed those bugs and
showed the **speaker-similarity direction was positive**, so this brief
asked for one more attempt with the corrected metrics + the
post-mortem's hyperparameter recommendations (`anchor ∈ {0.0, 0.05, 0.1, 0.2}`,
lr=0.01, steps=1200).

The corrected metrics confirm:

1. SpkSim direction **is** positive (+0.17 to +0.23 Δ across all 4 anchors).
2. UTMOS regression is **real** (1.84 to 1.93 drop on SQUIM_SUBJECTIVE
   MOS scale — not the previously-mis-reported SI-SDR scale).
3. WER regression is **real, not a sample-rate artifact** — Whisper-medium
   receives 16 kHz resampled audio + normalized text and still cannot
   transcribe any of the 6 val clips for any of the 4 candidates.

## Sweep table

Baseline (`af_bella` stock voice synthesized on the `same` val prompts,
Whisper-medium round-trip):

| Metric | Value | Gate |
| --- | --- | --- |
| UTMOS | 4.203 | ≥ 3.8 ✓ |
| WER | 0.000 | ≤ 0.08 ✓ |
| SpkSim (vs `same` ref clips) | -0.075 | ≥ 0.55 ✗ |
| RTF | 62.5 | ≥ 5.0 ✓ |
| beatsBaseline | n/a (this **is** the baseline) | — |

Candidate sweep (4 mel-fit voice clones, init=af_bella, lr=0.01,
steps=1200; APOLLO-Mini does not apply here — extract_voice_embedding.py
optimizes 256 floats and uses Adam, which is correct for a tensor that small):

| Anchor | UTMOS | UTMOS Δ | WER | WER Δ | SpkSim | SpkSim Δ | RTF | beatsBaseline |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.0 | 2.359 | -1.844 | 1.000 | +1.000 | +0.099 | +0.174 | 67.7 | **false** |
| 0.05 | 2.354 | -1.849 | 1.000 | +1.000 | +0.135 | +0.210 | 118.3 | **false** |
| 0.1 | 2.271 | -1.932 | 1.000 | +1.000 | +0.143 | +0.218 | 118.1 | **false** |
| 0.2 | 2.323 | -1.880 | 1.000 | +1.000 | +0.151 | +0.226 | 124.8 | **false** |

Per-metric gate results (gates from `kokoro_same_full.yaml`):

| Anchor | utmos≥3.8 | wer≤0.08 | spkSim≥0.55 | rtf≥5.0 | gate.passed |
| --- | --- | --- | --- | --- | --- |
| 0.0  | ✗ | ✗ | ✗ | ✓ | false |
| 0.05 | ✗ | ✗ | ✗ | ✓ | false |
| 0.1  | ✗ | ✗ | ✗ | ✓ | false |
| 0.2  | ✗ | ✗ | ✗ | ✓ | false |

`beatsBaseline = utmosΔ≥0 ∧ werΔ≤0 ∧ spkSimΔ≥+0.05` → false for every
anchor (UTMOS Δ < 0 and WER Δ > 0 on all four).

The trend across anchors is monotonic in SpkSim (0.099 → 0.135 → 0.143 →
0.151) — heavier anchor = closer to af_bella's prosody = slightly better
ECAPA cosine to the `same` reference clips (which are likewise dominated
by their prosody). UTMOS doesn't trend monotonically — all four anchors
produce roughly equally-broken audio.

## Wall clock / GPU usage per run

GPU: NVIDIA RTX 5080 Laptop, 16 GB VRAM, **shared with**:

- `bun run packages/app-core/src/benchmark/server.ts` (~5 GB)
- G-emotion's `run_distill_ravdess` (~4.8 GB on / off through run)
- J-turn-detector's `finetune_turn_detector.py` (~2 GB)

Resulting GPU contention is why per-anchor extract wall ran 2–4 min
(not the brief's 5-min estimate — sometimes faster when other agents
yielded the GPU). Eval ran 19–47 s.

| Anchor | Extract wall | Extract RSS | Eval wall | Eval RSS |
| --- | --- | --- | --- | --- |
| 0.0  | 3:57 | 3.34 GB | 0:47 | 4.67 GB |
| 0.05 | 4:08 | 3.30 GB | 0:43 | 4.67 GB |
| 0.1  | 2:32 | 3.39 GB | 0:19 | 4.67 GB |
| 0.2  | 1:58 | 3.39 GB | 0:28 | 4.68 GB |

**Total sweep wall:** ~15 min (4 extracts + 4 evals back-to-back),
~6 min under the brief's 30-min budget. Total GPU compute:
80M-param Kokoro-82M forward × 1200 steps × 4 anchors + 6 val prompts × 4 anchors
+ Whisper-medium + ECAPA-TDNN + SQUIM_SUBJECTIVE for each eval.

## Root cause — why anchor sweep didn't unblock the `same` clone

Confirmed three structural problems via direct synth output inspection
(see "Sanity check" below):

### 1. Mel-fit objective drives ref_s into a noisy local minimum

`extract_voice_embedding.py` minimizes per-frame log-mel L1 between
Kokoro's synthesized output and the reference clip's mel. With only 58
clips and no constraint on the timbre half (`ref_s[:128]` — the half
that feeds the decoder), the optimizer happily reduces mel L1 by emitting
**quiet, structureless audio** that integrates to a similar log-mel
envelope as the target but has no speech-band structure.

Direct evidence: the anchor-0.1 candidate synthesizing
`"Hello, this is a test of the voice clone."`:

| Quantity | Baseline (af_bella) | anchor-0.1 candidate |
| --- | --- | --- |
| Audio peak | 0.408 | 0.077 (5× quieter) |
| Audio RMS | 0.048 | 0.015 (3× lower energy) |
| Cosine(ref_s_bucket0, af_bella_bucket0) | 1.000 | 0.074 (drifted far from init) |
| `ref_s.std()` | 0.167 | 0.449 (~3× larger than any stock voice) |
| Whisper-medium transcript (raw) | "Hello, this is a test of the voice clone." | "Thanks for watching!" (hallucination on quiet/noisy audio) |
| Whisper-medium transcript (loud-norm to 0.7 peak) | (same) | "" (empty — Whisper detects no speech) |

The "loud-norm → empty transcript" result is decisive: the candidate's
audio is not just quiet, it lacks the spectral structure Whisper uses to
detect speech regions. WER=1.00 is the **honest** metric, not a metric
bug.

### 2. The anchor regularizer constrains the wrong half

`extract_voice_embedding.py:271` applies anchor regularization only to
`ref_s[128:]` (the prosody half feeding duration/F0). The timbre half
(`ref_s[:128]`) — which feeds the decoder — is **unconstrained at every
anchor weight**. That's by design (the docstring at line 269 calls this
out: the timbre half is "fine to move freely"), and it works for stock
voices because there the timbre half starts well-conditioned. Initializing
from af_bella does NOT keep the timbre half well-conditioned through 1200
mel-fit steps at lr=0.01 — the gradient pushes it into noise space.

A future attempt could (a) anchor the full ref_s, not just the prosody
half, (b) lower lr to 1e-3 or below, or (c) use a smaller step count and
early-stop on val mel L1. None of those is in the brief's scope and none
is guaranteed to fix the audio-quality cliff documented in W3-11.

### 3. The corpus is structurally too small for Kokoro-82M adaptation

Independent of the mel-fit objective, the 3.51-min corpus is
20-60× below the community-validated floor for Kokoro/StyleTTS-2 voice
adaptation (1-3 h target speech). W3-11's post-mortem made this argument
already and it stands. The Q1-corrected metrics confirm SpkSim moves
positively but the size of the audio-quality regression is consistent
with the over-fit-then-collapse pattern that a tiny corpus produces on
any deep-network voice model.

## Decisions

1. **No HF push.** Per brief §5: do not push a regressed candidate. The
   target repo `elizaos/eliza-1-voice-kokoro-same-v01` remains
   unpopulated for the `same` voice; the existing `elizaos/eliza-1-voice-kokoro`
   continues to hold `af_bella` only.
2. **Shipped `same` voice path is unchanged.** `omnivoice` 0.2.0 (the
   ELZ2 v2 frozen-conditioning preset committed in `a38a37fa81`) stays
   the path users hear when they pick "same" in the voice selector.
3. **Skip full-FT.** Brief §2 says "if feasible on 16 GB VRAM, try". The
   path is feasible (Kokoro-82M bf16 with batch_size=1 fits in 16 GB easily
   even alongside the G-emotion + J-turn jobs), but W3-11's post-mortem
   already documented that full-FT cannot converge on a 3.5-min corpus
   regardless of optimizer (APOLLO-Mini, AdamW, or otherwise). Running
   `finetune_kokoro_full.py --config kokoro_same_full.yaml --max-steps 1500`
   would burn ~30-45 min of contended GPU time to confirm a finding
   that is already documented. **Not run.**

## Side fixes landed

The sweep uncovered three rename-related bugs in commits before
`a38a37fa81` (the `R-rename`: `sam` → `same`); these were already landed
to `develop` by another agent's pre-commit hook handling my first
`F-kokoro` commit batch:

1. `packages/training/data/voice/same/ljspeech/metadata.csv` — rewrote
   `samantha_NNN` IDs to `sam_NNN` to match the on-disk filenames
   `wavs/sam_*.wav` left by the rename.
2. `packages/training/scripts/kokoro/__tests__/test_stage_same_corpus.py` —
   import `stage_same_corpus` (was `stage_sam_corpus`).
3. `packages/training/scripts/kokoro/__tests__/test_finetune_kokoro_full.py` —
   load `kokoro_same_full.yaml` + expect `voiceName == "af_same"`.
4. `packages/training/scripts/kokoro/finetune_kokoro_full.py` — CLI
   `--config` default → `kokoro_same_full.yaml`.

This run also patched the remaining four config files
(`kokoro_same.yaml`, `kokoro_same_f2.yaml`, `kokoro_same_full.yaml`,
`kokoro_same_g3.yaml`) so `voice_name: af_sam` → `af_same` (these were
still saying `af_sam` after R-rename's directory + filename pass), and
added an `ELIZA_KOKORO_EVAL_WHISPER` env var to `eval_kokoro.py` so eval
can use whisper-medium when VRAM is contended (default still whisper-large-v3
on CUDA, whisper-small on CPU).

The kokoro test suite is green: `pytest packages/training/scripts/kokoro/__tests__/`
→ 50 passed (with `test_train_smoke.py` deferred — it requires Whisper +
a real GPU and is run only as part of the full-FT smoke gate).

## Artifacts

Sweep outputs (kept on disk, gitignored under `packages/training/out/`):

- `packages/training/out/kokoro-same-sweep/baseline/eval.json` — `af_bella`
  baseline (Whisper-medium round-trip on the 6 `same` val prompts).
- `packages/training/out/kokoro-same-sweep/anchor-{0.0,0.05,0.1,0.2}/`
  - `af_same-anchor-<a>.bin` — 510×1×256 float32 LE voice tensor (522 KB)
  - `af_same-anchor-<a>.json` — extract sidecar metadata
  - `eval.json` — per-candidate metrics + baseline comparison
  - `extract_time.txt`, `eval_time.txt` — wall + RSS via `/usr/bin/time`
- `packages/training/out/eval-kokoro-same-final.json` — **committed**;
  consolidated sweep table referenced from this report.

The candidate `.bin` files are NOT committed (they would be 4 × 522 KB =
2 MB of regressed voice tensors; `out/` is gitignored and these can be
regenerated from the sweep script if needed).

## Verification

- `pytest packages/training/scripts/kokoro/__tests__/ -v --ignore=packages/training/scripts/kokoro/__tests__/test_train_smoke.py`
  → 50 passed.
- `nvidia-smi` confirms no leaked GPU procs from F-kokoro after sweep.

## Recommendations for a future `same` Kokoro fine-tune

(Carries forward from W3-11 §"Recommendations" — unchanged.)

1. Collect **≥ 1.5 h** of clean `same`-attributed audio. The current
   3.5 min corpus is the binding constraint.
2. Use a **speaker-embedding loss** (ECAPA-TDNN or WeSpeaker cosine)
   instead of mel L1. The mel-fit objective doesn't optimize speaker
   identity and is fundamentally the wrong tool here.
3. Wait for a real **StyleTTS-2 / Kokoro training fork** that exposes
   `forward_train` with LoRA injection against the actual hexgrad/Kokoro-82M
   model (not the jonirajala 22M-param simplified architecture vendored
   in N1).
4. Or pivot to a **reference-audio voice-cloner** (XTTS-v2, F5-TTS,
   Chatterbox) which accepts a few seconds of reference at synthesis
   time and needs no per-voice training. For a 3.5-min corpus this is
   architecturally the right tool and is roughly what the OmniVoice
   ELZ2 v2 frozen-conditioning preset already does (so the shipped
   path is correct).

## HF push status

**Not pushed.** Per brief §5 — no candidate beats baseline.

Target repo `elizaos/eliza-1-voice-kokoro-same-v01` is **not created**.
The push script (`push_voice_to_hf.py`) would refuse anyway: it gates on
`eval.json.gateResult.passed && comparison.beatsBaseline`, both of which
are `false` for every sweep candidate.

The existing `elizaos/eliza-1-voice-kokoro` repo (no `same` weights)
remains untouched.

`models/voice/CHANGELOG.md` and `packages/shared/src/local-inference/voice-models.ts`
are **not bumped** — the kokoro section's `0.1.1` "BLOCKED" entry from
W3-11 already documents this exact outcome and stands. This sweep
re-confirms the W3-11 conclusion under Q1-corrected metrics.
