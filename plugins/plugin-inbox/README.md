# @elizaos/plugin-inbox

Unified cross-channel inbox triage with unresolved-item tracking, snooze, archive, and follow-up watcher. Drives the inbox-zero workflow.

## Scope

Aggregates threads across email, Discord, Telegram, WhatsApp, Slack, X, Farcaster, iMessage, and similar connected channels into one triage queue.

**Out of scope:** Android SMS — that remains in `@elizaos/plugin-messages`.

## Migration mapping from `plugin-lifeops`

This plugin is being extracted out of the monolithic `plugin-lifeops`. The current scaffold is a stub: every action handler, provider body, and repository call returns or references its eventual source. The next pass will physically move the implementation files. The mapping is:

| New (plugin-inbox)                                  | Source (plugin-lifeops)                                       |
| --------------------------------------------------- | ------------------------------------------------------------- |
| `src/actions/inbox.ts`                              | `plugins/plugin-lifeops/src/actions/inbox.ts`                 |
| `src/providers/inbox-triage.ts`                     | `plugins/plugin-lifeops/src/providers/inbox-triage.ts`        |
| `src/providers/cross-channel-context.ts`            | `plugins/plugin-lifeops/src/providers/cross-channel-context.ts` |
| `src/db/schema.ts` (`app_inbox.triage_decisions`)   | `plugins/plugin-lifeops/src/inbox/repository.ts`              |
| `src/db/schema.ts` (`app_inbox.snoozed`)            | `plugins/plugin-lifeops/src/inbox/repository.ts`              |
| `src/db/schema.ts` (`app_inbox.archived`)           | `plugins/plugin-lifeops/src/inbox/repository.ts`              |
| (planned) `src/inbox/triage-classifier.ts`          | `plugins/plugin-lifeops/src/inbox/triage-classifier.ts`       |
| (planned) `src/inbox/message-fetcher.ts`            | `plugins/plugin-lifeops/src/inbox/message-fetcher.ts`         |
| (planned) `src/inbox/channel-deep-links.ts`         | `plugins/plugin-lifeops/src/inbox/channel-deep-links.ts`      |
| (planned) `src/inbox/reflection.ts`                 | `plugins/plugin-lifeops/src/inbox/reflection.ts`              |
| `src/components/inbox/InboxView.tsx`                | (new — replaces inbox UI living inside the lifeops view bundle) |

## Plugin surface

### Action

`INBOX` — op-based dispatch. Ops: `list`, `triage`, `reply`, `snooze`, `archive`, `approve`. All ops currently return `not_implemented`; the handler bodies are TODOs pointing at the lifeops source they will absorb.

### Providers

- `INBOX_TRIAGE` — injects the user's pending triage queue into the planner.
- `CROSS_CHANNEL_CONTEXT` — surfaces recent activity for the current counterparty across other channels.

### Schema

`pgSchema('app_inbox')` with three tables:

- `triage_decisions` — history of decisions per (thread, decision-event).
- `snoozed` — threads to re-surface at `wake_at`.
- `archived` — threads explicitly removed from the active inbox.

### View

`/inbox` — `InboxView` component. Minimal placeholder UI (header, channel filter chips, empty thread list) until the full triage drawer / snooze picker / approval queue lands.

## Layout

```
src/
  index.ts                            Public API barrel
  plugin.ts                           inboxPlugin Plugin object
  types.ts                            TriageDecision, ThreadSummary, channel enums
  actions/
    inbox.ts                          INBOX umbrella action (op dispatch — stub)
  providers/
    inbox-triage.ts                   INBOX_TRIAGE provider (stub)
    cross-channel-context.ts          CROSS_CHANNEL_CONTEXT provider (stub)
  db/
    index.ts                          re-exports schema.ts
    schema.ts                         drizzle pgSchema('app_inbox') + tables
  components/
    inbox/
      InboxView.tsx                   Minimal React inbox view
      inbox-view-bundle.ts            Vite bundle entry — re-exports InboxView
```

## Commands

```bash
bun run --cwd plugins/plugin-inbox typecheck    # tsc --noEmit
bun run --cwd plugins/plugin-inbox lint         # biome check src/
bun run --cwd plugins/plugin-inbox test         # vitest run
bun run --cwd plugins/plugin-inbox build        # build:js + build:views + build:types
bun run --cwd plugins/plugin-inbox build:js     # tsup
bun run --cwd plugins/plugin-inbox build:views  # vite build (overlay bundle)
bun run --cwd plugins/plugin-inbox build:types  # tsc declaration emit
bun run --cwd plugins/plugin-inbox clean        # rm -rf dist
```

## Config / env vars

None at the scaffold stage. Channel credentials are read from each provider plugin (`plugin-discord`, `plugin-telegram`, etc.).

## Conventions / gotchas

- **Not yet feature-complete.** Every action op currently returns a `not_implemented` failure with the source path it should pull from. Treat this package as the registration shell; the live triage logic still runs out of `plugin-lifeops` until the follow-up migration pass.
- **No Android SMS.** SMS routing intentionally stays in `plugin-messages`. Do not add SMS handling here.
- **Schema name is `app_inbox`** to avoid collision with any host-app `inbox` table the runtime might also surface.
- See the root `AGENTS.md` for repo-wide architecture rules, logger requirements, ESM/module standards, and the cloud-frontend visual-review gate (if any of this plugin's UI ends up in `cloud-frontend`).
