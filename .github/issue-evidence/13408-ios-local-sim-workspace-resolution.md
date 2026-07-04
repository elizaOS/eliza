# Issue #13408 — iOS local simulator mobile bundle workspace resolution

Date: 2026-07-04

## Change

- `packages/agent/scripts/build-mobile-bundle.mjs` now falls back from
  `node_modules/@elizaos/*` to the workspace package tree when resolving
  mobile bundle source imports.
- The fallback scans workspace package roots under `packages/*`,
  `packages/cloud/*`, `packages/native/*`, and `plugins/*` by package name,
  preserving the existing preference for linked `node_modules` packages.
- The viem CJS resolver now rejects the incomplete local `dist/node_modules`
  mirror when it lacks the `_cjs/actions/test` files imported by viem's test
  decorator, and instead selects the complete installed package from
  `node_modules/.bun`.

## Verification

- `bunx vitest run packages/agent/scripts/lib/mobile-workspace-resolution.test.mjs`
  - 1 file / 8 tests passed.
- `node --check packages/agent/scripts/build-mobile-bundle.mjs`
  - Passed.
- `node --check packages/agent/scripts/lib/mobile-workspace-resolution.mjs`
  - Passed.
- `bunx @biomejs/biome check packages/agent/scripts/build-mobile-bundle.mjs packages/agent/scripts/lib/mobile-workspace-resolution.mjs packages/agent/scripts/lib/mobile-workspace-resolution.test.mjs`
  - Passed.
- `git diff --check`
  - Passed.
- `bun run --cwd packages/agent build:ios-bun`
  - Passed.
  - Produced `packages/agent/dist-mobile-ios/agent-bundle.js` plus PGlite
    assets and `plugins-manifest.json`.
  - Bundle output reported `agent-bundle.js` at 32.05 MB.

## Bundle Failure Regression Covered

The new contract test covers workspace lookup for the packages named in the
original failure report and follow-up local bundle run:

- `@elizaos/plugin-birdclaw`
- `@elizaos/plugin-background-runner`
- `@elizaos/plugin-commands`
- `@elizaos/plugin-vision`
- `@elizaos/plugin-wallet`
- `@elizaos/cloud-routing`
- `@elizaos/cloud-sdk`

## Not Captured

- Full `bun run --cwd packages/app build:ios:local:sim` was not run on this
  host because it is Linux (`uname: Linux BEAST ... x86_64`) and has no
  `xcodebuild`/`xcrun` simulator toolchain.
- No simulator app path, install, screenshot, or video is attached here. This
  proves the previously failing agent bundle phase on this host; final
  non-stale simulator evidence still requires an Xcode runner.
