# App LifeOps Context Mixins Suppressions Fix

Date: 2026-05-12

## Changed paths

- `plugins/app-lifeops/src/lifeops/service-mixin-browser.ts`
- `plugins/app-lifeops/src/lifeops/service-mixin-health.ts`
- `plugins/app-lifeops/src/lifeops/service-mixin-payments.ts`
- `plugins/app-lifeops/src/lifeops/service-mixin-screentime.ts`
- `plugins/app-lifeops/src/lifeops/service-mixin-sleep.ts`
- `plugins/app-lifeops/src/lifeops/service-mixin-subscriptions.ts`
- `plugins/app-lifeops/src/lifeops/service-mixin-travel.ts`
- `docs/audits/repo-hardening-2026-05-12/app-lifeops-context-mixins-suppressions-fix.md`

## Suppressions

- Removed file-level `@ts-nocheck` from all seven assigned LifeOps mixins.
- Kept no `@ts-nocheck`, `@ts-ignore`, or `@ts-expect-error` in the assigned mixins.

## Type fixes

- Added precise mixin dependency surfaces for cross-mixin calls:
  - browser -> `recordScreenTimeEvent`
  - screentime -> browser settings/companion status
  - travel -> calendar event creation
- Kept health as a public mixin surface and fixed its return cast through `unknown`.
- Added concrete payment client cache fields instead of relying on unchecked dynamic properties.
- Replaced payment metadata casts with structural guards for Plaid/PayPal metadata loaded from storage.
- Replaced the subscription computer-use service cast with a structural guard before invoking browser automation.
- Tightened browser companion auth narrowing and browser-kind normalization.

## Validation

- `bunx tsc --noEmit -p plugins/app-lifeops/tsconfig.build.json`
  - Result: not run; `bunx` is not available on PATH in this shell.
- `node_modules/.bin/tsc --noEmit -p plugins/app-lifeops/tsconfig.build.json`
  - Result: failed on existing unrelated app-lifeops type errors.
  - Relevant result: after the fix pass, the compiler reported no errors in the seven assigned mixins.
- `rg -n "@ts-nocheck|@ts-ignore|@ts-expect-error" plugins/app-lifeops/src/lifeops/service-mixin-{health,sleep,screentime,subscriptions,payments,travel,browser}.ts`
  - Result: no matches.

## Remaining blockers

The app-lifeops no-emit typecheck is still blocked by unrelated files outside this assignment, including:

- `service-mixin-discord.ts`: missing plugin-discord named exports and missing browser mixin dependency types.
- `service-mixin-goals.ts`: unresolved sibling mixin dependencies and mixin return cast issues.
- `service-mixin-google.ts`: connector account/degradation type mismatches and mixin return cast issue.
- `service-mixin-inbox.ts`: missing Gmail/X source dependencies on `this`.
- `service-mixin-reminders.ts`: multiple missing imports/types, literal widening issues, and sibling mixin dependencies.
- `service-mixin-scheduling.ts`: missing outbound channel method dependencies.
- `service-mixin-whatsapp.ts`: missing `Memory` type.
- `service-mixin-workflows.ts`: event payload narrowing and sibling mixin dependencies.
- `service-mixin-x.ts` and `service-mixin-x-read.ts`: connector literal/dependency typing issues.
