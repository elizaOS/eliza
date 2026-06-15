# @elizaos/plugin-calendar

First-class calendar plugin for elizaOS agents. Owns the calendar domain that
previously lived inside `@elizaos/plugin-personal-assistant`:

- **Calendar feed** aggregated across Google Calendar (via `@elizaos/plugin-google`)
  and Apple Calendar (native macOS/iOS bridge via `@elizaos/capacitor-calendar`).
- **Event CRUD** — create / update / delete events across providers.
- **CALENDAR action** — natural-language calendar read/write and scheduling.
- **HTTP routes** — `/api/calendar/*` (feed, calendars, events, next-context).
- **Client API** — `client.getLifeOpsCalendarFeed` / `createLifeOpsCalendarEvent` / …
  augmented onto the `@elizaos/ui` client.
- **Owner-facing views** — week / day / month / agenda calendar UI and the event
  editor drawer.

## Boundary

The calendar **storage and provider logic** live here. The **connector grant
registry** (which Google account, which scopes, multi-account selection) is a
cross-connector concern owned by `@elizaos/plugin-personal-assistant`; `plugin-lifeops`
injects a `CalendarConnectorGate` into the `CalendarService` at init so there is
no dependency cycle. When `plugin-lifeops` is absent, the service falls back to
talking to `@elizaos/plugin-google` and the native Apple bridge directly.

Calendar **contract types** (`LifeOpsCalendarEvent`, `LifeOpsCalendarFeed`, …)
live in `@elizaos/shared/contracts/calendar` because the contract layer is the
only package both `@elizaos/ui` and the plugins can depend on without a cycle.

## Commands

```bash
bun run --cwd plugins/plugin-calendar build       # tsup + views + types
bun run --cwd plugins/plugin-calendar build:types  # declaration emit
bun run --cwd plugins/plugin-calendar test         # vitest
bun run --cwd plugins/plugin-calendar typecheck    # tsgo --noEmit
```

See the root `AGENTS.md` for repo-wide architecture rules.
