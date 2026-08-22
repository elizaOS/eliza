# feat(cloud): owner-scheduled group reminders for Personal Shared group bindings

## What

Personal Shared reminders can now be created from a linked group chat and fire
back into that group. The capability is owner-only and binding-scoped:

- **Creation (route):** on a group turn, the trusted messaging route builds a
  `kind: "group"` reminder destination only when the sender is the binding's
  `created_by_platform_user_id`. Non-owner participants get no reminder
  capability at all (the `trustedDelivery` slot stays `undefined`, so the
  REMINDERS action is never mounted for their turns).
- **Storage (plugin-scheduling):** `SharedReminderDelivery` gains a
  `{ platform: "telegram" | "blooio", kind: "group", project, chatId,
  groupBindingId, ownerLabel }` member. `parseSharedReminderDelivery`
  validates it (telegram `-?\d{1,20}` / blooio `chat_*` chat ids, uuid binding
  id, non-empty ownerLabel <= 128 chars) and strips Telegram legacy-Markdown
  metacharacters (`[]()*_` and backtick) from the owner label, falling back to
  "the group owner" when nothing survives, so a display name can never inject
  formatting or link syntax into the connector send. Existing DM shapes are
  unchanged. Group creation validates the body against
  `sharedReminderMaxBodyLength(delivery)` — the connector limit minus the
  fire-time prefix — so an accepted reminder can never become undeliverable.
- **Fire (cron dispatcher):** before any connector egress, a group delivery
  re-loads its binding by id and requires `state === "active"` plus an
  unchanged platform/project/provider chat id. Suspended (Eliza removed),
  revoked (`/eliza_leave`), or re-bound chats fail closed with a typed
  `unknown_recipient` / `not_accepted` dispatch failure that the dispatch
  policy surfaces as a connector degradation and settles terminally; the task
  is never silently marked fired. Delivered sends are prefixed
  `"Reminder for this group from <owner>: ..."` via the shared
  `sharedGroupReminderMessageText` helper (single source of truth with the
  creation-time budget) so participants know why Eliza spoke, provider message
  ids are recorded as group delivery receipts (so
  Blooio replies to a fired reminder pass reply verification), and the
  DM-styled mobile push fan-out is skipped for group sends.
- **Gateway:** `/internal/deliver` accepts a Blooio `chat_*` recipient and
  routes it through the provider's `/v4/chats/{id}/messages` thread endpoint
  (no `to`/`from`); Telegram group chat ids already fit the existing shape.

## Why

Group bindings already carry the owner's identity, billing authority, and a
durable provider chat id, but reminders were DM-only: the route explicitly
passed `undefined` as the trusted delivery for group turns. This closes that
gap without widening authority: only the binding owner can schedule, and the
binding stays the single revocation authority at fire time.

## How it holds the policy line

- **Owner-only:** enforced at the route with the same identity the existing
  policy/leave commands use (`created_by_platform_user_id`).
- **mention_only unaffected:** `group_silent` still short-circuits ambient
  turns before any capability; reminder *delivery* is an owner-requested
  proactive send and correctly ignores the inbound response policy.
- **Fail closed on suspension/revocation/cutover:** the binding check lives in
  `sharedReminderDispatcher.dispatch`, the single choke point shared by the
  Cloudflare cron and the Dedicated-cutover deliver route
  (`/v1/eliza/agents/:agentId/shared-reminders/:taskId/deliver`), so both
  runtimes get the same gate.

## Rollout

No flag: the feature is data-driven. Existing reminders have DM metadata and
behave exactly as before; group metadata only starts existing once the new
route code runs. Deploy order is tolerant: an old cron reading a new group
task fails parse (`Shared reminder delivery metadata is invalid`) rather than
misdelivering, and a new cron reading old DM tasks is unchanged. The
gateway-webhook service should deploy before or with the Worker so Blooio
`chat_*` deliveries are accepted (until then they fail as
not-accepted/retryable at the gateway parse boundary, never misrouted). No DB
migration: only a new read (`findBindingById`) on an existing table.

## Files changed

- `plugins/plugin-scheduling/src/shared-reminders.ts` — group delivery union
  member, validation with owner-label Markdown sanitization, group-aware
  action copy, prefix/budget helpers (`sharedGroupReminderMessageText`,
  `sharedReminderMaxBodyLength`) used at creation
- `plugins/plugin-scheduling/src/edge.ts` — export the new type/guard/helpers
- `packages/cloud/api/internal/eliza-app/personal-shared/messages/route.ts` —
  owner-gated group `trustedDelivery` on group turns
- `packages/cloud/shared/src/lib/services/shared-runtime/shared-reminder-cron.ts`
  — binding re-verification, group prefix, receipt recording, push skip,
  gateway wire payload
- `packages/cloud/shared/src/db/repositories/personal-shared-groups.ts` —
  `findBindingById`
- `packages/cloud/services/gateway-webhook/src/internal-delivery.ts` — Blooio
  `chat_*` recipient shape and group ChatEvent
- Tests: `plugins/plugin-scheduling/src/shared-reminders.group.test.ts`,
  `packages/cloud/api/internal/eliza-app/personal-shared/messages/route.group-reminders.test.ts`,
  `packages/cloud/api/__tests__/shared-reminder-dedicated-delivery.group.test.ts`,
  `packages/cloud/shared/src/lib/services/shared-runtime/shared-reminder-cron.group.test.ts`,
  `packages/cloud/services/gateway-webhook/__tests__/internal-delivery.group.test.ts`,
  plus updated assertions in the existing route and cron suites

## Test evidence

- `plugins/plugin-scheduling` full vitest suite: **579 passed (36 files)**,
  including 8 new group tests (parse round-trip/rejections, owner-label
  Markdown sanitization, group action copy, destination pinning, the reserved
  prefix budget at creation, dispatch-policy outcome).
- `packages/cloud/shared` `bun test --isolate src/lib/services/shared-runtime/`:
  **459 pass**; the new cron group suite is 10 tests (active delivery + receipt
  + no push via the gateway path, the same contract through the Personal
  Shared Telegram edge dispatch, Blooio thread routing,
  missing/suspended/revoked/rebound bindings fail closed pre-egress,
  over-limit after prefix, receipt-failure tolerance, DM regression).
  2 failures in this sweep are pre-existing on the base
  commit and unrelated (`shared-capability-wall.test.ts` continuation-bounds
  assertion; `shared-facts.test.ts` missing `SHARED_FACTS_MAX_FACT_CHARS`
  export), verified by stashing this change.
- `packages/cloud/services/gateway-webhook` full `bun test`: **192 pass
  (25 files)**, including 4 new group tests (chat-thread egress + idempotent
  replay, Telegram group id, malformed recipients 400 pre-egress, DM
  regression).
- `packages/cloud/api` full isolated unit lane
  (`node test/run-unit-isolated.mjs`): **exit 0, all files pass**, including
  the touched `personal-shared` route suites (44 existing + 6 new route
  tests) and both Dedicated-delivery suites (3 existing + 2 new). The new
  route tests cover the owner grant (incl. Blooio), the owner-label fallback,
  the non-owner withholding, the owner-only control copy, the suspended
  binding, and the `group_silent` regression; the 2 new Dedicated-cutover
  tests run the REAL dispatcher through the deliver route (an active binding
  delivers the prefixed group send; a revoked binding returns 409
  `unknown_recipient` with no egress).
- Typecheck: clean for every touched file in `plugin-scheduling`,
  `cloud/shared`, `cloud/api`, and `gateway-webhook` (remaining typecheck
  output in the first three packages is pre-existing transitive noise from
  unbuilt sibling workspaces, unchanged by this PR).
- Biome: clean on all touched files.

## Limitations (honest)

- **No live end-to-end run.** Coverage is unit/contract level with mocked
  provider HTTP and repository boundaries; a real Telegram/Blooio group fire
  from a deployed stack has not been exercised.
- **Owner label is frozen at creation.** The prefix uses the display name the
  owner had when the reminder was created; a later rename is not reflected,
  and an owner without a platform display name (or whose name is entirely
  Markdown metacharacters) is labeled "the group owner". Sanitization strips
  `[]()*_` and backtick from the rendered label rather than escaping them.
- **Telegram edge cases:** a group migrating to a supergroup changes its chat
  id; the binding check then fails the reminder closed as
  `unknown_recipient` (safe, but the owner must relink and reschedule).
- **Dedicated runtimes** deliver group reminders only through the Shared
  cutover relay for tasks created while on Shared; reminders newly created
  inside a Dedicated container's own scheduler are out of scope here.
- **Terminal failure surfacing:** an inactive-binding failure records
  `connectorDegradation` and settles the task as failed via the existing
  dispatch policy; there is no additional owner DM notifying that a group
  reminder was dropped.
- **Repository-wide gates:** package-scoped tests, typecheck, and lint were
  run; the full root `bun run verify` sweep has not been run on this branch
  yet and should run in CI before merge.

## Review

Code review verdict: **ship**, with three minor findings, all addressed:

1. **Undeliverable long group reminders (fixed).** The fire-time prefix
   `"Reminder for this group from <owner>: "` was prepended after creation
   had already validated the raw body against the 2000-character connector
   limit, so a body in roughly the 1842–2000 range was accepted at creation
   but failed every fire as `transport_error`. Fix: creation now validates
   against `sharedReminderMaxBodyLength(delivery)`, which reserves the exact
   prefix budget; the prefix itself moved into the shared
   `sharedGroupReminderMessageText` helper used by both creation and the cron
   dispatcher, so the two sides cannot drift. The cron over-limit guard
   remains as defense in depth for pre-budget rows. Covered by a new plugin
   test that rejects at budget+1 and accepts at exactly the budget (fire-time
   text length == 2000).
2. **Markdown injection via the owner display name (fixed).** `ownerLabel`
   came from the actor's display name (length-validated only) and was
   interpolated verbatim into text sent to Telegram with
   `parse_mode: "Markdown"`, letting a display name render formatting or
   links in the group message. Fix: `parseSharedReminderDelivery` now strips
   Telegram legacy-Markdown metacharacters (`[]()*_` and backtick) from the
   label, collapses whitespace, and falls back to "the group owner" when
   nothing survives. Stripping (not escaping) never lengthens the label, so
   the creation-time prefix budget stays exact, and the sanitizer runs at the
   parse boundary used by both creation and fire. The reminder *body* keeps
   its existing behavior (pre-dates this PR for DM reminders; Telegram
   auto-retries without Markdown on a parse rejection). Covered by new parse
   tests including link-syntax and all-metacharacter labels.
3. **No group coverage of the Telegram edge dispatch path (fixed).** When
   `isPersonalSharedTelegramEdgeEnabled` is set, cron group Telegram sends go
   through `dispatchPersonalTelegramReminder` rather than the gateway; that
   branch had no group test. Added a cron group test driving the
   `telegramDispatch` option and asserting the prefixed text and group chat
   id reach the edge dispatch, no gateway fetch happens, and receipts are
   still recorded. Also verified the synthesized event's
   `chatType: "private"` / `senderId = chatId` have no adverse downstream
   effect for groups: `sendTelegramReply` addresses the send by
   `event.chatId`, and the exact-once ledger keys its Durable Object by
   `senderId` directly via `namespace.getByName` (unique per group chat id;
   the positive-only `DELIVERY_SENDER_RE` guards only the separate inbound
   HTTP ledger route, which this path never traverses).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
