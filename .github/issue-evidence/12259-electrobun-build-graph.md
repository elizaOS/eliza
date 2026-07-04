# Issue #12259 - Electrobun builds inside the Turbo graph

## Change

- Removed the root build script's `!@elizaos/electrobun` Turbo filter.
- Removed the appended `bun run --cwd packages/app-core/platforms/electrobun build` tail step.
- Left `bun run check:view-bundles` as the root build tail gate.

The existing `@elizaos/electrobun#build` Turbo task has `dependsOn: ["@elizaos/app#build", "^build"]`, `cache: false`, and `outputs: []`, so Electrobun keeps its build ordering while running inside the graph.

## Verification

Run on 2026-07-04:

- Static root script assertion:
  - root `build` no longer contains `!@elizaos/electrobun`
  - root `build` no longer contains `--cwd packages/app-core/platforms/electrobun build`
  - root `build` still contains `bun run check:view-bundles`
- Turbo dry run:
  - `node packages/scripts/run-turbo.mjs run build --concurrency=8 --filter='!./packages/examples/**' --filter='!./packages/benchmarks/**' --cache=local:rw,remote:r --output-logs=errors-only --dry=json`
  - Confirmed the task set contains `@elizaos/electrobun#build`.
  - Confirmed `@elizaos/electrobun#build` depends on `@elizaos/app#build`.
- `git diff --check`
- `git diff --check origin/develop..HEAD`

The Turbo dry run used a temporary `node_modules` symlink to the main checkout because the auxiliary worktree does not have a local install.

## Evidence notes

Screenshots and recordings are N/A: this is a root CLI/Turbo build-graph change with no user interface.
