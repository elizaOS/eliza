# Issue #10416 evidence

## Scope

- `packages/ui/src/cloud/shell/StewardProvider.tsx` now separates "route does
  not need Steward" from "route needs Steward but the Steward URL is invalid".
- `packages/cloud/sdk/src/app-auth.ts` exports `buildAppAuthorizeUrl()` for the
  canonical `/app-auth/authorize` URL.
- `packages/cloud/sdk/README.md` documents the helper and explicitly warns
  against bare `/authorize`.

## Validation

- `bun run --cwd packages/ui test src/cloud/shell/StewardProvider.test.tsx src/cloud/public-pages/pages/app-auth/app-authorize-page.test.tsx`
- `bun test packages/cloud/sdk/src/app-auth.test.ts`
- `bun run --cwd packages/cloud/sdk test`
- `bun run --cwd packages/cloud/sdk typecheck`
- `bun run --cwd packages/cloud/sdk build`
- `bunx @biomejs/biome check packages/ui/src/cloud/shell/StewardProvider.tsx packages/ui/src/cloud/shell/StewardProvider.test.tsx packages/cloud/sdk/src/app-auth.ts packages/cloud/sdk/src/app-auth.test.ts packages/cloud/sdk/src/index.ts packages/cloud/sdk/README.md`

## Known unrelated blockers

- `bun run --cwd packages/ui typecheck` fails on pre-existing unrelated
  workspace type issues and missing generated files under `packages/core` /
  `packages/shared`.
- `bun run --cwd packages/app dev` in a fresh worktree fails before startup
  because `@elizaos/core` package exports are not built.
- Attached physical Android `27051JEGR10034` is connected but locked
  (`NotificationShade`, `mDreamingLockscreen=true`), so Android screenshot and
  recording are N/A for this web auth-route hardening slice.

## Visual capture

No Android visual capture is attached for this issue. The touched route is a web
Cloud app-auth route, and the attached physical Android remained locked during
validation. The UI branch is covered by the focused jsdom/Vitest route tests
listed above.
