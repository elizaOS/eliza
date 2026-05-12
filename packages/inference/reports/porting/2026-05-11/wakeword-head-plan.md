# Eliza-1 wake-word head — current state + plan to train the real head

**Status as of 2026-05-11:** the wake-word surface is wired and runs, but
the head currently shipped in bundles (`wake/hey-eliza.onnx`) is a
**placeholder** — the upstream openWakeWord `hey_jarvis_v0.1.onnx` head
renamed. It fires on **"hey jarvis"**, not the Eliza-1 wake phrase. Wake
word is opt-in and off by default (push-to-talk / VAD-gated voice works
without it), so this is an **experimental** surface, not a finished
feature, until a real head is trained.

## What is already done (runtime side)

- The full openWakeWord three-stage streaming pipeline is implemented in
  `packages/app-core/src/services/local-inference/voice/wake-word.ts`:
  `melspectrogram.onnx` → `embedding_model.onnx` → `<head>.onnx`, with
  the upstream feature rescale (`x/10 + 2`) and frame-to-frame state
  (audio tail, mel ring, embedding ring). `OpenWakeWordDetector` adds
  threshold gating + a refractory-frame debounce so a sustained
  detection fires `onWake` once.
- It is opt-in and local-mode only:
  `LocalInferenceEngine.startVoiceSession({ wakeWord: { enabled, head?,
  threshold?, onWake? } })` — off by default; in `cloud` mode the
  surface is hidden *and inert* (no model load, the setting is rejected,
  no background job), per `packages/inference/AGENTS.md` §1/§5.
- A bundle with no `wake/` graphs is fine — `loadBundledWakeWordModel`
  returns `null` and the session runs VAD-gated. A bundle with the
  graphs but a broken/corrupt ONNX throws `WakeWordUnavailableError`.
- `isPlaceholderWakeWordHead(head)` /
  `OPENWAKEWORD_PLACEHOLDER_HEADS = { "hey-eliza", "hey_jarvis" }` mark
  the placeholder head, and the engine emits a one-time warning whenever
  a voice session enables a placeholder head:
  `[voice] wake word head 'hey-eliza' is a PLACEHOLDER (...) — it fires
  on "hey jarvis", not the Eliza-1 wake phrase. Experimental, opt-in
  only; see .../wakeword-head-plan.md.`
- Tests: `voice/wake-word.test.ts` (scripted-model debounce/refractory
  cases + a network-gated real-ONNX-graph smoke that downloads the
  upstream `melspectrogram`/`embedding`/`hey_jarvis` graphs).

## What is NOT done

- No head trained on the **approved Eliza-1 wake phrase**. The approved
  phrase itself is a product decision and is **not chosen here** — pick
  it before training (a two-or-three-syllable phrase that openWakeWord's
  TTS-augmented pipeline handles well; "hey eliza" is the obvious
  candidate but the placeholder filename is *not* a commitment).
- The wake-word head is not in any bundle manifest's
  `kernels`/`evals`/lineage block as a first-class component — it is an
  optional `wake/` asset only. It does not gate `defaultEligible`.

## Plan — train a head on the approved Eliza-1 wake phrase

openWakeWord (Apache-2.0, https://github.com/dscripka/openWakeWord)
trains a small dense head on top of the frozen, model-agnostic
`melspectrogram` + `embedding` front-end. The head is the only thing
that changes per wake phrase; the front-end graphs ship as-is.

Steps (run on the training box, not in the runtime repo):

1. **Choose the phrase.** Confirm the approved Eliza-1 wake phrase with
   the product owner. Record it in the bundle manifest's lineage notes
   when the head ships.

2. **Synthesize positives.** Use openWakeWord's
   `openwakeword.data.generate_samples` / the `piper-sample-generator`
   pipeline to TTS thousands of utterances of the phrase across many
   voices, speeds, and pitches. openWakeWord's training notebook
   (`notebooks/training_models.ipynb`, `automatic_model_training.ipynb`)
   is the reference recipe — it expects ~30k–50k positive clips for a
   robust head.

3. **Assemble negatives.** The standard openWakeWord negative corpus:
   ACAV100M / FMA / Common Voice (non-phrase speech) + room-impulse and
   noise augmentation (the same `audiomentations` chain the notebook
   uses). The phrase must *not* appear in the negatives.

4. **Compute features once.** Run every positive + negative clip through
   the frozen `melspectrogram.onnx` → `embedding_model.onnx` to get the
   16×96 embedding windows the head consumes. Cache these — training the
   head itself is minutes on CPU.

5. **Train the head.** `openwakeword.train.train_model` (a few dense
   layers, binary cross-entropy, the notebook's default schedule).
   Validate on held-out positives + a hard-negative set (similar-sounding
   phrases) to set the operating threshold; openWakeWord's default
   `threshold ≈ 0.5` is a starting point — tune for the
   false-accept/false-reject trade-off you want on-device.

6. **Export ONNX.** Export the trained head to `<phrase>.onnx` with the
   same input shape the runtime expects (`[1, 16, 96]` float32 → scalar
   P(wake)). Sanity-check it against `OpenWakeWordModel.load(...)` +
   `scoreFrame` on a few real recordings.

7. **Ship it.** Put `melspectrogram.onnx`, `embedding_model.onnx`, and
   `<phrase>.onnx` under `wake/` in the relevant tier bundles. Set
   `OPENWAKEWORD_DEFAULT_HEAD` to the new head name, drop the head from
   `OPENWAKEWORD_PLACEHOLDER_HEADS` (the placeholder warning then stops),
   and record the head's provenance (training data sources, openWakeWord
   commit, threshold) in the bundle's release notes. Add a real-recording
   accuracy figure (true-accept rate on held-out positives, false-accept
   rate per hour on the negative corpus) to the bundle's eval notes.

8. **License.** openWakeWord and its default front-end graphs are
   Apache-2.0 — already covered by `licenses/LICENSE.wakeword`. The
   TTS-synthesized training data inherits the TTS model's license; use
   a permissively-licensed TTS (piper / its voices are MIT/CC0-ish) so
   the head stays redistributable. Record the TTS source in the
   provenance notes.

## Until then

- Keep the head gated as a placeholder: opt-in, off by default, the
  engine warns on every session that enables it. Do **not** advertise
  "say 'hey eliza'" in any user-facing copy while the shipped head is
  the renamed `hey_jarvis` head.
- The placeholder is genuinely usable for development/demos of the
  wake-gate plumbing — it just responds to the wrong phrase.
