# @elizaos/plugin-calendar

First-class calendar plugin for elizaOS agents. See `README.md` for the surface
overview and `../../CLAUDE.md` (repo root) for monorepo-wide rules.

## Role

Owns the calendar domain extracted from `@elizaos/plugin-personal-assistant`: the calendar
event/sync store + schema, the Google + Apple calendar feed, event CRUD, the
`CALENDAR` action and its LLM handler, `/api/calendar/*` routes, the client API
methods augmented onto `@elizaos/ui`, and the owner-facing calendar views.

## Boundary rules

- **Storage + provider logic live here.** The cross-connector **grant registry**
  (Google account selection, scopes, multi-account) stays in `plugin-lifeops`,
  which injects a `CalendarConnectorGate` into `CalendarService` at init. Never
  import `@elizaos/plugin-personal-assistant` from this package — the dependency direction
  is `plugin-lifeops -> plugin-calendar`.
- **Contract types live in `@elizaos/shared/contracts/calendar`** so `@elizaos/ui`
  (which types its `client` against them) and the plugins can both depend on them
  without a cycle.
- **Logger only, never `console`.** Prefix with `[ClassName]`.

## Layout

```
src/
  plugin.ts          Plugin definition (action, service, routes)
  index.ts           Public exports
  service/           CalendarService + connector gate + repository + schema
  apple-calendar.ts  Native Apple Calendar bridge
  actions/           CALENDAR action + handler
  routes/            /api/calendar/* HTTP handlers
  api/               client-calendar.ts (side-effect client augmentation)
  components/        Calendar views + event editor (React)
  hooks/             useCalendarWeek
  ui.ts              UI entry (side-effectful)
```

## Commands

```bash
bun run --cwd plugins/plugin-calendar build
bun run --cwd plugins/plugin-calendar build:types
bun run --cwd plugins/plugin-calendar test
bun run --cwd plugins/plugin-calendar typecheck
```
