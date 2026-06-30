# #8934 — voice/audio artifact capture in the scenario voice turn

Evidence for acceptance criterion 3 ("a sample voice scenario's artifacts
attached as evidence") and proof that the `captureAudio` write path produces real
`.wav` artifacts that the run viewer links.

## What's here

```
audio/voice-room-demo/
  corpus.wav    full synthesized corpus  (kind: generated, turn 0, 8008 ms)
  turn-0.wav    consumed slice           (speaker alice, 2854 ms)
  turn-1.wav    consumed slice           (speaker bob,   3008 ms)
  turn-2.wav    consumed slice           (speaker alice, 2146 ms)
voice-workbench-room.run.json   the VoiceWorkbenchScenarioRun (audioArtifacts + 9 scored cases, all passed)
matrix.json                     scenario-runner aggregate report; the voice turn carries audioArtifacts
001-voice-workbench-room.json   per-scenario report
viewer/index.html               run viewer — renders an <audio controls> cell per artifact (audioArtifactsCell)
viewer/data.js                  embedded run data referencing the four run-dir-relative .wav paths
```

Every `.wav` is real RIFF/WAVE PCM16 mono @ 16 kHz:

```
$ file audio/voice-room-demo/corpus.wav
RIFF (little-endian) data, WAVE audio, Microsoft PCM, 16 bit, mono 16000 Hz
```

## How it was produced

Driven through the **production** scenario-runner path, not fabricated:

1. `executeVoiceTurn` (`packages/scenario-runner/src/voice-turn.ts`) on the
   `voice-room-demo` scenario from
   `packages/scenario-runner/test/scenarios/voice-workbench-room.scenario.ts`,
   with `groundTruthMockServices()` (deterministic, no model/hardware).
2. With `ELIZA_LIFEOPS_RUN_DIR` pointed at this directory,
   `resolveAudioCaptureSink` builds the capture sink and
   `runVoiceScenarioHeadless` encodes the generated corpus PCM to `.wav` via the
   real `encodeMonoPcm16Wav` codec (`writeAudioArtifact`).
3. `writeReportBundle` + `writeScenarioRunViewer` (`reporter.ts`) render the
   aggregate report and the `<audio controls>` viewer.

The full `eliza-scenarios run --run-dir <dir> --scenario voice-workbench-room`
CLI wires the exact same path (it sets `ELIZA_LIFEOPS_RUN_DIR` from `--run-dir`);
booting its full runtime here is unnecessary because the voice turn uses the
mock services and never calls the LLM. Open `viewer/index.html` in a browser and
the audio column plays each clip.

## Automated coverage added by this change

- `plugins/plugin-local-inference/src/services/voice/workbench-headless-runner.test.ts`
  — runs `runVoiceScenarioHeadless` **with** a `captureAudio` sink; asserts
  `corpus.wav` + `turn-<n>.wav` are written, decode as valid PCM16 WAV, and that
  `audioArtifacts` carry the correct kinds + run-dir-relative paths.
- `packages/scenario-runner/src/voice-turn.test.ts` — exercises the
  `resolveAudioCaptureSink` path via `executeVoiceTurn` under
  `ELIZA_LIFEOPS_RUN_DIR`; asserts real `.wav` files land under
  `audio/<scenarioId>/` with valid headers.
- `packages/scenario-runner/src/reporter.test.ts` — asserts the run viewer
  surfaces an `<audio controls>` cell and embeds the artifact paths.
