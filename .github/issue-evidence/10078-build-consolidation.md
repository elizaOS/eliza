# Issue #10078 build consolidation evidence

Issue: https://github.com/elizaOS/eliza/issues/10078
Branch: `chore/10078-build-consolidation`
Base synced to: `origin/develop` `8e09d5b709bd50abc107fbe1e7a384dbe80854d1`

## Summary

- Consolidated repeated plugin `build.ts` files onto the shared `plugins/plugin-build.ts` helper.
- Made declaration-emitting builds use `tsc --noCheck` so `tsgo` remains the single type-check surface.
- Removed generic Turbo `^build` dependencies from `typecheck`, `lint`, and `lint:check`; packages that genuinely need built dist artifacts now declare explicit package-level edges.
- Added build/typecheck audit coverage for generic `^build` regressions, declaration emits without `--noCheck`, custom plugin build drift, and no-op typecheck scripts.
- Wired `typecheck:dist` into `verify` with a generated `tsconfig.dist-paths.json` and a small declaration-prep step for packages that publish dist-only type paths.
- Split the Capacitor bridge build so tsup bundles JS and `tsc --emitDeclarationOnly --noCheck` emits declarations through a build-only tsconfig.
- Fixed strict optional-setting wrapper fallout from the shared `resolveSetting` exact optional property type in affected provider plugins.

## Verification

- `git fetch origin && git rebase origin/develop` completed; after the final fetch, `HEAD...origin/develop` was `0 0` and `origin/develop` was `8e09d5b709bd50abc107fbe1e7a384dbe80854d1`.
- `bun install` completed after the rebase: checked 4827 installs across 5052 packages, no changes.
- `bun run verify` passed.
  - Ratchet audit passed: scanned 9930 tracked production source files; `as unknown as` 82/83; non-null assertions 548/565; `?? ""` 627/627; `?? 0` 386/386.
  - Turbo typecheck/lint phase passed: 471 successful, 471 total; 0 cached; 5m33.902s.
  - `audit-build-typecheck` passed.
  - `audit-turbo-build-deps` passed.
  - `audit-tee-secret-leak` passed.
  - `audit-scripts` passed.
  - `typecheck:dist` passed: generated dist path config current at 195 aliases, prepared 1 declaration emit, checked 28 dist-path consumer configs.
- `node packages/scripts/run-turbo.mjs run typecheck --filter=@elizaos/plugin-calendar --concurrency=8` passed after adding the explicit app-manager build edge: 14 successful, 14 total; 25.036s.
- `bun run --cwd packages/cloud/api typecheck` passed.
- `bun run --cwd packages/cloud/api lint` passed.
- `bun run --cwd plugins/plugin-capacitor-bridge build` passed; dist output was inspected for the expected JS/declaration layout.
- `bun run --cwd plugins/plugin-embeddings typecheck` and `lint:check` passed after the exact-optional wrapper fix.
- `bun run --cwd plugins/plugin-edge-tts typecheck`, `plugins/plugin-elevenlabs typecheck`, `plugins/plugin-elizacloud typecheck`, and `plugins/plugin-x typecheck` passed after applying the same wrapper fix.
- `bun run --cwd plugins/plugin-edge-tts lint:check`, `plugins/plugin-elevenlabs lint:check`, `plugins/plugin-elizacloud lint:check`, and `plugins/plugin-x lint:check` passed.
- `git diff --check` passed.

## Evidence N/A

- Live LLM trajectories: N/A. This change only affects build, typecheck, and repository verification tooling; no agent loop, prompt, model, action, evaluator, or provider behavior changed.
- UI screenshots, app audit, and video walkthrough: N/A. No user-facing UI or shared UI component behavior changed.
- Native/mobile/device capture: N/A. The Capacitor bridge change is limited to package build/declaration emission; no native runtime bridge behavior changed.
- Backend/frontend runtime logs: N/A. No server route or client runtime workflow changed.
- Domain artifacts, DB rows, scheduled tasks, wallet/on-chain artifacts, or generated user files: N/A. No runtime data path or migration changed.
