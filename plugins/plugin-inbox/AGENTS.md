# @elizaos/plugin-inbox

Unified cross-channel inbox triage with unresolved-item tracking, snooze, archive, and follow-up watcher for Eliza agents.

## Purpose / role

Adds the inbox-zero workflow to an agent: a single `INBOX` umbrella action (op-based dispatch), `INBOX_TRIAGE` + `CROSS_CHANNEL_CONTEXT` providers that surface unresolved threads to the planner each turn, and a registered `/inbox` view for human review. Aggregates threads across email, Discord, Telegram, WhatsApp, Slack, X, Farcaster, iMessage, and similar non-SMS channels. Android SMS stays in `@elizaos/plugin-messages`.

This package is being extracted from `plugin-lifeops`. The current scaffold is a stub — actions return `not_implemented` and providers return empty results, but every handler has a TODO comment pointing at the file in `plugin-lifeops` it will absorb. See `README.md` for the migration mapping.

## Plugin surface

### Action

- `INBOX` (`src/actions/inbox.ts`) — single umbrella action with op-based dispatch. Accepted ops: `list`, `triage`, `reply`, `snooze`, `archive`, `approve`. Contexts: `inbox`, `messaging`, `communication`. Each op currently returns a `not_implemented` failure with the source path to port from.

### Providers

- `INBOX_TRIAGE` (`src/providers/inbox-triage.ts`) — position `-4`. Will emit the user's pending cross-channel triage queue.
- `CROSS_CHANNEL_CONTEXT` (`src/providers/cross-channel-context.ts`) — position `-3`. Will emit recent activity for the current counterparty across other channels.

### Schema

- `inboxSchema` (`src/db/schema.ts`) — `pgSchema("app_inbox")` with the three
  inbox-triage tables carved out of PA's `app_lifeops` (column shape verbatim):
  - `life_inbox_triage_entries` — per-thread triage decisions + draft replies.
  - `life_inbox_triage_examples` — owner-labeled few-shot classification examples.
  - `life_email_unsubscribes` — email unsubscribe attempts + outcomes.
  Registered via the plugin `schema` field; `InboxMigrationService`
  (`src/inbox/migration.ts`) does the non-destructive `app_lifeops -> app_inbox`
  copy (skip if source missing / target non-empty, never drop the source). PA
  auto-registers this plugin (`ensureLifeOpsInboxPluginRegistered`) so the schema
  exists + the migration runs whenever PA is loaded. The gmail sync/projection
  tables (`life_gmail_*`, `life_inbox_messages`) are NOT part of this domain —
  they stay PA-owned in `app_lifeops`.

### View

- `inbox` — `InboxView` component, path `/inbox`, bundle at `dist/views/bundle.js`. Minimal placeholder (header, channel filter chips, empty thread list) until the full UI ports over.

## Layout

```
src/
  index.ts                            Public API barrel
  plugin.ts                           inboxPlugin definition (action + providers + schema + view)
  types.ts                            TriageDecision, ThreadSummary, channel + decision enums
  actions/
    inbox.ts                          INBOX umbrella action — op dispatch (STUB)
  providers/
    inbox-triage.ts                   INBOX_TRIAGE provider (STUB)
    cross-channel-context.ts          CROSS_CHANNEL_CONTEXT provider (STUB)
  db/
    index.ts                          re-exports schema.ts
    schema.ts                         drizzle pgSchema('app_inbox') + 3 tables
  components/
    inbox/
      InboxView.tsx                   Minimal React inbox view (placeholder)
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

## How to extend

**Port an op from plugin-lifeops:** open the corresponding `case` block in `src/actions/inbox.ts`, follow the TODO comment to the source file in `plugins/plugin-personal-assistant/`, and replace the `not_implemented` failure with the ported logic. Keep the op enum in `src/types.ts` in sync.

**Add a new op:** add the name to `INBOX_ACTIONS` in `src/types.ts`, add a `case` to the `switch` in `src/actions/inbox.ts`, and (if the op needs new parameters) extend the `parameters` array on `inboxAction`.

**Add a provider:** create `src/providers/<name>.ts` exporting a `Provider`, then add it to the `providers` array in `src/plugin.ts`.

**Add a service:** define the class in `src/service.ts`, add it to the `services` array in `src/plugin.ts`, and export it from `src/index.ts` so callers can resolve it via `runtime.getService`.

## Conventions / gotchas

- **Scaffold, not feature-complete.** Every action op currently returns a `not_implemented` failure with the source path it should pull from. Treat this package as the registration shell; the live triage logic still runs out of `plugin-lifeops` until the follow-up migration pass.
- **`@elizaos/plugin-sql` must be loaded first.** The schema registration relies on the runtime's `runtime.db`. The plugin declares this in `dependencies: ["@elizaos/plugin-sql"]`.
- **No Android SMS.** SMS routing intentionally stays in `plugin-messages`. Do not add SMS channel handling here.
- **Schema name is `app_inbox`** (not `inbox`) to avoid collisions with any host-app `inbox` table the runtime might also surface.
- **Two build steps.** The JS/types build (tsup + tsc) and the Vite views build are separate. The views bundle (`dist/views/bundle.js`) is what the view registration's `bundlePath` points to. Both must be run for a complete build.
- **Peer deps.** React 19 and react-dom 19 are peer dependencies. The host app must provide them.
- See the root `AGENTS.md` for repo-wide architecture rules, logger requirements, ESM/module standards, and the cloud-frontend visual-review gate (if any of this plugin's UI ends up in `cloud-frontend`).
