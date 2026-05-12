# App LifeOps Channel Mixins Suppressions Fix

Date: 2026-05-12

## Changed paths

- `plugins/app-lifeops/src/lifeops/service-mixin-imessage.ts`
- `plugins/app-lifeops/src/lifeops/service-mixin-telegram.ts`
- `plugins/app-lifeops/src/lifeops/service-mixin-signal.ts`
- `plugins/app-lifeops/src/lifeops/service-mixin-whatsapp.ts`
- `plugins/app-lifeops/src/lifeops/service-mixin-discord.ts`
- `plugins/app-lifeops/src/lifeops/service-mixin-x.ts`
- `plugins/app-lifeops/src/lifeops/service-mixin-x-read.ts`
- `plugins/app-lifeops/src/lifeops/service-mixin-google.ts`
- `docs/audits/repo-hardening-2026-05-12/app-lifeops-channel-mixins-suppressions-fix.md`

## Suppressions

Removed:

- 8 file-level `// @ts-nocheck` suppressions, one from each owned channel mixin.

Kept:

- No `@ts-nocheck`, `@ts-ignore`, or `@ts-expect-error` suppressions remain in the owned mixin files as of the last local check.

## Validation

Ran:

- `bunx tsc --noEmit -p tsconfig.build.json` from `plugins/app-lifeops`

Result:

- Failed. The first no-suppression typecheck exposed both owned-file errors and unrelated app-lifeops baseline errors in other mixins.

Not run:

- `bun run build:types`
- `bun run build:js`
- focused vitest/lint

Reason:

- The user stopped the turn after the first failing typecheck and requested no further code edits or unrelated full-repo work.

## Remaining blockers

Owned-file blockers surfaced by the failed typecheck:

- `service-mixin-discord.ts`: imports user-account scraper utilities from `@elizaos/plugin-discord` root, but the current package declaration did not expose those members to app-lifeops typecheck.
- `service-mixin-discord.ts`: the mixin needs a narrow base dependency interface for browser methods such as `getBrowserSession`, `getBrowserSettings`, `listBrowserCompanions`, `listBrowserTabs`, `getCurrentBrowserPage`, and `createBrowserSession`.
- `service-mixin-whatsapp.ts`: `Memory` is referenced without an import.
- `service-mixin-google.ts`: Google connector-account status needs typed degradation fields and a mutable metadata array for `ConnectorAccount` compatibility; the mixin return needs the same dependency-aware mixin typing pattern used in nearby app-lifeops mixins.
- `service-mixin-x.ts`: X status literals need normalization to the existing contract unions, `sourceOfTruth` cannot be `"plugin_runtime"`, post response `category` cannot be `"plugin_runtime"`, and `resolvePrimaryChannelPolicy` needs a narrow dependency interface.
- `service-mixin-x-read.ts`: calls to optional `resolveXGrant` need a typed base dependency boundary instead of relying on the unsuppressed class instance type.

Unrelated baseline blockers also appeared in `service-mixin-browser.ts`, `service-mixin-goals.ts`, `service-mixin-health.ts`, `service-mixin-inbox.ts`, `service-mixin-payments.ts`, `service-mixin-reminders.ts`, `service-mixin-scheduling.ts`, `service-mixin-screentime.ts`, `service-mixin-subscriptions.ts`, `service-mixin-travel.ts`, and `service-mixin-workflows.ts`.

## Status

Incomplete. Suppressions were removed from the owned files, but the real type fixes and full validation were not completed before the stop request.
