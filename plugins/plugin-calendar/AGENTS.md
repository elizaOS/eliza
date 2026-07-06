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
- **Schema namespace is `app_calendar`.** The two calendar tables
  (`life_calendar_events`, `life_calendar_sync_states`) were carved out of PA's
  `app_lifeops` schema. `calendarPgSchema = pgSchema("app_calendar")` is
  registered via the plugin `schema` field, and `CalendarMigrationService`
  performs a non-destructive one-time copy of any existing `app_lifeops` rows
  (the plugin-finances carve pattern: skip if source missing / target non-empty,
  never drop the source). Requires `@elizaos/plugin-sql` loaded first. Raw SQL
  must qualify table names with the `app_calendar.` prefix.
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

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — platform connector:**
- A real (or sandbox-account) round-trip on the platform: inbound message → agent → outbound reply, captured as logs **and** a screenshot/recording of the actual conversation.
- The raw inbound event/webhook payload and the outbound API request/response, with IDs mapped correctly (`stringToUuid` / `createUniqueUuid`).
- Attachments, threads/replies, edits, multi-account, and rate-limit/error paths — not just a single text ping.
- The agent trajectory for the turn the connector drove.
<!-- END: evidence-and-e2e-mandate -->
