# #14237 Surface Realm Forward Fix Evidence

Branch: `fix/14237-surface-realm-forward`

Base verified after rebase: `origin/develop` at `6c1b2debbb` (`feat(ui): chat history — infinite scroll, search, reachable clear in overlay (#14300)`)

## Focused Verification

- `bunx @biomejs/biome check packages/ui/src/components/views/DynamicViewLoader.tsx packages/ui/src/components/views/DynamicViewLoader.root-ui-broker.test.tsx packages/ui/src/surface-realm-broker.ts packages/ui/src/surface-realm-broker.test.tsx`
  - Result: pass.
- `BUN_OPTIONS=--conditions=eliza-source bun run --cwd packages/ui test -- src/surface-realm-broker.test.tsx -t 'resetHostRealm'`
  - Result: pass, 8 tests passed / 8 skipped.
- `BUN_OPTIONS=--conditions=eliza-source bun run --cwd packages/ui test -- src/components/views/DynamicViewLoader.root-ui-broker.test.tsx -t 'cached broker helpers'`
  - Result: pass, 1 test passed / 3 skipped.
- `git diff --check origin/develop...HEAD`
  - Result: pass.

## Local Harness Notes

The sparse local review worktree needed local-only `node_modules` stubs for optional UI barrel dependencies that are not installed in this checkout (`@pixiv/three-vrm`, `three`, `webxr-polyfill`, `motion/react`, `@stwd/react`, `react-router-dom`, `react-day-picker`) plus workspace symlinks and generated keyword data. These stubs were not committed.

## Evidence Still Required Before Merge

- `bun run --cwd packages/app audit:app`
- Manual review verdicts for touched/reachable app views.
- Desktop/mobile screenshots and video walkthrough, or explicit N/A rows where appropriate.
- Frontend console/network logs if a rendered app audit is captured.

## App Audit Attempt

Attempted `bun run --cwd packages/app audit:app` in the sparse forward-fix worktree after adding `packages/app` and its immediate workspace build dependencies.

- First attempt failed before rendering because Turbo could not find `@elizaos/contracts` in the sparse checkout.
- After adding `packages/contracts`, the build failed because the local test-stub `node_modules` shadowed real dependencies and `@types/node` could not resolve for `@elizaos/logger`.
- After switching the worktree to the parent checkout's full `node_modules`, the build progressed through `@elizaos/logger`, `@elizaos/contracts`, and `@elizaos/cloud-routing`, then failed while generating `@elizaos/core` declarations due workspace/package resolution gaps in the sparse setup (`@elizaos/cloud-routing`, `@elizaos/prompts`, and `file-type` not resolving correctly from this worktree).

No rendered screenshots/manual-review artifacts were produced from this environment.
