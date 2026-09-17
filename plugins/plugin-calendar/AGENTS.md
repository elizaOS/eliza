# @elizaos/plugin-calendar

First-class calendar plugin for elizaOS agents. See `README.md` for the surface
overview and `../../CLAUDE.md` (repo root) for monorepo-wide rules.

## Role

Owns the calendar domain extracted from `@elizaos/plugin-personal-assistant`: the calendar
event/sync store + schema, the Google + Apple calendar feed, event CRUD, the
`CALENDAR` action and its LLM handler, the shared calendar route dispatcher,
the provider-authenticated Google webhook, the client API methods augmented
onto `@elizaos/ui`, and the owner-facing calendar views. Private
`/api/lifeops/calendar/*` routes are mounted by the personal-assistant host
behind its OWNER/ADMIN role gate.

## Boundary rules

- **Storage + provider logic live here.** The cross-connector **grant registry**
  (Google account selection, scopes, multi-account) stays in `plugin-personal-assistant`,
  which injects a `CalendarConnectorGate` into `CalendarService` at init. Never
  import `@elizaos/plugin-personal-assistant` from this package — the dependency direction
  is `plugin-personal-assistant -> plugin-calendar`.
- **Schema namespace is `app_calendar`.** Calendar events and sync states were
  carved out of PA's `app_lifeops` schema; ICS sources, the durable secret
  cleanup outbox, feed preferences, and Google watch channels are
  calendar-native tables. `calendarPgSchema = pgSchema("app_calendar")` is
  registered via the plugin `schema` field, and `CalendarMigrationService`
  performs a non-destructive one-time reconciliation of existing `app_lifeops`
  rows only into empty owner tables without completed migration claims. Fresh
  imports verify the full projection; established owner rows and deletions remain
  authoritative, and legacy sources are never dropped. Requires
  `@elizaos/plugin-sql` loaded first. Raw SQL
  must qualify table names with the `app_calendar.` prefix.
- **Contract types live in `@elizaos/shared/contracts/calendar`** so `@elizaos/ui`
  (which types its `client` against them) and the plugins can both depend on them
  without a cycle.
- **Logger only, never `console`.** Prefix with `[ClassName]`.

## Layout

```
src/
  plugin.ts          Plugin definition (action, service, provider webhook)
  index.ts           Public exports
  service/           CalendarService + connector gate + repository + schema
  apple-calendar.ts  Native Apple Calendar bridge
  actions/           CALENDAR action + handler
  routes/            Shared host adapter + Google push webhook
  api/               client-calendar.ts (side-effect client augmentation)
  components/        Calendar views + event editor (React)
  hooks/             useCalendarWeek
  internal/          Shared utilities (normalize, format, sql helpers, errors, constants)
  ui.ts              UI entry (side-effectful)
```

## Commands

```bash
bun run --cwd plugins/plugin-calendar build
bun run --cwd plugins/plugin-calendar build:types
bun run --cwd plugins/plugin-calendar test
bun run --cwd plugins/plugin-calendar typecheck
```

## Google push configuration

- `GOOGLE_CALENDAR_WEBHOOK_ENABLED` must be exactly `true` before the public
  callback or watch creation is active; omission is fail-closed.
- `GOOGLE_CALENDAR_WEBHOOK_URL` must be a public HTTPS URL with the exact
  `/api/lifeops/calendar/google/webhook` path.

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.

Calendar feed and event-search promoted tools use operation-specific details schemas authored in the calendar leaf module. Preserve all consumed range, timezone, calendar/connector selection, refresh and search-query aliases, plus original optionality and owner gates. Parent, trip and mutation schemas retain their full contracts; never narrow them by applying a read-only schema globally.

Typed search_events calls need an event-content query through any supported query alias. Missing or placeholder-only filters return CALENDAR_SEARCH_QUERY_REQUIRED before inference or reading; the planner can supply the filter or select feed for an unfiltered date range. The umbrella natural-language planner keeps its query-extraction fallback. Preserve complete history for legacy inference and complete feed/receipt data.

Explicit read-window bounds without an offset are civil times in the requested or configured timezone, including DST day lengths. Offset-bearing bounds preserve their exact instants in both typed and extracted plans; never reinterpret UTC midnight as local midnight. The action and service share the calendar datetime normalizer, and malformed planner windows remain invalid as a pair.

CALENDAR_SEARCH_QUERY_REQUIRED from typed preflight carries the core coachingFailure marker because no read or effect occurred. Preserve its failed receipt and required evaluation; a corrected successful feed may complete without forcing a stale-failure summary. Service outages, permission errors and mutation failures must not receive this marker.

Calendar read-window schema guidance treats timeMax as exclusive: a full civil day/month ends at the next day/month boundary in the requested timezone. The executor preserves model-selected bounds; it does not infer or silently rewrite the requested period from user prose.

Promoted Calendar read schemas describe read scope only: connector mode and side match the executor's accepted enums, and hidden-calendar guidance states each operation's actual default. Omitted connector filters stay omitted. Preserve consumed aliases, exact user-requested scopes and full parent/mutation schemas; do not infer scope from user prose or silently broaden a feed.

Conversational event creation re-derives timing from the authoritative user request and relevant dialogue, even when native planner arguments are syntactically complete. Missing extracted timing pauses before mutation and must not fall back to planner timestamps or window guesses. Availability alone does not authorize a schedule; choose a slot only when the user delegates that choice within a stated window. UI/API callers retain their structured request contract. Completion facts format relative days from the actual event and the same local timezone.

Conversational creates and time changes run the canonical availability evaluator against the exact proposed interval before writing. A move excludes only its own event ID. Conflicts pause without silently moving either event; incomplete calendar coverage cannot claim a free slot. This covers the owner feed, not unconsented guest availability or a transactional lock across external calendar providers.

Calendar mutation replies use the normal model response path with canonical effect receipts and full saved event evidence. A mechanically checked fact sentence is internal evidence, never a verbatim user-facing shortcut. Keep date/time facts exact while allowing concise conversational wording.

Update extraction requests local civil timestamps in the event timezone and anchors relative dates to the message timestamp. An extracted start uses only its paired extracted end, or the stored duration; do not mix that range with planner timing. Explicit extraction clarification pauses before mutation. Legacy absent-extraction fallback remains distinct from this range-selection contract.

Blocked, definitive calendar writes may read the remaining local day and return two verified alternatives of the requested duration. Suggestions never authorize a write; accepted slots go through the normal write-time availability check. Free and inconclusive writes do not pay for this alternative lookup. Built-in calendar feed timestamps represent completed local reads, including empty windows; mutation replay remains ledger-owned.
