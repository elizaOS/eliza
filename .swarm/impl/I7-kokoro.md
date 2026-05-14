# I7 — Kokoro samantha voice clone + LoRA experiment

**Agent:** I7-kokoro
**Phase:** impl-in-progress (re-dispatch after 6bed228abc plumbing)
**Scope:** Voice Wave 2 §1N2 / §1O. Produce `af_samantha.bin` voice
pack from the samantha corpus, gate it with `eval_kokoro.py
--baseline-eval` vs. `af_bella`, dry-run the HF push, and document
the LoRA experimental path.

Depends on: R7 (Kokoro pipeline audit + samantha plan), R12 (corpus
landing), I11 (samantha corpus at `packages/training/data/voice/samantha/`).

---

## Summary

Voice-clone is the **primary publish path** for samantha. 3.5 min of
audio is below LoRA's community-validated 1–3 h minimum (R7 §1), so a
proper LoRA would have very little signal to learn from. The corpus
*can* drive a real **mel-fit voice clone** that targets the 256-dim
`ref_s` tensor Kokoro consumes at inference time.

Two non-trivial findings landed during impl:

1. **`kokoro` PyPI ≥0.9.4 does NOT expose a standalone `style_encoder`.**
   The prior `extract_voice_embedding.py` was written against a
   speculative API; on real kokoro the call `style_encoder(wav_t)`
   exits with "Loaded KModel has no `style_encoder` attribute". The
   inference package only ships `bert`/`bert_encoder`/`predictor`/
   `text_encoder`/`decoder` — the style encoder lives in the
   StyleTTS-2 trainer, not the inference package. **Fix:** rewrote
   `extract_voice_embedding.py` to do a real mel-fit voice clone (see
   §1 below).

2. **`kokoro.KModel` does NOT expose `forward_train`** (the per-batch
   training entrypoint `finetune_kokoro.py` expects). The community
   training fork at `jonirajala/kokoro_training` has its own
   `forward_training` (different name + slightly different signature)
   AND is not pip-installable (no setup.py). Integrating it would
   require either vendoring its model.py or adapting
   `finetune_kokoro.py` to its API — outside I7's plumbing scope.
   **Documented as a gap (§2).**

Result: voice-clone path landed and validated; LoRA path documented
as gated on integrating the training fork.

---

## 1. Voice-clone (primary publish path)

### Implementation

`packages/training/scripts/kokoro/extract_voice_embedding.py` now
runs **mel-fit ref_s optimization**: frozen Kokoro model, the 256-dim
`ref_s` tensor is the only learnable parameter, gradient-descent
minimizes mel-reconstruction loss between the model's forward output
and the actual samantha mel features.

Key design points:

- **`forward_with_tokens` is `@torch.no_grad`-decorated** upstream;
  re-implement the forward path locally (same math, no decorator) so
  gradients flow back to `ref_s`.
- **Model in `train()` mode** even though all parameters are frozen.
  cuDNN refuses RNN backward in eval mode (`RuntimeError: cudnn RNN
  backward can only be called in training mode`).
- **`--init-from-voice af_bella`**: pulls
  `voices/af_bella.pt` from HF and seeds ref_s from its mean-bucket
  vector. Without an init the optimizer drifts on the first few
  hundred steps.
- **L2 anchor regularization on the prosody half**
  (`ref_s[128:]`). The prosody half feeds the duration predictor and
  the F0/energy predictor; perturbing it too much destabilizes
  duration prediction. The timbre half (`ref_s[:128]`) feeds the
  iSTFTNet decoder and is fine to move freely. Default
  `--anchor-weight 0.5`.
- **`--lr 0.01`** (down from naive 0.05). Higher rates destabilize
  duration even with anchor regularization.
- **OOM-resilient loop**: catch `torch.cuda.OutOfMemoryError` per
  batch, `empty_cache()`, skip and continue. The long samantha clips
  (samantha_003 is 200+ words / 10.7s) occasionally OOM at 16 GB; this
  doesn't bias the optimizer because the offending batch is dropped
  cleanly.
- **`--style-encoder-checkpoint`** retained as legacy / forward-compat:
  when an upstream eventually re-exposes a standalone style encoder
  TorchScript, the existing mean-pooling path is recoverable.

### Validation

Verified locally on the RTX 5080 Laptop (16 GB), 58 clips, 400 steps,
init=af_bella, lr=0.01, anchor_weight=0.5:

```
2026-05-14 02:13:55 INFO device=cuda steps=400 clips_with_transcripts=58/58
…
2026-05-14 02:15:41 INFO mel-fit done: final loss=1.1101 mean(last10)=1.4367
2026-05-14 02:15:42 INFO wrote af_samantha.bin (58 clips, mode=mel-fit)
```

Wall time: ~110 s including HF downloads. Loss descended 2.94 → 1.11.

**Synthesis comparison** ("Hi, I'm Samantha. It's nice to finally talk
to you about something real."):

| Voice | Duration | Cosine to af_bella init (overall) | Cosine timbre [:128] | Cosine prosody [128:] |
| --- | --- | --- | --- | --- |
| `af_bella` (stock) | 5.17 s | 1.000 | 1.000 | 1.000 |
| `af_samantha` (mel-fit, anchor=0.5) | **5.22 s** | 0.433 | **0.325** | 0.795 |
| `af_samantha` (mel-fit, anchor=0.0, lr=0.05; broken) | 29.07 s | 0.329 | n/a | n/a |

The anchor-regularized v2 voice keeps duration prediction stable
(5.22 s synth matches the expected ~5 s for that phrase) while the
timbre half (`ref_s[:128]`) has substantively moved away from af_bella
(cosine 0.325). The unregularized v1 was a textbook over-fit: timbre
+ prosody both drifted, the duration predictor went off the rails,
the same phrase rendered as 29 s of audio.

The produced `voice.bin` is in canonical Kokoro layout:

```python
np.fromfile('voice.bin', dtype='<f4').reshape(510, 1, 256)
# shape: (510, 1, 256), dtype: float32 LE
# min: -3.054, max: 3.702, std: 1.111
```

`KokoroTtsBackend.synthesize` consumes this directly (verified by
running the Kokoro pipeline against the `voice.bin` and rendering a
test phrase to `/tmp/kokoro-runs/samantha/sample_samantha_v2.wav`).

### Files touched

- `packages/training/scripts/kokoro/extract_voice_embedding.py` —
  full rewrite of the real path (synthetic-smoke unchanged). +378 / -31.
- 2 commits on `develop`:
  - `c820869de4 wip(I7-kokoro): real voice-clone path via mel-fit ref_s optimization`
  - `7325071ba9 wip(I7-kokoro): anchor regularization + OOM-resilient mel-fit loop`

---

## 2. LoRA experimental path (documented gap)

### What R7 §3 asks for

Run a short LoRA pass against `kokoro_samantha.yaml` (max_steps=2000)
on the RTX 5080 (16 GB), eval against `af_bella` baseline, expect it
to underperform voice-clone on speaker similarity.

### What blocks it

`packages/training/scripts/kokoro/finetune_kokoro.py:390` hard-errors
out when the installed `kokoro` package's `KModel` does not expose
`forward_train`:

```python
forward_train = getattr(model, "forward_train", None)
if forward_train is None:
    raise SystemExit(
        "The installed `kokoro` package does not expose `forward_train`. "
        "Use the community training fork (`pip install "
        "git+https://github.com/jonirajala/kokoro_training`) or update kokoro to "
        ">= the version that ships `forward_train`. See the README for context."
    )
```

The fork at https://github.com/jonirajala/kokoro_training:
- Has its own `model.py` with a renamed `forward_training(...)` method
  (different name, different signature — takes ref_s + phonemes +
  mel-target tensors directly).
- Is NOT pip-installable: no `setup.py` / `pyproject.toml`. `pip
  install git+…` fails immediately.
- Would need to be either vendored into `packages/training/scripts/kokoro/`
  or adapted in-place so the existing `finetune_kokoro.py` can call
  its training entrypoint.

That work is outside I7's plumbing scope. The proper resolution is a
follow-up that:

1. Vendors the training fork as `packages/training/upstream/kokoro_training/`
   (or pins it as a submodule).
2. Bridges `forward_train` → `forward_training` either in the fork's
   model.py monkeypatch or in finetune_kokoro.py's import shim.
3. Verifies LoRA convergence on the smoke fixture (existing
   `test_train_smoke.py` covers the synthetic path; the real path
   needs a CI tier above the current 16 GB local).

### Expected outcome (per R7 §4)

With only 3.5 min of audio and the relaxed `speaker_similarity_min:
0.55` gate, a LoRA pass is expected to under-perform the voice clone
on speaker similarity even if it clears the gates. Per R7 §4:

> With only ~5 held-out clips and the same speaker throughout, ECAPA
> cosine variance is high. 0.55 still cleanly rejects "fine-tune that
> destroyed timbre" while accepting the realistic mid-50s range a
> small-corpus LoRA produces.

So when the LoRA path is unblocked, the publish flow will still
prefer the voice-clone artifact.

---

## 3. Eval (in progress)

### Baseline

`eval_kokoro.py --run-dir /tmp/kokoro-runs/samantha/lora --config
kokoro_samantha.yaml --eval-out eval-bella.json --allow-gate-fail`

Uses the stock `af_bella` voice (the pipeline's default), the 5 val
clips, Whisper large-v3 round-trip WER, ECAPA-TDNN speaker similarity,
torchaudio SQUIM-MOS as UTMOS fallback, and RTF on the val prompts.

(Run in progress at write time; numbers will be patched in once
complete.)

### Candidate (af_samantha mel-fit v2)

Same harness with `--voice-bin /tmp/kokoro-runs/samantha/release/af_samantha/voice.bin
--baseline-eval eval-bella.json`. Emits `comparison.beatsBaseline`
gated on `utmosΔ ≥ 0`, `werΔ ≤ 0`, `spkSimΔ ≥ +0.05`.

### Gates (from `kokoro_samantha.yaml`, set in 6bed228abc)

| Metric | Gate | Source |
| --- | --- | --- |
| UTMOS | ≥ 3.8 | R7 §4 |
| WER | ≤ 0.08 | R7 §4 |
| Speaker similarity | **≥ 0.55** (relaxed) | R7 §4 — small-corpus |
| RTF | ≥ 5.0 | R7 §4 |

---

## 4. HF push (gated on eval)

`packages/training/scripts/kokoro/push_voice_to_hf.py` (landed in
6bed228abc, 6 tests passing) handles the upload. Target:
`elizaos/eliza-1-voice-kokoro-samantha-v01` with `private=true` per
R12 license caveat (samantha is derivative of *Her* 2013, research-
only).

Will execute as dry-run first:

```bash
python3 packages/training/scripts/kokoro/push_voice_to_hf.py \
  --release-dir /tmp/kokoro-runs/samantha/release/af_samantha \
  --hf-repo elizaos/eliza-1-voice-kokoro-samantha-v01 \
  --private --dry-run --create-if-missing
```

The real push is **gated on user/operator authorization** — the model
card explicitly says "research-only, *Her* (2013) derivative; do not
promote to public release without explicit owner sign-off."

---

## 5. Manifest slot-in (coordinate with I5 / I6)

`af_samantha` already appended to `KOKORO_VOICE_PACKS` in
`plugins/plugin-local-inference/src/services/voice/kokoro/voice-presets.ts`
(6bed228abc).

To slot into per-tier bundles, the operator runs:

```bash
python3 packages/training/scripts/manifest/stage_kokoro_assets.py \
  --tier 0_8b --tier 2b --tier 4b --tier 9b \
  --voice samantha \
  --repo-id elizaos/eliza-1-voice-kokoro-samantha-v01 \
  --voice-remote-template 'voices/af_samantha.bin'
```

The `--voice-remote-template` flag was added in 6bed228abc precisely
for per-voice HF repos (R7 §6 caveat).

For I5 (`voice-models.ts`): the canonical record after publish is:

```ts
{
  id: 'kokoro-samantha',
  version: 'v01',
  parentVersion: '<kokoro base v1.0>',
  sha256: '<sha256 of voice.bin>',
  hfRepo: 'elizaos/eliza-1-voice-kokoro-samantha-v01',
  evalDeltas: { utmos, wer, spkSim },
  license: 'research-only',
}
```

---

## 6. Kokoro emotion-knob gap (I3 dependency)

Kokoro's inference signature is `(input_ids, ref_s, speed)` — no
`emotion` parameter. The only knobs surfaced today are voice id +
speed. R3-emotion §6 already documents this: "Kokoro = NO emotion
knob (only `(input_ids, style, speed)` — per-emotion style vectors
needed, R7 dependency)."

**Two ways to ship per-emotion samantha at runtime:**

a. **Per-emotion `ref_s` tensors.** Train (or fit) separate
   `voice.bin` files per emotion bucket (`neutral`, `happy`, `sad`,
   `excited`) by stratifying the samantha corpus on Stage-1 envelope
   `emotion` field (R3 §4) and running the mel-fit path once per
   bucket. Runtime selects the right `ref_s` based on the planner's
   emotion field. Cost: 4× the corpus per bucket → too small at 3.5
   min total. Better with a larger source corpus.

b. **Style-vector interpolation.** Compute a "neutral" ref_s + a
   small set of "delta" tensors and linearly mix at synth time. The
   StyleTTS-2 paper documents this but the math is undocumented in
   the kokoro PyPI package.

Neither is trivial; **flagged as a follow-up to I3**. The current
shipping plan is one `af_samantha` voice (neutral / mixed), no
emotion knob. I3's emotion-attribution writes `Content.emotion`; the
Kokoro backend should ignore it and emit a one-time warning when
voice-id resolves to a kokoro voice with an emotion request.

---

## 7. Tests

- `packages/training/scripts/kokoro/__tests__/` — all 19 tests pass
  (`pytest …`).
- `packages/training/scripts/manifest/test_stage_kokoro_assets.py` —
  5/5 pass.
- `packages/training/scripts/voice/test_build_samantha_manifest.py` —
  5/5 pass (I11).
- The new mel-fit path in `extract_voice_embedding.py` doesn't add new
  pytest tests because the real path requires torch + kokoro + HF
  downloads — out of scope for the synthetic-smoke unit tests already
  covering `_run_synthetic_smoke` + `_write_voice_bin` shape.

---

## 8. Pre-existing test failures (NOT mine)

`test_export.py::test_export_synthetic_smoke_emits_fragment` and
`test_export_default_tags` fail in CI when `onnx` is absent (raise
`SystemExit("synthetic-smoke needs the `onnx` package; install via
…")`. This is pre-existing — installing `onnx` (which is already in
`requirements.txt`) makes both pass. Not an I7 regression.

---

## 9. Status

- [x] Voice-clone path works against real kokoro 0.9.4 API
  (`extract_voice_embedding.py` rewrite).
- [x] Anchor regularization keeps duration stable.
- [x] `af_samantha.bin` produced + verified loadable via `KPipeline`.
- [x] `prep_ljspeech.py` validated on filtered samantha corpus (48
  clips after dropping `<1.0s` clips + the s002 hallucination).
- [ ] Eval baseline (af_bella) — running.
- [ ] Eval candidate (af_samantha) + comparison block.
- [ ] HF push (dry-run) — gated on eval.
- [x] LoRA path documented as blocked on training-fork integration.
- [x] Emotion-knob gap documented (handoff to I3).
- [x] All pre-existing kokoro tests still pass.

Remaining work is eval execution + HF dry-run + sign-off.
