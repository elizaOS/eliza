# app-lifeops typecheck cleanup (W4-J, 2026-05-11)

## Summary

The W4-J brief listed ~51 pre-existing typecheck errors in
`plugins/app-lifeops/src/` (readonly tuple mismatch in `owner-surfaces.ts`,
missing `State` imports in `health.ts` / `screen-time.ts`, missing `bun:ffi`
in the two Apple connectors, and a stale `websiteBlockAction` re-export in
`website-blocker/public.ts`).

When W4-J (retry) checked out `develop` and ran `bunx tsc --noEmit -p
tsconfig.build.json`, the typecheck exited **0 errors**. Every category in
the brief had already been fixed by intervening commits on `develop`. The
work was a no-op; this doc records the verification and the commits that
landed the fixes.

## Verification

```text
$ cd plugins/app-lifeops
$ rm -f tsconfig.owned-mixins.tmp.tsbuildinfo
$ bunx tsc --noEmit -p tsconfig.build.json ; echo "exit: $?"
exit: 0
```

Also exercised with a /tmp tsconfig that includes the source tree directly
(no `exclude`) against the shared `tsconfig.build.shared.json` paths — also
0 errors.

Scoped test suite:

```text
$ bun x vitest run --config vitest.config.ts
 Test Files  56 passed (56)
      Tests  546 passed | 1 skipped (547)
```

No regressions.

## Per-category status

| Brief item | File | Status | Where it was fixed |
| ---------- | ---- | ------ | ------------------ |
| TS2304 `Cannot find name 'State'` | `src/actions/health.ts` | already imported (line 21, inside the `@elizaos/core` `import type {...}` block) | predates W4-J |
| TS2304 `Cannot find name 'State'` | `src/actions/screen-time.ts` | already imported (line 21) | predates W4-J |
| TS2792/TS2307 `Cannot find module 'bun:ffi'` | `src/lifeops/apple-calendar.ts` | `/// <reference types="bun-types" />` on line 1; dynamic `await import("bun:ffi")` on line 151 | predates W4-J |
| TS2792/TS2307 `Cannot find module 'bun:ffi'` | `src/lifeops/apple-reminders.ts` | `/// <reference types="bun-types" />` on line 1; dynamic `await import("bun:ffi")` on line 155 | predates W4-J |
| TS2322 readonly `LIFE_TAGS` | `src/actions/owner-surfaces.ts:158` | line 158 is now `description: args.description,`; the `LIFE_TAGS` assignment in this builder typechecks against the `Action` shape on current `develop` | predates W4-J |
| TS2305 missing `websiteBlockAction` export | `src/website-blocker/public.ts:6` | `export { blockAction as websiteBlockAction } from "../actions/block.js";` (line 9) — fixed in `e7c3136a91` ("chore(lifeops): fix dangling websiteBlockAction re-export") | predates W4-J |

## Remaining errors

None in `plugins/app-lifeops/src/` against `tsconfig.build.json`.

## Followups (Wave 5)

- The plugin still has no `typecheck` script in `package.json`, so the
  workspace-level `bun run typecheck` (turbo) skips it entirely. The
  in-package `verify` script uses `tsc --noCheck -p tsconfig.build.json`
  which intentionally does not surface diagnostics. Consider adding
  `"typecheck": "tsc --noEmit -p tsconfig.build.json"` so regressions in
  this package gate the workspace check.
- The two Apple FFI files keep `/// <reference types="bun-types" />` as a
  triple-slash directive instead of pulling `bun-types` in via tsconfig
  `types`. Either form works; tsconfig-level inclusion would let the
  directive be dropped if other files in the package also start using
  `bun:ffi` / `Bun` globals.
