# @elizaos/plugin-inbox

Unified cross-channel inbox triage with unresolved-item tracking, snooze, archive, and follow-up watcher for Eliza agents.

## Purpose / role

Adds the inbox-zero workflow to an agent: a single `INBOX` umbrella action (op-based dispatch), `INBOX_TRIAGE` + `CROSS_CHANNEL_CONTEXT` providers that surface unresolved threads to the planner each turn, and a registered `/inbox` view for human review. Aggregates threads across email, Discord, Telegram, WhatsApp, Slack, X, Farcaster, iMessage, and similar non-SMS channels. Android SMS stays in `@elizaos/plugin-messages`.

The extraction from `plugin-personal-assistant` is complete. The action, service, and providers are fully implemented. The cross-channel inbox read route (`GET /api/lifeops/inbox`) remains in `@elizaos/plugin-personal-assistant` (it is coupled to PA's connector sources and LLM priority scoring); the `InboxView` calls that route. The triage domain (classify, persist, search, list, curate) lives here and is imported by PA.

## Plugin surface

### Action

- `INBOX` (`src/actions/inbox.ts`) — umbrella action with op-based dispatch. Ops: `list`, `search`, `summarize`. Fans out to every connected platform fetcher (gmail, discord, telegram, signal, imessage, whatsapp), dedupes by message id and thread topic, orders by recency. Fetchers are injectable via `setInboxFetchers` for tests.

### Providers

- `inboxTriage` (`src/providers/inbox-triage.ts`) — position `14`. Injects pending triage items (urgent, needs_reply, recent auto-replies) into owner context from the `InboxRepository`.
- `crossChannelContext` (`src/providers/cross-channel-context.ts`) — position `-3`. Injects recent triage entries from the current message sender across other channels (resolved by entityId then senderName). Owner-only, silently empty when no cross-channel history exists.

### Service

- `InboxService` (`src/inbox/service.ts`) — `triage()`, `curate()`, `triageWithCuration()`, `search()`, `list()`, `digest()`, `resolve()`. No dependency on `@elizaos/plugin-personal-assistant`.

### Database

The plugin uses raw SQL helpers (`src/db/sql.ts`) rather than a drizzle schema. There is no `pgSchema` registration; tables are queried directly via `executeRawSql` against the runtime's database adapter.

### View

- `inbox` — `InboxView` component, path `/inbox`, bundle at `dist/views/bundle.js`. Minimal placeholder (header, channel filter chips, empty thread list) until the full UI ports over.

## Layout

```
src/
  index.ts                            Public API barrel
  plugin.ts                           inboxPlugin definition (action + providers + view)
  types.ts                            TriageDecision, ThreadSummary, channel + decision enums
  actions/
    inbox.ts                          INBOX umbrella action — list/search/summarize fan-out
  providers/
    inbox-triage.ts                   inboxTriage provider — pending triage queue (position 14)
    cross-channel-context.ts          crossChannelContext provider — sender's cross-channel history (position -3)
  inbox/
    service.ts                        InboxService — triage/curate/search/list/digest/resolve
    repository.ts                     InboxRepository — raw SQL over app_lifeops.life_inbox_triage_*
    types.ts                          InboundMessage, TriageEntry, TriageClassification, etc.
    triage-classifier.ts              LLM classification of inbound messages
    email-curation.ts                 Email curation engine (save/archive/delete decisions)
    email-unsubscribe-types.ts        Types for email unsubscribe flows
    unsubscribe-repository.ts         Persistence for unsubscribe records
    unsubscribe-service.ts            Unsubscribe orchestration service
    gmail-normalize.ts                Gmail message normalizer
    google-gmail-seam.ts              Gmail API integration seam
    message-fetcher.ts                Cross-channel message fetcher abstraction
    channel-deep-links.ts             Deep-link builders per channel
    reflection.ts                     Inbox reflection / self-assessment helpers
    config.ts                         loadInboxTriageConfig()
  db/
    index.ts                          re-exports sql.ts
    sql.ts                            Raw SQL helpers (executeRawSql, encode helpers — no drizzle schema)
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

- **`GET /api/lifeops/inbox` lives in PA.** The `InboxView` fetches from this route (served by `plugin-personal-assistant`). The triage domain (classify/persist/search) lives here; the connector-coupled cross-channel feed builder stays in PA. This is intentional — PA imports from plugin-inbox, not the reverse.
- **`@elizaos/plugin-sql` must be loaded first.** The raw SQL helpers rely on the runtime's `runtime.adapter.db`. The plugin declares this in `dependencies: ["@elizaos/plugin-sql"]`.
- **No Android SMS.** SMS routing intentionally stays in `plugin-messages`. Do not add SMS channel handling here.
- **Raw SQL, not drizzle schema.** The plugin uses `src/db/sql.ts` helpers (`executeRawSql`) instead of a registered drizzle schema. There is no `pgSchema("app_inbox")` — tables are queried directly against the existing database.
- **Two build steps.** The JS/types build (tsup + tsc) and the Vite views build are separate. The views bundle (`dist/views/bundle.js`) is what the view registration's `bundlePath` points to. Both must be run for a complete build.
- **Peer deps.** React 19 and react-dom 19 are peer dependencies. The host app must provide them.
- See the root `AGENTS.md` for repo-wide architecture rules, logger requirements, ESM/module standards, and the cloud-frontend visual-review gate (if any of this plugin's UI ends up in `cloud-frontend`).
