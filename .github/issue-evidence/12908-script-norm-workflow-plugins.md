# Issue #12908 evidence - script normalization workflow plugins

## Scope

Normalized standard package scripts for the #12908 workflow/LifeOps/app/tool plugin
slice:

- `plugins/plugin-personal-assistant`
- `plugins/plugin-health`
- `plugins/plugin-computeruse`
- `plugins/plugin-coding-tools`
- `plugins/plugin-shell`
- `plugins/plugin-training`
- `plugins/plugin-browser`
- `plugins/plugin-wallet`

Also fixed the package-local fallout required to make those scripts runnable:

- Biome formatting/import cleanup in packages where the newly added read-only
  checks exposed existing drift.
- `plugins/plugin-health/tsconfig.json` native Capacitor aliases needed for its
  existing typecheck script.
- `turbo.json` dependency ordering for `@elizaos/plugin-personal-assistant#typecheck`,
  so its existing typecheck gets the local plugin/native dependency builds first.

## Validation

- `bun install --no-save --ignore-scripts --cache-dir "$HOME/.bun-install-cache-deploy"` - pass
- `node packages/scripts/ensure-workspace-symlinks.mjs` - pass
- `node packages/shared/scripts/generate-keywords.mjs --target ts` - pass
- `bun run --cwd packages/contracts build` - pass
- `bun run --cwd packages/cloud/routing build` - pass
- Static script-contract audit for all 8 scoped packages - pass
  - Required: `test`, `typecheck`, `lint`, `lint:check`, `format`, `format:check`
  - Verified `lint`/`format` are mutating and `lint:check`/`format:check` are read-only.
- `bun run --cwd <scoped package> lint:check` for all 8 scoped packages - pass
- `bun run --cwd <scoped package> format:check` for all 8 scoped packages - pass
- `bunx @biomejs/biome check turbo.json ...scoped package.json files... plugins/plugin-health/tsconfig.json` - pass
- `NODE_OPTIONS='--max-old-space-size=8192' node packages/scripts/run-turbo.mjs run typecheck --filter=@elizaos/plugin-personal-assistant --filter=@elizaos/plugin-health --filter=@elizaos/plugin-computeruse --filter=@elizaos/plugin-coding-tools --filter=@elizaos/plugin-shell --filter=@elizaos/plugin-training --filter=@elizaos/plugin-browser --filter=@elizaos/plugin-wallet --concurrency=2` - pass, 87 tasks successful
- `bun run --cwd plugins/plugin-health typecheck` - pass
- `bun run --cwd plugins/plugin-wallet typecheck` - pass
- `bun run --cwd plugins/plugin-wallet test src/wallet/local-eoa-backend.test.ts` - pass, 1 file / 4 tests
- `bun run --cwd plugins/plugin-personal-assistant test test/default-packs.smoke.test.ts test/workflow-step-registry.test.ts test/conflict-detect-action.test.ts` - pass, 3 files / 30 tests
- `node packages/scripts/ensure-plugin-test-conventions.mjs --check` - pass
- `git diff --check` - pass
- `bun run verify` - attempted post-rebase; fails on current `develop`'s
  existing `@elizaos/plugin-computeruse#lint` backlog (`noNonNullAssertion`
  diagnostics in computeruse tests/source). After duplicate-key cleanup, this
  branch has no diff against `origin/develop` for `plugins/plugin-computeruse/package.json`.

## Evidence N/A

- UI screenshots/video: N/A - package script, formatting, tsconfig, and Turbo dependency changes only.
- Frontend console/network logs: N/A - no UI runtime path changed.
- Real LLM trajectories: N/A - no agent prompt/action/provider/model behavior changed.
- Backend logs: N/A - no server runtime path changed.
