# Evidence — #12257 (diarization in the speak-back loop + windowed long turns)

Part of #12187. Wires the already-built diarization/self-voice stack into the
production speak-back loop (Pipeline B) and windows long turns.

## What is proven here

| Claim | Artifact |
| --- | --- |
| Two distinct speakers → two distinct on-disk profiles | `voice-profiles/profiles/vp_*.json` (2 files), `synthetic-multispeaker-attribution.json` |
| Same speaker re-identified across turns (disk-backed) | `synthetic-multispeaker-attribution.json` → `reidentifiedAsSpeakerA: true`, profile A `sampleCount: 2`, `totalDurationMs: 17000` |
| Long turn is windowed: 5 s windows decode DURING capture, only the trailing partial post-endpoint | `synthetic-multispeaker-attribution.json` → `windowsDiarizedDuringCapture: 2`, `postEndpointWindowSeconds: 4` |
| `beginMatch` resolves speaker identity at speech-start (parallel with ASR) | `synthetic-multispeaker-attribution.json` → `speechStartSpeculativeMatch: vp_4eb2…` (resolved before `finalize`) |
| Shipped decision logic (respond / echo / owner-security / diarization / long-turn / barge-in scoring) does not regress | `workbench-logic-report.{json,md}` → PASS, 24/24, no regressions vs baseline (post-#12258) |
| The `--real` acoustic lane fails honestly when GGUFs are unstaged (no false-pass) | `real-lane-hardfail.txt` (exit 1) |

## Reproduce

```bash
# Domain artifacts (real store + real MFCC DSP encoder + real windowing):
bun .github/issue-evidence/12257-diarization/generate-evidence.ts

# Shipped decision logic vs golden baseline:
bun run --cwd plugins/plugin-local-inference voice:workbench -- --logic \
  --baseline plugins/plugin-local-inference/src/services/voice/__fixtures__/voice-workbench-logic-baseline.json
```

## DER vs the #12258 ceilings

`workbench-logic-report.json` — **Diarization DER mean 0.01, worst 0.2394**
across 24 scenarios (post-#12258; real shipped decision logic, ground-truth
diarization timelines; the DER scorer is `diarization-error-rate.ts`, exact
permutation ≤ 7 speakers). Includes #12258's new `long-turn-diarization` (20
cases) and `speaker-gated-barge-in` (14 cases) scenarios — both PASS. Owner
accuracy 1.0, impostor-accept 0, barge-in gating accuracy 1.0. No regression vs
the committed logic baseline, so the windowing change does not degrade the
scored decision paths.

#12258's offline pyannote ceilings are **VoxConverse 11.3% / AMI 18.8%**, and
the streaming budget for windowed decoding is **+10 pp** (parent research,
DIART arXiv:2407.04293). What the **`--real` lane WOULD assert** with staged
`ELIZA_TEST_SPEAKER_GGUF` / `ELIZA_TEST_DIARIZ_GGUF` + the fused library:
windowed frame-DER ≤ **~21.3 %** (VoxConverse-class) / ≤ **~28.8 %** (AMI-class)
on the acoustic diarization/overlapping-speech scenarios, `minOwnerAccuracy`
held and impostor-accept 0 on owner-security. That lane is **not reachable in
this worktree** — the GGUFs and fused `libelizainference` are unstaged; the run
hard-fails (`real-lane-hardfail.txt`) rather than skipping to a false green.

## Honesty note on the domain-artifact run

`generate-evidence.ts` exercises the **real** `VoiceProfileStore` (real disk
records, Welford refine, cosine clustering), the **real** windowed
`VoiceAttributionPipeline` (`beginTurn` / `pushWindow` / `finalize` +
`beginMatch`), and a **real** MFCC-style DSP encoder (`extractTimbreEmbedding`)
over the synthetic multi-speaker corpus (`__test-helpers__/synthetic-speech.ts`).
The one thing it does **not** run is the native WeSpeaker + pyannote GGUF forward
pass (unstaged here). The embedding model on the profiles is therefore labelled
`mfcc-timbre-13d`, not `wespeaker-resnet34-lm-int8`.
