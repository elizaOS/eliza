# app-lifeops connector mixins suppressions fix

Date: 2026-05-12

## Scope

Owned slice:

- `plugins/app-lifeops/src/lifeops/service-mixin-calendar.ts`
- `plugins/app-lifeops/src/lifeops/service-mixin-drive.ts`
- `plugins/app-lifeops/src/lifeops/service-mixin-gmail.ts`
- `plugins/app-lifeops/src/lifeops/service-mixin-email-unsubscribe.ts`

No `ScheduledTask` contracts, scheduled-task runner behavior, default-pack
content, or plugin-health boundaries were changed.

## Suppressions removed

- Removed whole-file `@ts-nocheck` from `service-mixin-calendar.ts`.
  - Added a narrow `CalendarMixinDependencies` surface for Google connector
    account and grant helpers supplied by `withGoogle`.
  - Added typed Google connector grant narrowing before calendar-list mapping.
  - Typed Apple Calendar feature-result failure handling.
  - Fixed hidden type mismatches by calling `resolveCalendarEventRange` with
    its actual signature and by not passing ignored `grantId` fields into
    calendar sync-state creation.
- Removed whole-file `@ts-nocheck` from `service-mixin-drive.ts`.
  - Added the public `LifeOpsDriveService` mixin surface.
  - Added a narrow dependency on `getGoogleConnectorStatus`.
  - Typed Drive scope checks against `LifeOpsConnectorGrant`.
- Removed whole-file `@ts-nocheck` from `service-mixin-gmail.ts`.
  - Added a narrow `GmailMixinDependencies` surface for Gmail grant helpers.
  - Typed synced Gmail grant flow as `LifeOpsConnectorGrant`.
  - Preserved the existing extra runtime `messages` field on Gmail
    recommendations with an explicit intersection type.
- Removed whole-file `@ts-nocheck` from
  `service-mixin-email-unsubscribe.ts`.
  - Added the public `LifeOpsEmailUnsubscribeService` mixin surface.
  - Added narrow dependencies on Gmail search and Gmail grant helpers.

## Suppressions kept

None in this owned slice.

`rg -n "@ts-nocheck|@ts-ignore|@ts-expect-error"` over the four owned mixin
files returns no matches.

## Validation

- `./node_modules/.bin/tsc -p plugins/app-lifeops/tsconfig.build.json --noEmit`:
  pass.
- `./node_modules/.bin/tsc --noCheck -p plugins/app-lifeops/tsconfig.build.json`:
  pass. This is the direct equivalent of `plugins/app-lifeops` `build:types`
  because `bun` is not available on this PATH.
- `node plugins/app-lifeops/scripts/lint-default-packs.mjs`: pass,
  `[lint-default-packs] clean — 0 findings across default packs.`
- `rg -n "@ts-nocheck|@ts-ignore|@ts-expect-error" ...owned mixins`: pass,
  no matches.

## Remaining blockers

- Exact `bun run --cwd plugins/app-lifeops build:types` and `bunx ...` commands
  could not be executed in this shell because `bun`/`bunx` are not on PATH.
  The underlying `tsc` commands were run directly and passed.
- No focused runtime tests were necessary for this slice; the changes are type
  surfaces and helper typing, with no changes to ScheduledTask behavior or
  connector dispatch semantics.
