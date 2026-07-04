# Issue #13408: iOS local simulator workspace resolution

## Reproduction

Fresh worktree from `origin/develop`:

```bash
git worktree add /tmp/eliza-13408 -b fix/13408-ios-local-sim-workspace-resolution origin/develop
bun install --ignore-scripts
bun run --cwd packages/app build:ios:local:sim
```

Result: failed during `packages/agent` mobile bundle generation with unresolved
workspace imports including:

- `@elizaos/plugin-birdclaw`
- `@elizaos/plugin-commands`
- `@elizaos/plugin-vision`
- `@elizaos/plugin-background-runner`
- `@elizaos/plugin-wallet/diagnostic`
- `@elizaos/cloud-routing`
- `@elizaos/cloud-sdk`

## Change

- Added `packages/agent/scripts/lib/workspace-packages.mjs`.
- The mobile bundle workspace fallback now resolves `@elizaos/*` package roots
  from the monorepo workspace package manifests when the package is not linked
  from the relevant `node_modules` tree.
- The fallback preserves the existing `node_modules` preference, then falls back
  to local `packages/**` and `plugins/**` workspace package roots.

## Verification

```bash
node --test packages/agent/scripts/lib/workspace-packages.test.mjs
```

Result: 3 passed.

```bash
bun run --cwd packages/agent build:ios-bun
```

Result: passed. The previously failing `Bun.build` phase completed and wrote:

- `packages/agent/dist-mobile-ios/agent-bundle.js` — 30,949.6 KB
- `packages/agent/dist-mobile-ios/pglite.wasm` — 9,646.9 KB
- `packages/agent/dist-mobile-ios/initdb.wasm` — 384.7 KB
- `packages/agent/dist-mobile-ios/pglite.data` — 6,086.1 KB
- `packages/agent/dist-mobile-ios/vector.tar.gz` — 43.8 KB
- `packages/agent/dist-mobile-ios/fuzzystrmatch.tar.gz` — 11.1 KB
- `packages/agent/dist-mobile-ios/plugins-manifest.json` — 2.9 KB

```bash
bunx @biomejs/biome check \
  packages/agent/scripts/build-mobile-bundle.mjs \
  packages/agent/scripts/lib/workspace-packages.mjs \
  packages/agent/scripts/lib/workspace-packages.test.mjs \
  --no-errors-on-unmatched
```

Result: passed.

```bash
git diff --check
```

Result: passed.

## Install / verify status

After rebasing on `origin/develop`, `bun install` was attempted. It reached
postinstall artifact sync, but the 971 MiB artifact bundle was downloading at
roughly 0.4-0.5 MiB/s with a 30+ minute ETA and was interrupted at about 27 MiB
downloaded.

The root `bun run verify` was not rerun for this PR. The same current-tree Turbo
cycle shown below blocks the build/typecheck/lint pipeline before this resolver
change is exercised.

## Full simulator build status

After this fix, `bun run --cwd packages/app build:ios:local:sim` no longer fails
in the `packages/agent` mobile bundle resolver. It successfully builds the iOS
agent bundle and then reaches renderer preparation.

The full simulator build is still blocked on separate current-tree build issues:

1. The script's root `dev:prepare` call fails before tasks run because Turbo
   detects the existing build cycle:

```text
@elizaos/plugin-local-inference#build, @elizaos/agent#build
```

2. Manual probing after building `@elizaos/cloud-routing`, `@elizaos/core`, and
   `@elizaos/shared` let `packages/app build:web` start, but the exploratory
   Vite build was interrupted after several minutes in transform. It had moved
   past the earlier missing-dist config errors and emitted dependency warnings
   from `@pixiv/three-vrm` / `three`.

This PR fixes the workspace-resolution failure described in #13408. The
remaining full-simulator build blockers are outside the mobile agent bundle
resolver and overlap the repository-wide Turbo cycle also observed by
`bun run verify`.
