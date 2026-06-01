# Three-Agent Dialogue — Agent Guide

End-to-end benchmark that spawns three Eliza agents (Alice, Bob, Cleo), each
with a distinct Groq TTS voice, runs a scripted turn-taking scenario through a
shared AudioBus, and verifies diarization, emotion detection, ASR transcripts,
and non-blank audio output. Not registered in the suite orchestrator — run
directly.

## Run

```bash
# From this directory
bun run bench

# With explicit scenario and output path
bun run runner/run-dialogue.ts --scenario=canonical --output=/tmp/run-out

# From the repo root
bun run --cwd packages/benchmarks/three-agent-dialogue bench
```

Set `GROQ_API_KEY` for real TTS + ASR. Without it the harness falls back to
synthetic sine-wave audio automatically; all verification assertions still pass.

## Smoke test (no API key required)

```bash
# Via npm script (sets THREE_AGENT_SMOKE=1, runs first 4 turns only)
bun run bench:smoke

# Or manually
THREE_AGENT_SMOKE=1 bun run runner/run-dialogue.ts
# or
bun run runner/run-dialogue.ts --smoke
```

## Test the harness

```bash
# From this directory
bun run test

# Watch mode
bun run test:watch
```

The test suite in `__tests__/smoke.test.ts` covers AudioBus unit tests,
scenario/character file validation, and a synthetic-fallback integration run
(no API key needed). Integration tests against real Groq TTS + ASR are skipped
unless `GROQ_API_KEY` is set.

## Layout

| Path | Role |
| --- | --- |
| `runner/run-dialogue.ts` | CLI entrypoint and main execution loop |
| `runner/audio-bus.ts` | Shared AudioBus (publish, mix, flush to WAV) |
| `verify/verify-run.ts` | Post-run artefact verifier |
| `scenarios/canonical.json` | Scripted turn scenario (turns, smoke subset, thresholds) |
| `characters/alice.json` | Alice character + Groq TTS voice config |
| `characters/bob.json` | Bob character + Groq TTS voice config |
| `characters/cleo.json` | Cleo character + Groq TTS voice config |
| `__tests__/smoke.test.ts` | vitest suite (unit + integration smoke) |
| `vitest.config.ts` | vitest configuration |

## Notes

- Artifacts write to `artifacts/three-agent-dialogue/<run-id>/` at the repo
  root (gitignored). Each run produces: `turns/<idx>-<speaker>.wav`, `mix.wav`,
  `transcripts.json`, `emotion.json`, `turn-events.json`, `verification.json`.
- Not registered in `registry/commands.py` — no orchestrator invocation.
- Full background: no README present (see this file).
