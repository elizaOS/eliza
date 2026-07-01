# @elizaos/plugin-inbox

Unified cross-channel inbox triage with unresolved-item tracking, snooze, archive, and follow-up watcher. Drives the inbox-zero workflow.

## Scope

Aggregates threads across email, Discord, Telegram, WhatsApp, Slack, X, Farcaster, iMessage, and similar connected channels into one triage queue.

**Out of scope:** Android SMS — that remains in `@elizaos/plugin-messages`.

## Plugin surface

### Action

`INBOX` — op-based dispatch. Ops: `list`, `search`, `summarize`, `triage`, `reply`, `snooze`, `archive`, `approve`.

- `list` — fan-out fetch across all connected platform adapters (gmail, discord, telegram, signal, imessage, whatsapp), dedupe by message id and thread topic, return merged feed ordered by recency.
- `search` — search across selected platforms by `query`.
- `summarize` — return a per-platform count plus a single rolled-up summary.
- `triage` — list persisted unresolved triage queue entries, optionally filtered by classification.
- `reply` — draft a connector-backed response, then send after explicit confirmation.
- `snooze` — hide a triage entry until an ISO timestamp.
- `archive` — archive through the connector adapter and resolve on success.
- `approve` — send the stored draft or suggested response.

Fetchers are injectable via `setInboxFetchers` for tests. Owner-only.

### Providers

- `inboxTriage` (position `14`) — injects the user's pending triage queue (urgent, needs_reply, recent auto-replies) into owner context from the `InboxRepository`.
- `crossChannelContext` (position `-3`) — injects recent triage entries from the current message sender across other channels (resolved by entityId then senderName). Owner-only, silently empty when no cross-channel history exists.

### Service

`InboxService` (`src/inbox/service.ts`) — `triage()`, `curate()`, `triageWithCuration()`, `search()`, `list()`, `digest()`, `resolve()`, `snooze()`. No dependency on `@elizaos/plugin-personal-assistant`.

### Routes

- `GET /api/lifeops/inbox/triage` — list unresolved entries.
- `POST /api/lifeops/inbox/triage` — classify/persist inbound messages.
- `POST /api/lifeops/inbox/:id/reply` — draft or send a reply.
- `POST /api/lifeops/inbox/:id/snooze` — set `snoozed_until`.
- `POST /api/lifeops/inbox/:id/archive` — archive and resolve on connector success.
- `POST /api/lifeops/inbox/:id/approve` — send the stored draft/suggested response.

### Schema

`pgSchema('app_inbox')` with three tables:

- `life_inbox_triage_entries` — per-thread triage decisions, draft replies, snooze timestamps, and resolution state.
- `life_inbox_triage_examples` — owner-labeled few-shot examples for triage classification.
- `life_email_unsubscribes` — unsubscribe attempts and outcomes.

### View

`/inbox` — `InboxView` component for the cross-channel inbox surface.

## Layout

```
src/
  index.ts                            Public API barrel
  plugin.ts                           inboxPlugin Plugin object
  types.ts                            TriageDecision, ThreadSummary, channel + decision enums
  actions/
    inbox.ts                          INBOX umbrella action (fan-out + triage queue ops)
  routes/
    inbox-routes.ts                   Triage read/write + reply/snooze/archive/approve routes
  providers/
    inbox-triage.ts                   inboxTriage provider — pending triage queue (position 14)
    cross-channel-context.ts          crossChannelContext provider — sender cross-channel history (position -3)
  inbox/
    service.ts                        InboxService — triage/curate/search/list/digest/resolve/snooze
    repository.ts                     InboxRepository — raw SQL over app_inbox.life_inbox_triage_*
    types.ts                          InboundMessage, TriageEntry, TriageClassification, etc.
    triage-classifier.ts              LLM classification of inbound messages
    email-curation.ts                 Email curation engine (save/archive/delete decisions)
    config.ts                         loadInboxTriageConfig()
    message-fetcher.ts                Per-platform message fetchers
    channel-deep-links.ts             Channel deep-link helpers
    reflection.ts                     Inbox reflection utilities
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

None. Channel credentials are read from each provider plugin (`plugin-discord`, `plugin-telegram`, etc.).

## Conventions / gotchas

- **`GET /api/lifeops/inbox` lives in `plugin-personal-assistant`.** The `InboxView` fetches from this route (served by PA). The triage domain (classify/persist/search) lives here and is imported by PA.
- **`@elizaos/plugin-sql` must be loaded first.** The schema registration relies on `runtime.db`.
- **No Android SMS.** SMS routing intentionally stays in `plugin-messages`. Do not add SMS channel handling here.
- **Schema name is `app_inbox`** to avoid collision with any host-app `inbox` table the runtime might also surface.
- **Snooze is additive.** `snoozed_until` is added to `life_inbox_triage_entries`; the migration repairs old targets and maps legacy `app_lifeops` rows with `NULL AS snoozed_until`.
- **Two build steps.** The JS/types build (tsup + tsc) and the Vite views build are separate. Both must be run for a complete build.
- See the root `AGENTS.md` for repo-wide architecture rules, logger requirements, ESM/module standards, and the cloud-frontend visual-review gate (if any of this plugin's UI ends up in `cloud-frontend`).
