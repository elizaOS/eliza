# Autonomous Rust Agent

A minimal autonomous Eliza agent written in Rust, packaged as a single binary (~5 MB). Originally by [@millw14](https://github.com/millw14) — migrated from [elizaOS/eliza#6613](https://github.com/elizaOS/eliza/pull/6613).

## How it works

1. On startup, detects available RAM and picks the biggest local LLM that fits (via Ollama)
2. Installs Ollama automatically if not present, pulls the selected model
3. Monitors human activity — waits until 2 minutes of idle
4. While idle, runs an autonomous loop every 30 seconds:
   - Feeds its journal + system context to the local model
   - Model responds with `SHELL: <command>`, `THINK: <thought>`, or `WAIT`
   - Shell output and thoughts are appended to `~/.virus/journal.txt`
5. Goes back to sleep the moment the human returns

## Model selection by available RAM

| RAM | Model |
|-----|-------|
| <5 GB | qwen2.5:1.5b |
| 5-10 GB | qwen2.5:7b |
| 10-20 GB | qwen2.5:14b |
| 20-48 GB | qwen2.5:32b |
| 48+ GB | qwen2.5:72b |

## Build & Run

```bash
cargo build --release
./target/release/virus
```

## Status

Concept art / proof of concept. Windows-focused (uses Win32 APIs for idle detection).
