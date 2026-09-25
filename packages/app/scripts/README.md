# `scripts/` — build, dev orchestration, tooling

Build, development, packaging, and platform orchestration for the Eliza app. Invoke scripts through the root or app package manifests.

This directory is part of `packages/app`.

Build from the repository root:

```bash
bun run build:client
```

Test from the repository root:

```bash
bun run --cwd packages/app test
```
