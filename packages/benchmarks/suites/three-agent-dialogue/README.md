# Three-Agent Dialogue Benchmark

End-to-end benchmark that spawns three Eliza agents (Alice, Bob, Cleo), each with a distinct Groq TTS voice, and runs a scripted turn-taking scenario through a shared AudioBus. Each run captures per-turn audio, a sequential mix, ASR transcripts, emotion detection results, turn-taking events, and a pass/fail verification report.

**Scoring is honest about realness.** A run is scored (`mode: "real"`, `scored: true`) only when every turn used real Groq TTS + real ASR; transcript and emotion checks evaluate the real ASR output, never the ground-truth prompt. Without `GROQ_API_KEY` the harness falls back to synthetic sine-wave audio for structural smoke-testing only: the run is reported as `mode: "synthetic-smoke"`, `scored: false`, transcript/emotion checks are skipped-with-report, and a full (non-smoke) run on the synthetic path **fails** verification.

## Quick Start

```bash
# Full scored run (real Groq TTS + ASR — requires GROQ_API_KEY; fails without it)
bun run bench

# Smoke run (first 4 turns; synthetic audio allowed, structural checks only, never scored)
bun run bench:smoke

# Run tests
bun run test
```

See [AGENTS.md](AGENTS.md) for the full layout, flags, and test details.
