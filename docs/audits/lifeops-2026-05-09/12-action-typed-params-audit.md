# LifeOps action typed-parameter audit

**Date:** 2026-05-10
**Wave:** 4A — Audit Eliza actions for typed parameters
**Manifest:** `packages/benchmarks/lifeops-bench/manifests/actions.manifest.json`

## Top-line finding

Every action surfaced through `app-lifeops`, `app-phone`, and `plugin-todos`
already declares `parameters: ActionParameter[]`. The exporter
(`scripts/lifeops-bench/export-action-manifest.ts`) emitted **0 warnings**
about empty schemas — every action's `properties` map was non-empty even
before this audit.

The actual gap was discoverability: many actions defined
`subaction` (or other discriminator) parameters as bare
`{ type: "string" }` with no `enum`, no `descriptionCompressed`, and no
`examples`. Non-Eliza agents (OpenClaw, Hermes, Cerebras-direct) saw the
field but had no closed-set guidance, so they had to guess from the
verbose `description` text.

## Audit table — before / after

| Action | File | Has `parameters` | Enums (before) | Enums (after) | Notes |
|---|---|---|---|---|---|
| HEALTH | `health.ts` | yes | 0 | 2 | added `subaction`, `metric` enums; `days` minimum/maximum |
| ENTITY | `entity.ts` | yes | 0 | 2 | added `subaction`, `channel` enums; examples on `platform`, `relationshipType` |
| BOOK_TRAVEL | `book-travel.ts` | yes | 0 | 1 (in nested item) | typed `passengers[]` items + required; IATA/date patterns; `calendarSync` properties |
| SCHEDULING_NEGOTIATION | `lib/scheduling-handler.ts` | yes | 0 | 3 | added `subaction`, `response`, `proposedBy` enums; surfaced `proposedBy`/`relationshipId`/`timezone`/`reason` |
| SCREEN_TIME | `screen-time.ts` | yes | 0 | 2 | added `subaction`, `source` enums |
| DEVICE_INTENT | `device-intent.ts` | yes | 0 | 4 | added `subaction`, `kind`, `target`, `priority` enums; surfaced `priority`/`expiresInMinutes`/`actionUrl` |
| REMOTE_DESKTOP | `remote-desktop.ts` | yes | 0 | 1 | added `subaction` enum; `pairingCode` 6-digit pattern |
| TOGGLE_FEATURE | `toggle-feature.ts` | yes | 0 | 1 | added `featureKey` enum from `ALL_FEATURE_KEYS` |
| SCHEDULE | `schedule.ts` | yes | 0 | 1 | added `subaction` enum |
| CALENDLY | `lib/calendly-handler.ts` | yes | 0 | 1 | added `subaction` enum; date patterns |
| CALENDAR | `calendar.ts` | yes | 1 | 1 | typed `details` properties (calendarId, timeMin, timeMax, …); typed `blackoutWindows[]` items + required |

Every other LifeOps action (BLOCK, CALENDAR_*, CONNECTOR_*, CREDENTIALS_*, LIFE_*, MESSAGE, MONEY_*, PROFILE_*, RESOLVE_REQUEST_*, SCHEDULED_TASK_*, VOICE_CALL, etc.) **already had** rich `parameters: ActionParameter[]` arrays with at least one enum on `subaction` and per-parameter descriptions. They are out of scope for this pass.

`scheduling-negotiation.ts` is a re-export shim — the real definition lives in `lib/scheduling-handler.ts`. That file was edited in place.

## Sample new parameter shapes

### Calendar — `details` (object, recursively typed)

```ts
{
  name: "details",
  description: "Structured calendar fields — time bounds, timezone, calendar id, create-event timing, location, and attendees.",
  descriptionCompressed: "calendar details: calendarId timeMin timeMax timeZone startAt endAt durationMinutes eventId newTitle description location travelOriginAddress windowDays windowPreset forceSync",
  required: false,
  schema: {
    type: "object",
    properties: {
      calendarId:    { type: "string" },
      timeMin:       { type: "string" },
      timeMax:       { type: "string" },
      timeZone:      { type: "string" },
      forceSync:     { type: "boolean" },
      windowDays:    { type: "number" },
      windowPreset:  { type: "string" },
      startAt:       { type: "string" },
      endAt:         { type: "string" },
      durationMinutes: { type: "number" },
      eventId:       { type: "string" },
      newTitle:      { type: "string" },
      description:   { type: "string" },
      location:      { type: "string" },
      travelOriginAddress: { type: "string" },
      attendees:     { type: "array", items: { type: "string" } },
    },
  },
},
```

### Mail / messaging adjacent — DEVICE_INTENT (`kind` enum)

```ts
{
  name: "kind",
  description: "Intent kind: user_action_requested, routine_reminder, attention_request, or state_sync.",
  descriptionCompressed: "kind: user_action_requested|routine_reminder|attention_request|state_sync",
  required: false,
  schema: {
    type: "string",
    enum: [
      "user_action_requested",
      "routine_reminder",
      "attention_request",
      "state_sync",
    ],
  },
},
```

### Entity-related — ENTITY (`channel` enum from `LIFEOPS_MESSAGE_CHANNELS`)

```ts
{
  name: "channel",
  description: "Primary channel for the contact (email, telegram, discord, signal, sms, twilio_voice, imessage, whatsapp).",
  descriptionCompressed: "primary channel: email|telegram|discord|signal|sms|twilio_voice|imessage|whatsapp",
  schema: {
    type: "string",
    enum: [...LIFEOPS_MESSAGE_CHANNELS],
  },
  examples: ["email", "telegram", "imessage"],
},
```

## Manifest re-export

```
$ bun run scripts/lifeops-bench/export-action-manifest.ts
{
  "ok": true,
  "actionCount": 91,
  "byPlugin": {
    "@elizaos/app-lifeops": 89,
    "@elizaos/app-phone":   1,
    "@elizaos/plugin-todos":1
  },
  "warnings": 0,
  "skipped":  3
}
```

Action count unchanged (91 → 91); zero exporter warnings; per-plugin
counts unchanged. The 3 "skipped" plugins are the connector-only plugins
that intentionally expose no static actions (they register
MessageConnector send-handlers at init time).

Enum coverage for the 11 priority actions audited:

| Action | props | enums (after) | nested-typed array items |
|---|---:|---:|---:|
| BOOK_TRAVEL | 7 | 0 (top) | 1 (passengers[]) |
| CALENDAR | 19 | 1 | 1 (blackoutWindows[]) |
| CALENDLY | 6 | 1 | 0 |
| DEVICE_INTENT | 9 | 4 | 0 |
| ENTITY | 19 | 2 | 0 |
| HEALTH | 5 | 2 | 0 |
| REMOTE_DESKTOP | 6 | 1 | 0 |
| SCHEDULE | 2 | 1 | 0 |
| SCHEDULING_NEGOTIATION | 14 (was 10) | 3 | 0 |
| SCREEN_TIME | 11 | 2 | 0 |
| TOGGLE_FEATURE | 3 | 1 | 0 |

## Verification

- `bun run build:types` (app-lifeops) — pass.
- `bunx vitest run --config vitest.config.ts` (app-lifeops) — **45 files, 448 tests, all passing**.
- LifeOpsBench `python3 -m pytest tests/` — **286 passed, 3 skipped, 1 failed**. The single failure (`tests/test_scenarios_corpus.py::test_every_action_name_exists_in_manifest`) is **pre-existing** and unrelated to this audit: scenario files reference `PAYMENTS`, `SUBSCRIPTIONS_AUDIT`, `SUBSCRIPTIONS_CANCEL`, `APP_BLOCK`, `WEBSITE_BLOCK`, but the live manifest now exposes the renamed `MONEY_*` family and folded `APP_BLOCK`/`WEBSITE_BLOCK` into `BLOCK_*`. This is a Wave 4C concern (scenario-corpus refresh), not a parameter-typing regression.

## Per-action rationale

Every modified action has a sibling `<action>.params.notes.md` documenting why each enum/required choice was made and which fields were intentionally left non-required. They live next to the `.ts` file under `plugins/app-lifeops/src/actions/`.

## Hard constraints respected

- Handler return types: unchanged.
- Handler business logic: unchanged. Only `parameters: []` arrays were edited.
- New actions: none added.
- `packages/benchmarks/lifeops-bench/` source: untouched (the manifest JSON inside it is a generated artifact and is regenerated by `export-action-manifest.ts`).
- No `?? defaults` were added to back-fill required-ness.
