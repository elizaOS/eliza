# Three-Agent Dialogue Benchmark

End-to-end benchmark that spawns three Eliza agents (Alice, Bob, Cleo), each with a distinct Groq TTS voice, and runs a scripted turn-taking scenario through a shared AudioBus. Each run captures per-turn audio, a sequential mix, ASR transcripts, emotion detection results, turn-taking events, and a pass/fail verification report. The harness falls back to synthetic sine-wave audio when `GROQ_API_KEY` is not set, so all structural assertions pass in CI without credentials.

## Quick Start

```bash
# Full run (real Groq TTS + ASR — requires GROQ_API_KEY)
bun run bench

# Smoke run (first 4 turns, synthetic audio, no API key needed)
bun run bench:smoke

# Run tests
bun run test
```

See [AGENTS.md](AGENTS.md) for the full layout, flags, and test details.
