# Issue #11371 — local model path re-anchor

## What Changed

- Eliza-owned local-inference registry rows now persist model artifact paths
  relative to the current `local-inference/` root.
- Registry reads hydrate relative rows to absolute paths for runtime use.
- Legacy absolute rows from a previous mobile container are re-anchored by their
  `/local-inference/...` suffix under the current state root.
- The iOS bridge now reads both relative rows and legacy absolute rows, and its
  native download writer stores relative paths.

## Regression Evidence

- `plugins/plugin-local-inference/src/services/registry.test.ts`
  - Verifies new registry writes store `path`, `bundleRoot`, and `manifestPath`
    as relative values.
  - Simulates an old container root in `registry.json`, creates the same model
    artifact under a new state root, and verifies `listInstalledModels()`
    resolves the model, bundle root, and manifest inside the new root.
- `plugins/plugin-local-inference/src/services/downloader.test.ts`
  - Verifies downloader raw registry output is relative while hydrated runtime
    registry output remains absolute for verify/load callers.

## Commands Run

```bash
bun run --cwd packages/contracts build
bun run --cwd packages/skills build
bun run --cwd packages/cloud/routing build
bun run --cwd plugins/plugin-streaming build
bun run --cwd plugins/plugin-sql build
bun run --cwd plugins/plugin-coding-tools build
bun run --cwd plugins/plugin-background-runner build
bun run --cwd plugins/plugin-anthropic build
```

Result: passed. These generated ignored local `dist/` artifacts needed by the
package typecheck resolvers in this side worktree.

```bash
bun run --cwd plugins/plugin-local-inference test
```

Result: passed, 223 files / 2240 tests; 1 file / 13 tests skipped.

```bash
bun run --cwd plugins/plugin-local-inference typecheck
bun run --cwd plugins/plugin-capacitor-bridge typecheck
```

Result: both passed.

```bash
bun run --cwd plugins/plugin-local-inference build
bun run --cwd plugins/plugin-capacitor-bridge build
```

Result: both passed.

```bash
bunx @biomejs/biome check plugins/plugin-local-inference/src/services/downloader.test.ts plugins/plugin-local-inference/src/services/paths.ts plugins/plugin-local-inference/src/services/registry.ts plugins/plugin-local-inference/src/services/registry.test.ts plugins/plugin-local-inference/src/local-inference-routes.ts plugins/plugin-capacitor-bridge/src/ios/bridge.ts
```

Result: passed, no fixes needed.

```bash
bun run verify
```

Result: blocked before typecheck/lint by repo-wide type-safety ratchet on
current `origin/develop`: `as unknown as` is `80 / 77` and core/agent/app-core
``?? {}`` is `379 / 377`.

No UI, LLM, audio, or Swift/Kotlin native-code behavior changed. Full iOS
reinstall capture was not run in this branch; the root-change regression above
exercises the stale-container absolute-path failure mode directly.
