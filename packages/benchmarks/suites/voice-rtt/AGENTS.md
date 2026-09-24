# Voice RTT Benchmark — Agent Guide

Provider-agnostic TypeScript benchmark for end-to-end voice latency:
Deepgram Flux -> Cerebras `gemma-4-31b` -> Cartesia Sonic 3.5. This package is
self-contained and is not registered in the benchmark orchestrator.

## Run

```bash
# Deterministic CI/smoke path, no provider keys.
bun run bench:mock

# Write report.md + report.json.
bun run bench:mock -- --out=./results

# Live provider path. Requires keys and 16 kHz PCM corpus files.
DEEPGRAM_API_KEY=... CEREBRAS_API_KEY=... CARTESIA_API_KEY=... \
  bun run bench:live -- --audio-dir=./audio
```

Live mode gates are advisory by default. Add `--enforce-live-gates` only after a
baseline is accepted for the environment.

## Test

```bash
bun run test
bun run typecheck
bun run format:check
```

## Layout

| Path | Role |
| --- | --- |
| `fixtures/corpus.json` | Fixed short/long/pause/barge-in corpus and deterministic mock timings |
| `src/types.ts` | Provider adapter and trace/report contracts |
| `src/adapters/mock.ts` | Deterministic CI adapters |
| `src/adapters/live.ts` | Live Deepgram/Cerebras/Cartesia adapters |
| `src/run-turn.ts` | One-turn orchestration, cancellation, and no-post-interrupt-audio assertions |
| `src/metrics.ts` | Percentiles, stage attribution, and gates |
| `src/report.ts` | Redacted JSON and Markdown artifacts |
| `src/runner.ts` | CLI entrypoint |
| `tests/` | Vitest coverage for math, corpus, reports, gates, cancellation, deterministic run |

## Notes

- Do not create an elizaOS runtime from this package.
- Do not modify production routes or UI for this benchmark.
- Do not commit generated results or live artifacts.
- Keep transcripts and model replies out of artifacts unless
  `--unsafe-transcripts` is explicitly supplied.
