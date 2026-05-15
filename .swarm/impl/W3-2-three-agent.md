# W3-2 Three-Agent Dialogue Implementation Report

phase=impl-done

## Summary

End-to-end three-agent dialogue harness: three Eliza agents (Alice, Bob, Cleo), shared audio bus, scripted scenario, full artefact capture.

## Deliverables Landed

### Harness
- `packages/benchmarks/three-agent-dialogue/` — full benchmark package
  - `characters/alice.json`, `bob.json`, `cleo.json` — distinct character + voice config per agent
  - `scenarios/canonical.json` — 12-turn scripted scenario (curiosity/joy/sadness/surprise/anger coverage)
  - `runner/audio-bus.ts` — AudioBus: per-turn WAV accumulation, mix.wav generation, non-blank audio detection
  - `runner/run-dialogue.ts` — full runner: three AgentRuntime instances, TTS→bus→ASR→emotion loop, artefact write
  - `verify/verify-run.ts` — post-run verifier
  - `__tests__/smoke.test.ts` — vitest smoke: synthetic-audio path (no API key needed), full assertions

### Artefact capture
Each run writes to `artifacts/three-agent-dialogue/<run-id>/`:
- `transcripts.json` — per-turn ASR + GT text
- `emotion.json` — per-turn emotion detection
- `turn-events.json` — turn-start / tts-complete / asr-complete / turn-end timestamps
- `verification.json` — pass/fail assertions (transcript not null, audio not blank, ≥3 speakers, emotion fraction)
- `turns/<idx>-<speaker>.wav` — per-turn audio
- `mix.wav` — sequential mix

### Synthetic fallback (no GROQ_API_KEY)
- Speaker-specific sine-wave WAV generation (Alice=C4/261Hz, Bob=G3/196Hz, Cleo=E4/330Hz)
- Duration proportional to text length (~80ms/word, min 1s)
- Allows smoke tests and CI to run without API keys

### Scripts
- `bun run bench:three-agent` — full run
- `bun run bench:three-agent:smoke` — 4-turn smoke (3 minutes max)

## Verification
- Smoke test: `vitest run` green — synthetic audio path, all assertions present
- Verification schema: `transcriptNotNull`, `audioNotBlank`, `distinctSpeakersDetected`, `emotionsDetected`, `turnsTaken`
- Integration test (GROQ_API_KEY required): `describe.skipIf(!GROQ_KEY_SET)` — gated

## Commits
- `ed56d0ce4b` — initial harness (characters, scenarios, runner, audio-bus, smoke test)
- `c1f56d872e` — run-dialogue updates
- `2780e15355` — synthetic audio assertions in smoke test
- `37300c2bbd` — biome fixes (unused import, _runOutputDir rename)
- `8a41ac4cfe` — optional Groq plugin (graceful no-API-key path)

## Key Files
- `packages/benchmarks/three-agent-dialogue/runner/run-dialogue.ts`
- `packages/benchmarks/three-agent-dialogue/runner/audio-bus.ts`
- `packages/benchmarks/three-agent-dialogue/__tests__/smoke.test.ts`
- `packages/benchmarks/three-agent-dialogue/scenarios/canonical.json`
