# #9147 — real-model voice evidence (WeSpeaker self-voice + pyannote diarizer), Linux x86-64

Ran the **real fused models** (not mocks, not ground-truth copies) on a Linux
x86-64 host, through the staged `libelizainference.so`
(`eliza_inference_speaker_*` + `eliza_inference_diariz_*`, ABI v12) with the
**published GGUFs** downloaded from HF `elizaos/eliza-1`:

| asset | sha256 (first 16) | matches catalog |
|---|---|---|
| `voice/speaker-encoder/wespeaker-resnet34-lm.gguf` | `ad066730b125f61a` | ✅ |
| `voice/diarizer/pyannote-segmentation-3.0.gguf` | `30983eba41c0a99a` | ✅ |

Machine-readable numbers: `9147-real-encoder-selfvoice.json`.

## ✅ WeSpeaker speaker encoder + live self-voice rejection — REAL, PASS

- **256-d, unit-norm** embedding (`|emb| = 1.0000`), deterministic.
- **Real speaker separability** (pairwise cosine, real WeSpeaker):

  |            | golden-stt | vad-speech | wakeword | known-phrase |
  |------------|:---:|:---:|:---:|:---:|
  | golden-stt | 1.00 | 0.62 | 0.63 | 0.20 |
  | vad-speech | 0.62 | 1.00 | 0.79 | 0.20 |
  | wakeword   | 0.63 | 0.79 | 1.00 | 0.20 |
  | known-phrase | 0.20 | 0.20 | 0.20 | 1.00 |

  A different speaker (`known-phrase`) sits at cosine 0.20 to the others — well
  below the `0.78` match threshold — i.e. real impostor separation.

- **Live `selfVoiceSimilarity` (the gate input that used to be a hardcoded
  `0.9`)**, computed from real embeddings:
  - same voice vs itself: **0.994**
  - same voice vs a different real speaker: **0.501**
  - **margin = 0.493** (≫ the 0.1 echo-rejectability margin)
  - fed into the shipped gate (`buildVoiceTurnSignal`, `agentSpeaking:true`) →
    `agentShouldSpeak = false`, `source = "client-ambient+self-voice"`. **The
    agent's own voice is acoustically suppressed past the wake word, for real.**

This closes the self-voice-rejection / speaker-recognition half of the matrix
with real-model numbers (AC1 + the "Self-voice", "Enrollment/imprints", and
"Owner vs intruder" separability rows).

## ⚠️ pyannote diarizer — real forward pass runs, but OVER-DETECTS (DER fails)

The diarizer forward pass runs on real audio, but its on-device output
**over-detects overlap and speakers**, so DER is far above any usable budget:

- **golden-stt, 5 s, single speaker** → 3 local speakers, **6439 ms of "overlap"
  on a 5 s window** (≈ every frame flagged as 2 simultaneous speakers). DER vs a
  single-speaker ground truth = **0.79** (false-alarm dominated).
- A constructed 2-speaker window → DER **0.96** (false-alarm 3340 ms).

Root cause (code-level): the on-device reducer one-hots the **argmax of the
pyannote powerset head per frame** (`diarizer-fused.ts` →
`classifyFramesToSegments`), which picks overlap classes (4/5/6) far too readily.
Real pyannote binarizes each speaker independently with a threshold + clustering;
the argmax-over-powerset shortcut inflates overlap. This is a **diarizer-quality
bug**, not a harness artifact — it reproduces on clean single-speaker audio. It
is the reason a DER **gate** is meaningful: it correctly *fails* this build.

→ Tracked as a dedicated diarizer-quality issue (see #9147 thread).

## Reproduce

```bash
# download the published GGUFs
base=https://huggingface.co/elizaos/eliza-1/resolve/main/voice
mkdir -p models/speaker models/diariz
curl -sSL "$base/speaker-encoder/wespeaker-resnet34-lm.gguf" -o models/speaker/wespeaker-resnet34-lm.gguf
curl -sSL "$base/diarizer/pyannote-segmentation-3.0.gguf"     -o models/diariz/pyannote-segmentation-3.0.gguf
# run with a fused libelizainference that exports eliza_inference_speaker_* + _diariz_*
ELIZA_INFERENCE_LIBRARY=/path/to/libelizainference.so \
ELIZA_VOICE_REAL_MODEL_DIR="$PWD/models" \
  bun packages/app-core/scripts/voice-attribution-smoke.ts --require-real
```

The automated provisioned CI lane (`voice-live-e2e.yml`) that runs this on every
nightly/hardware build is tracked in #9454 (runner + secret provisioning).
