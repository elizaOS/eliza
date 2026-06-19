# @elizaos/plugin-inbox

Unified cross-channel inbox triage with unresolved-item tracking, snooze, archive, and follow-up watcher. Drives the inbox-zero workflow.

## Scope

Aggregates threads across email, Discord, Telegram, WhatsApp, Slack, X, Farcaster, iMessage, and similar connected channels into one triage queue.

**Out of scope:** Android SMS — that remains in `@elizaos/plugin-messages`.

## Plugin surface

### Action

`INBOX` — op-based dispatch. Ops: `list`, `search`, `summarize`.

- `list` — fan-out fetch across all connected platform adapters (gmail, discord, telegram, signal, imessage, whatsapp), dedupe by message id and thread topic, return merged feed ordered by recency.
- `search` — search across selected platforms by `query`.
- `summarize` — return a per-platform count plus a single rolled-up summary.

Fetchers are injectable via `setInboxFetchers` for tests. Owner-only.

### Providers

- `inboxTriage` (position `14`) — injects the user's pending triage queue (urgent, needs_reply, recent auto-replies) into owner context from the `InboxRepository`.
- `crossChannelContext` (position `-3`) — injects recent triage entries from the current message sender across other channels (resolved by entityId then senderName). Owner-only, silently empty when no cross-channel history exists.

### Service

`InboxService` (`src/inbox/service.ts`) — `triage()`, `curate()`, `triageWithCuration()`, `search()`, `list()`, `digest()`, `resolve()`. No dependency on `@elizaos/plugin-personal-assistant`.

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
  types.ts                            TriageDecision, ThreadSummary, channel + decision enums
  actions/
    inbox.ts                          INBOX umbrella action (list/search/summarize fan-out)
  providers/
    inbox-triage.ts                   inboxTriage provider — pending triage queue (position 14)
    cross-channel-context.ts          crossChannelContext provider — sender cross-channel history (position -3)
  inbox/
    service.ts                        InboxService — triage/curate/search/list/digest/resolve
    repository.ts                     InboxRepository — raw SQL over app_lifeops.life_inbox_triage_*
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
- **Two build steps.** The JS/types build (tsup + tsc) and the Vite views build are separate. Both must be run for a complete build.
- See the root `AGENTS.md` for repo-wide architecture rules, logger requirements, ESM/module standards, and the cloud-frontend visual-review gate (if any of this plugin's UI ends up in `cloud-frontend`).
