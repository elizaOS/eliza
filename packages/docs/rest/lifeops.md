---
title: "LifeOps API"
sidebarTitle: "LifeOps"
description: "REST API endpoints for managing life-ops definitions, goals, occurrences, reminders, scheduled tasks, connectors, and the supporting knowledge graph."
---

The LifeOps API manages the agent's behavior-support and executive-assistant surface.
Definitions describe recurring tasks, habits, or routines; the engine generates occurrences
based on each definition's cadence. Goals group related definitions and track progress.
The same surface exposes scheduled tasks (the W1-A spine), connector pairing for the
messaging providers (Telegram, Signal, Discord, WhatsApp, iMessage, X), the entity and
relationship knowledge graph, sleep + health summaries, screen-time aggregates, money
ingestion, calendar/gmail integrations, and the workflow event triggers.

<Info>
LifeOps routes require an active agent runtime. If the runtime is unavailable, every endpoint
under `/api/lifeops` returns `503 Service Unavailable`.
</Info>

## Endpoint Index

> This index is auto-generated from the route declarations in `eliza/plugins/app-lifeops/src/routes/plugin.ts` and `scheduled-tasks.ts` by `eliza/scripts/generate-lifeops-rest-docs.mjs`. Do not hand-edit; rerun the generator instead.

Total documented routes: **188**.

### Overview + app-state

| Method | Path |
|--------|------|
| GET | `/api/lifeops/app-state` |
| PUT | `/api/lifeops/app-state` |
| GET | `/api/lifeops/overview` |

### Activity signals + manual override

| Method | Path |
|--------|------|
| GET | `/api/lifeops/activity-signals` |
| POST | `/api/lifeops/activity-signals` |
| POST | `/api/lifeops/manual-override` |

### Calendar

| Method | Path |
|--------|------|
| GET | `/api/lifeops/calendar/calendars` |
| PUT | `/api/lifeops/calendar/calendars/:id/include` |
| POST | `/api/lifeops/calendar/events` |
| PATCH | `/api/lifeops/calendar/events/:eventId` |
| DELETE | `/api/lifeops/calendar/events/:eventId` |
| GET | `/api/lifeops/calendar/feed` |
| GET | `/api/lifeops/calendar/next-context` |

### Capabilities + feature flags

| Method | Path |
|--------|------|
| GET | `/api/lifeops/capabilities` |
| POST | `/api/lifeops/features/toggle` |
| GET | `/api/lifeops/smart-features/settings` |
| POST | `/api/lifeops/smart-features/settings` |

### Channel policies

| Method | Path |
|--------|------|
| GET | `/api/lifeops/channel-policies` |
| POST | `/api/lifeops/channel-policies` |
| POST | `/api/lifeops/channels/phone-consent` |

### Cloud bridge

| Method | Path |
|--------|------|
| GET | `/api/cloud/features` |
| POST | `/api/cloud/features/sync` |
| GET | `/api/cloud/travel-providers/:provider/:providerPath*` |
| POST | `/api/cloud/travel-providers/:provider/:providerPath*` |

### Connectors — Discord

| Method | Path |
|--------|------|
| POST | `/api/lifeops/connectors/discord/connect` |
| POST | `/api/lifeops/connectors/discord/disconnect` |
| POST | `/api/lifeops/connectors/discord/send` |
| GET | `/api/lifeops/connectors/discord/status` |
| POST | `/api/lifeops/connectors/discord/verify` |

### Connectors — Google account management

| Method | Path |
|--------|------|
| GET | `/api/connectors/google/accounts` |
| POST | `/api/connectors/google/accounts` |
| GET | `/api/connectors/google/accounts/:accountId` |
| PATCH | `/api/connectors/google/accounts/:accountId` |
| DELETE | `/api/connectors/google/accounts/:accountId` |
| POST | `/api/connectors/google/accounts/:accountId/default` |
| POST | `/api/connectors/google/accounts/:accountId/refresh` |
| POST | `/api/connectors/google/accounts/:accountId/test` |
| GET | `/api/connectors/google/audit/events` |
| GET | `/api/connectors/google/oauth/callback` |
| POST | `/api/connectors/google/oauth/callback` |
| POST | `/api/connectors/google/oauth/start` |
| GET | `/api/connectors/google/oauth/status` |

### Connectors — Health

| Method | Path |
|--------|------|
| GET | `/api/lifeops/connectors/health/:provider/callback` |
| POST | `/api/lifeops/connectors/health/:provider/disconnect` |
| POST | `/api/lifeops/connectors/health/:provider/start` |
| GET | `/api/lifeops/connectors/health/:provider/status` |
| GET | `/api/lifeops/connectors/health/:provider/success` |
| GET | `/api/lifeops/connectors/health/status` |

### Connectors — Imessage

| Method | Path |
|--------|------|
| GET | `/api/lifeops/connectors/imessage/chats` |
| GET | `/api/lifeops/connectors/imessage/messages` |
| POST | `/api/lifeops/connectors/imessage/send` |
| GET | `/api/lifeops/connectors/imessage/status` |

### Connectors — Signal

| Method | Path |
|--------|------|
| POST | `/api/lifeops/connectors/signal/disconnect` |
| GET | `/api/lifeops/connectors/signal/messages` |
| POST | `/api/lifeops/connectors/signal/pair` |
| GET | `/api/lifeops/connectors/signal/pairing-status` |
| POST | `/api/lifeops/connectors/signal/send` |
| GET | `/api/lifeops/connectors/signal/status` |
| POST | `/api/lifeops/connectors/signal/stop` |

### Connectors — Telegram

| Method | Path |
|--------|------|
| POST | `/api/lifeops/connectors/telegram/cancel` |
| POST | `/api/lifeops/connectors/telegram/disconnect` |
| POST | `/api/lifeops/connectors/telegram/start` |
| GET | `/api/lifeops/connectors/telegram/status` |
| POST | `/api/lifeops/connectors/telegram/submit` |
| POST | `/api/lifeops/connectors/telegram/verify` |

### Connectors — Whatsapp

| Method | Path |
|--------|------|
| GET | `/api/lifeops/connectors/whatsapp/messages` |
| POST | `/api/lifeops/connectors/whatsapp/send` |
| GET | `/api/lifeops/connectors/whatsapp/status` |

### Connectors — X

| Method | Path |
|--------|------|
| POST | `/api/lifeops/connectors/x` |
| POST | `/api/lifeops/connectors/x/disconnect` |
| POST | `/api/lifeops/connectors/x/start` |
| GET | `/api/lifeops/connectors/x/status` |
| GET | `/api/lifeops/connectors/x/success` |

### Definitions, occurrences, goals

| Method | Path |
|--------|------|
| GET | `/api/lifeops/definitions` |
| POST | `/api/lifeops/definitions` |
| GET | `/api/lifeops/definitions/:id` |
| PUT | `/api/lifeops/definitions/:id` |
| DELETE | `/api/lifeops/definitions/:id` |
| GET | `/api/lifeops/goals` |
| POST | `/api/lifeops/goals` |
| GET | `/api/lifeops/goals/:id` |
| PUT | `/api/lifeops/goals/:id` |
| DELETE | `/api/lifeops/goals/:id` |
| GET | `/api/lifeops/goals/:id/review` |
| POST | `/api/lifeops/occurrences/:id/complete` |
| GET | `/api/lifeops/occurrences/:id/explanation` |
| POST | `/api/lifeops/occurrences/:id/skip` |
| POST | `/api/lifeops/occurrences/:id/snooze` |

### Gmail

| Method | Path |
|--------|------|
| POST | `/api/lifeops/gmail/batch-reply-drafts` |
| POST | `/api/lifeops/gmail/batch-reply-send` |
| POST | `/api/lifeops/gmail/events/ingest` |
| POST | `/api/lifeops/gmail/manage` |
| POST | `/api/lifeops/gmail/message-send` |
| GET | `/api/lifeops/gmail/needs-response` |
| GET | `/api/lifeops/gmail/recommendations` |
| POST | `/api/lifeops/gmail/reply-drafts` |
| POST | `/api/lifeops/gmail/reply-send` |
| GET | `/api/lifeops/gmail/search` |
| GET | `/api/lifeops/gmail/spam-review` |
| PATCH | `/api/lifeops/gmail/spam-review/:itemId` |
| GET | `/api/lifeops/gmail/triage` |
| GET | `/api/lifeops/gmail/unresponded` |

### Health

| Method | Path |
|--------|------|
| GET | `/api/lifeops/health/summary` |
| POST | `/api/lifeops/health/sync` |

### Inbox

| Method | Path |
|--------|------|
| GET | `/api/lifeops/inbox` |

### Knowledge graph (entities + relationships)

| Method | Path |
|--------|------|
| GET | `/api/lifeops/entities` |
| POST | `/api/lifeops/entities` |
| GET | `/api/lifeops/entities/:id` |
| PATCH | `/api/lifeops/entities/:id` |
| POST | `/api/lifeops/entities/:id/identities` |
| POST | `/api/lifeops/entities/merge` |
| GET | `/api/lifeops/entities/resolve` |
| GET | `/api/lifeops/relationships` |
| POST | `/api/lifeops/relationships` |
| GET | `/api/lifeops/relationships/:id` |
| PATCH | `/api/lifeops/relationships/:id` |
| POST | `/api/lifeops/relationships/:id/retire` |
| POST | `/api/lifeops/relationships/observe` |

### Money

| Method | Path |
|--------|------|
| GET | `/api/lifeops/money/bills` |
| POST | `/api/lifeops/money/bills/mark-paid` |
| POST | `/api/lifeops/money/bills/snooze` |
| GET | `/api/lifeops/money/dashboard` |
| POST | `/api/lifeops/money/import-csv` |
| POST | `/api/lifeops/money/paypal/authorize-url` |
| POST | `/api/lifeops/money/paypal/complete` |
| POST | `/api/lifeops/money/paypal/sync` |
| POST | `/api/lifeops/money/plaid/complete` |
| POST | `/api/lifeops/money/plaid/link-token` |
| POST | `/api/lifeops/money/plaid/sync` |
| GET | `/api/lifeops/money/recurring` |
| GET | `/api/lifeops/money/sources` |
| POST | `/api/lifeops/money/sources` |
| DELETE | `/api/lifeops/money/sources/:sourceId` |
| GET | `/api/lifeops/money/transactions` |

### OS permissions

| Method | Path |
|--------|------|
| GET | `/api/lifeops/permissions/full-disk-access` |

### Reminders

| Method | Path |
|--------|------|
| GET | `/api/lifeops/reminder-preferences` |
| POST | `/api/lifeops/reminder-preferences` |
| POST | `/api/lifeops/reminders/acknowledge` |
| GET | `/api/lifeops/reminders/inspection` |
| POST | `/api/lifeops/reminders/process` |

### Schedule observations + merged state

| Method | Path |
|--------|------|
| GET | `/api/lifeops/schedule/inspection` |
| GET | `/api/lifeops/schedule/merged-state` |
| POST | `/api/lifeops/schedule/observations` |
| GET | `/api/lifeops/schedule/summary` |

### Scheduled tasks (W1-A spine)

| Method | Path |
|--------|------|
| GET | `/api/lifeops/dev/registries` |
| GET | `/api/lifeops/dev/scheduled-tasks/:id/log` |
| GET | `/api/lifeops/scheduled-tasks` |
| POST | `/api/lifeops/scheduled-tasks` |
| POST | `/api/lifeops/scheduled-tasks/:id/acknowledge` |
| POST | `/api/lifeops/scheduled-tasks/:id/complete` |
| POST | `/api/lifeops/scheduled-tasks/:id/dismiss` |
| POST | `/api/lifeops/scheduled-tasks/:id/edit` |
| POST | `/api/lifeops/scheduled-tasks/:id/escalate` |
| GET | `/api/lifeops/scheduled-tasks/:id/history` |
| POST | `/api/lifeops/scheduled-tasks/:id/reopen` |
| POST | `/api/lifeops/scheduled-tasks/:id/skip` |
| POST | `/api/lifeops/scheduled-tasks/:id/snooze` |

### Screen-time + social

| Method | Path |
|--------|------|
| GET | `/api/lifeops/screen-time/breakdown` |
| GET | `/api/lifeops/screen-time/history` |
| GET | `/api/lifeops/screen-time/summary` |
| GET | `/api/lifeops/social/summary` |

### Sleep

| Method | Path |
|--------|------|
| GET | `/api/lifeops/sleep/baseline` |
| GET | `/api/lifeops/sleep/history` |
| GET | `/api/lifeops/sleep/regularity` |

### Website blockers

| Method | Path |
|--------|------|
| POST | `/api/lifeops/website-access/callbacks/:key/resolve` |
| POST | `/api/lifeops/website-access/relock` |
| GET | `/api/website-blocker` |
| POST | `/api/website-blocker` |
| PUT | `/api/website-blocker` |
| DELETE | `/api/website-blocker` |
| GET | `/api/website-blocker/status` |

### Workflows

| Method | Path |
|--------|------|
| GET | `/api/lifeops/workflows` |
| POST | `/api/lifeops/workflows` |
| GET | `/api/lifeops/workflows/:id` |
| PUT | `/api/lifeops/workflows/:id` |
| POST | `/api/lifeops/workflows/:id/run` |

### X (Twitter)

| Method | Path |
|--------|------|
| POST | `/api/lifeops/x/dms/curate` |
| GET | `/api/lifeops/x/dms/digest` |
| POST | `/api/lifeops/x/dms/send` |
| POST | `/api/lifeops/x/posts` |

### Other LifeOps

| Method | Path |
|--------|------|
| POST | `/api/lifeops/browser/register` |
| POST | `/api/lifeops/email-unsubscribe/scan` |
| POST | `/api/lifeops/email-unsubscribe/unsubscribe` |
| POST | `/api/lifeops/seed` |
| GET | `/api/lifeops/seed-templates` |
| POST | `/api/lifeops/subscriptions/cancel` |
| GET | `/api/lifeops/subscriptions/playbook-lookup` |
| GET | `/api/lifeops/subscriptions/playbooks` |

---

## Notes

- All endpoints under `/api/lifeops` require an active agent runtime; if the runtime is unavailable, the endpoint returns `503 Service Unavailable`.
- Public OAuth + connector callback routes (e.g. `GET /api/lifeops/connectors/health/:provider/callback`) are unauthenticated by design.
- Scheduled-task verbs (`/api/lifeops/scheduled-tasks/:id/{snooze,skip,complete,dismiss,escalate,acknowledge,reopen,edit}`) post no body when the verb is unambiguous; some accept JSON for context.
- Cadence kinds supported by definitions: `once`, `daily`, `times_per_day`, `interval`, `weekly`. Reminder channels: `in_app`, `sms`, `voice`, `telegram`, `discord`, `signal`, `whatsapp`, `imessage`, `email`, `push`.
- For request/response shape details, see `eliza/plugins/app-lifeops/src/routes/lifeops-routes.ts` and the corresponding handler in `src/routes/{entities,relationships,scheduled-tasks,sleep-routes,website-blocker-routes}.ts`. Each handler validates input via Zod schemas declared at module top.
