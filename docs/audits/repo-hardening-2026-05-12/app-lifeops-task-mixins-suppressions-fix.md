# App LifeOps Task Mixins Suppressions Fix

Date: 2026-05-12

## Changed paths

- `plugins/app-lifeops/src/lifeops/service-mixin-workflows.ts`
- `plugins/app-lifeops/src/lifeops/service-mixin-scheduling.ts`
- `plugins/app-lifeops/src/lifeops/service-mixin-reminders.ts`
- `plugins/app-lifeops/src/lifeops/service-mixin-goals.ts`
- `plugins/app-lifeops/src/lifeops/service-mixin-relationships.ts`
- `plugins/app-lifeops/src/lifeops/service-mixin-inbox.ts`
- `docs/audits/repo-hardening-2026-05-12/app-lifeops-task-mixins-suppressions-fix.md`

## Suppressions

- Removed: six file-level `// @ts-nocheck` suppressions, one from each owned mixin.
- Kept in owned files: none found by `rg -n "@ts-nocheck|@ts-ignore|@ts-expect-error" plugins/app-lifeops/src/lifeops/service-mixin-{workflows,scheduling,reminders,goals,relationships,inbox}.ts`.
- Added: no `@ts-ignore`, no `@ts-expect-error`.

## Validation

- `tsc --noEmit -p plugins/app-lifeops/tsconfig.build.json`: not runnable from PATH in this shell (`tsc: command not found`).
- `bunx tsc --noEmit -p plugins/app-lifeops/tsconfig.build.json`: not runnable from PATH in this shell (`bunx: command not found`).
- `./node_modules/.bin/tsc --noEmit -p plugins/app-lifeops/tsconfig.build.json`: ran and failed with type errors.

The failing typecheck included unrelated pre-existing errors in unowned LifeOps mixins (`service-mixin-browser.ts`, `service-mixin-discord.ts`, `service-mixin-google.ts`, `service-mixin-health.ts`, `service-mixin-payments.ts`, `service-mixin-screentime.ts`, `service-mixin-subscriptions.ts`, `service-mixin-travel.ts`, `service-mixin-whatsapp.ts`, `service-mixin-x.ts`, `service-mixin-x-read.ts`). I did not edit those files.

## Owned blockers exposed

- `service-mixin-workflows.ts`: needs a narrow dependency surface for `readEffectiveScheduleState` and `emitWorkflowRunNudge`; also needs event typing split between health-derived events and Gmail workflow events.
- `service-mixin-scheduling.ts`: needs a narrow base dependency interface for connector dispatch methods (`sendGmailMessage`, `sendTelegramMessage`, `sendWhatsAppMessage`, `sendIMessage`).
- `service-mixin-reminders.ts`: still has real contract errors for owner-contact config context, activity-signal normalizers returning broad `string`, meal-label normalization, reminder review classifier source typing, reverse dependency calls to later mixins (`snoozeOccurrence`, workflow runners, check-in sources), and custom runtime event payload typing.
- `service-mixin-goals.ts`: needs a narrow dependency surface for reminder/definition helpers (`getGoalRecord`, `listActivitySignals`, `getDefinitionRecord`, `inspectReminder`, `refreshEffectiveScheduleState`, `refreshDefinitionOccurrences`, `buildReminderPreferenceResponse`, `resolveEffectiveReminderPlan`).
- `service-mixin-inbox.ts`: needs a narrow base dependency interface for Gmail and X DM inbox sources passed to `fetchAllMessages`.
- `service-mixin-relationships.ts`: no owned type errors were observed in the failed focused typecheck after suppressions were removed.

## Status

Stopped per user request before type fixes were applied. The six owned `@ts-nocheck` suppressions are removed, but `app-lifeops` focused typecheck is currently failing and the source mixins still need the type fixes listed above before this cleanup is complete.
