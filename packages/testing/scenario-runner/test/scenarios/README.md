# Scenario Runner Deterministic PR Catalog

`bun run --cwd packages/testing test:pr:e2e` runs the zero-cost PR catalog with `SCENARIO_USE_DETERMINISTIC_MODEL=1`.

This directory is part of `packages/testing`.

No package build script is defined; this workspace is consumed from source.

Test from the repository root:

```bash
bun run --cwd packages/testing test
```
