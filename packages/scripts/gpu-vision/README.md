# GPU vision service (`packages/scripts/gpu-vision/`)

Stands up the local GPU vision lane for the evidence analyzer registry ([#14543](https://github.com/elizaOS/eliza/issues/14543), epic [#14541](https://github.com/elizaOS/eliza/issues/14541)): **one resident `llama-server` + a job queue**, not a model load per image.

This directory is part of `.`.

Build from the repository root:

```bash
bun run --cwd . build
```

Test from the repository root:

```bash
bun run --cwd . test
```
