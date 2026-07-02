# Issue #11371 - Mobile local-inference model path re-anchor

Date: 2026-07-02
Branch: `fix/11371-mobile-model-path-reanchor`

## What Changed

- `packages/ui/src/services/local-inference/registry.ts` now separates the
  raw on-disk registry shape from the public `InstalledModel` API shape.
- New registry writes store Eliza-owned `path`, `bundleRoot`, and
  `manifestPath` relative to `localInferenceRoot()`, so new mobile installs do
  not persist absolute iOS container UUIDs.
- Legacy absolute paths are still accepted. If a legacy path contains a
  `local-inference/...` suffix from a previous iOS app container, the registry
  re-anchors that suffix under the current state root before returning the
  model to the loader.
- Malformed relative paths that escape the current local-inference root are
  dropped at the registry-read boundary.

## Verification

```bash
ELIZA_SKIP_ARTIFACT_SYNC=1 bun run install:light
node packages/shared/scripts/generate-keywords.mjs --target ts
bun run --cwd packages/contracts build
```

Result: dependency setup and generated declarations available in the fresh
worktree.

```bash
bunx @biomejs/biome check \
  packages/ui/src/services/local-inference/registry.ts \
  packages/ui/src/services/local-inference/registry.test.ts
```

Result: passed.

```bash
bunx vitest run \
  packages/ui/src/services/local-inference/registry.test.ts \
  packages/ui/src/services/local-inference/active-model.test.ts
```

Result: 2 files passed, 21 tests passed.

The new regression coverage includes:

- fresh writes persist root-relative registry paths;
- legacy absolute paths from an old simulated iOS container root resolve to the
  current state root while preserving the model/bundle/manifest suffix.

```bash
bun run --cwd packages/ui typecheck
```

Result: passed after building `packages/contracts`.

```bash
bun run verify
```

Result: failed before this branch's change paths in the existing
`audit:type-safety-ratchet` baseline:

- `as unknown as`: 80 current > 77 baseline
- ``?? {}`` in core/agent/app-core: 379 current > 377 baseline

## N/A

- Real iOS reinstall video: N/A - the PR adds deterministic regression coverage
  for the root cause by simulating old and current app container roots.
- App visual audit/screenshots: N/A - no rendered UI, layout, or styling path
  changed.
- Real-LLM trajectories: N/A - no model prompt, provider, action, evaluator, or
  generation behavior changed.
- Backend/domain artifacts: N/A - local registry path serialization only; no
  server state, database rows, or external services changed.
