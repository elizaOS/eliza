# @elizaos/three-agent-dialogue

End-to-end benchmark that spawns three Eliza agents (Alice, Bob, Cleo), each with a
distinct Groq TTS voice, runs a scripted turn-taking scenario through a shared AudioBus,
and verifies diarization, emotion detection, ASR transcripts, and non-blank audio
output.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/benchmarks/suites/three-agent-dialogue typecheck  # static validation
```

No standalone build script is defined; this package is consumed or executed from source.

Run the harness with `bun run --cwd packages/benchmarks/suites/three-agent-dialogue bench`. Live runs require the suite’s configured models, credentials, or hardware; offline tests do not establish a benchmark score.

No standalone `test` script is defined in this package. Typechecking is not a substitute for runtime tests.
