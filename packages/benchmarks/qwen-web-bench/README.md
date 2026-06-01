# qwen-web-bench

Placeholder and integration notes for **QwenWebBench**, an internal front-end code-generation benchmark built by the Qwen team. The benchmark has not been publicly released; this directory holds wiring documentation so integration work can proceed the moment upstream ships.

## Files

| File | Purpose |
|---|---|
| `INTEGRATION.md` | Full integration notes: what QwenWebBench is, why no clone exists yet, where to watch for the upstream release, a sketch integration plan, and adapter/scoring guidance. |

## What this directory is NOT

This is not a runnable harness. There is no benchmark code, dataset, or adapter here. When (if) QwenWebBench is released publicly, the implementation described in `INTEGRATION.md` lands here: runner script, adapter wiring, headless-render sandbox config, and a `registry.py` entry.

## Key facts (from INTEGRATION.md)

- **Score format:** Elo / Bradley-Terry rating (range ~1000–1500+), not percentage accuracy.
- **Task categories:** Web Design, Web Apps, Games, SVG, Data Visualization, Animation, 3D (7 total).
- **Judge:** multimodal — generated artifacts are rendered headlessly and scored on code + visual correctness.
- **Adapter target (when ready):** `eliza-adapter` or a new dedicated single-turn code-gen adapter (not `openclaw-adapter`).
- **No public repo as of 2026-05-12.** Track `github.com/SKYLENAGE-AI` and the Qwen HF org for release.

See `../AGENTS.md` for suite-level conventions and how benchmarks are registered and run.
