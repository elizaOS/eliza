# #10680 App Auth Suspense Fallback

## What changed

- `packages/ui/src/cloud/shell/StewardProvider.tsx` now uses `fallback={null}` while the lazy `StewardAuthRuntimeProvider` chunk loads.
- `packages/ui/src/cloud/shell/StewardProvider.test.tsx` now asserts that `/app-auth/authorize` does not render protected children during the Suspense fallback, then renders them after the Steward runtime provider is mounted.

This prevents the cold-navigation race where `AuthorizeContent` could call `useAuth()` before an ancestor `<StewardProvider>` existed.

## Validation

All validation below was run after rebasing onto `origin/develop` at `40fc8227c30` and running `bun install --frozen-lockfile --ignore-scripts` with no lock/install changes.

- `bun run --cwd packages/ui test src/cloud/shell/StewardProvider.test.tsx src/cloud/public-pages/pages/app-auth/app-authorize-page.test.tsx`
  - Passed: 2 files, 4 tests.
- `bunx @biomejs/biome@2.5.1 check packages/ui/src/cloud/shell/StewardProvider.tsx packages/ui/src/cloud/shell/StewardProvider.test.tsx`
  - Passed: 2 files checked, no fixes applied.
- `git diff --check`
  - Passed.
- `bun run build:core`
  - Passed: 64 successful tasks, including `@elizaos/ui` build and runtime export verification.
- `bun run --cwd packages/ui typecheck`
  - Passed.
- `bun run verify`
  - Blocked before typecheck/lint by the existing repository-wide type-safety ratchet baseline: `as unknown as` is 108 current vs 77 baseline. The listed files are outside this PR's touched files, including feed packages, `packages/agent`, `packages/app-core`, `packages/cloud/services/gateway-discord`, and `plugins/plugin-capacitor-bridge`.

## Visual Evidence

- Screenshot: N/A. This fix intentionally renders no transient fallback UI while the auth provider chunk loads; the post-load app-auth page pixels are unchanged.
- Screen recording: N/A for the same reason. The user-visible failure was a provider timing crash, and the regression test directly captures the previously crashing phase by asserting children are absent until the Steward runtime provider mounts.
