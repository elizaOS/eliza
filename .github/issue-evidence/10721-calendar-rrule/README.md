# #11788 / #10721 — calendar RRULE / recurring-event semantics

Evidence that LifeOps calendar actions now honor RRULE/recurring-event
semantics end to end: recurrence-aware create, explicit instance-vs-series
intent on update/delete, series mutations that target the series master
(never an iteration over flattened occurrences), and recurrence metadata on
readback.

## Artifacts

| File | What it proves |
| --- | --- |
| `live-llm-trajectory.json` | **Real-LLM trajectories** (live `claude` CLI, haiku — not the proxy, not a mock) driving the PRODUCTION `CALENDAR` action handler. Contains every prompt the handler built, every raw model response, the provider-bound service calls, and the grounded replies for 4 scenarios (see below). Reviewed by hand. |
| `live-rrule-evidence.mts` | The runner that produced the trajectory (drives `createCalendarActionRunner` with the live model at the `CalendarActionDeps` seam and a spied `CalendarService`). Re-run: `cp` into `plugins/plugin-calendar/` and `bun live-rrule-evidence.mts`. |
| `fail-without-fix.txt` | The new test suites run against the **pre-fix** `calendar-handler.ts` + `CalendarService.ts` from `origin/develop`: **22 failures** (ambiguous recurring delete mutates without asking, recurrence dropped on create, no series-master resolution, invalid RRULE silently ignored, …). All 22 pass with the fix. |
| `test-runs.txt` | Full local runs: plugin-calendar suite (**195 passing / 2 skipped** incl. 54 new recurrence tests), plugin-google (**22**), packages/shared (**1049**), typecheck across all 7 affected packages. |

## Live-LLM scenario results (from `live-llm-trajectory.json`)

1. **create-recurring** — "book a 30 minute morning run … every monday at 7am
   eastern": the live model planned `create_event` and extracted
   `RRULE:FREQ=WEEKLY;BYDAY=MO` itself; `createCalendarEvent` received
   `recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"]`; reply: *"Created calendar
   event "morning run" … It repeats weekly on Monday."*
2. **update-ambiguous** — "move my team standup to 10am" against a recurring
   occurrence: the model extraction did **not** invent a scope, the handler
   clarified — *""Team Standup" repeats weekly on Wednesday. should i change
   just this occurrence or the whole series?"* — and **no mutation was
   issued**.
3. **update-instance** — "move just this one team standup occurrence to
   10am": live extraction returned `recurrenceScope: "instance"`;
   `updateCalendarEvent` was called with the occurrence id +
   `recurrenceScope: "instance"`.
4. **delete-series** — "delete the whole series of my team standup": exactly
   **one** `deleteCalendarEvent` call with `recurrenceScope: "series"`.

## Acceptance criteria mapping

- *"Create a recurring …" produces a recurring event through the real
  calendar service path and readback shows the recurrence metadata* —
  live scenario 1 + `calendar-recurrence-service.test.ts`
  ("normalizes recurrence to the provider and surfaces it on readback":
  provider input, `event.recurrence`, and the PGlite cache row all carry the
  RRULE) + plugin-google contract test (insert/patch `requestBody.recurrence`,
  readback mapping).
- *Update/delete of a recurring title requires explicit single occurrence vs
  series intent when ambiguous* — live scenario 2 +
  `calendar-recurrence-ops.test.ts` (ambiguous update & delete → clarification,
  zero mutation calls).
- *A single occurrence update/delete does not mutate/delete the whole series* —
  live scenario 3 + ops/service tests (instance scope patches/deletes only the
  addressed occurrence id).
- *A series update/delete does not require iterating over flattened
  occurrences* — live scenario 4 + service test: ONE provider call against the
  resolved series-master id (cache-first via `recurringEventId`, provider
  `getEvent` fallback), plus cached-occurrence purge.
- *Multi-account `grantId + calendarId` isolation is preserved* — service test
  "series scope deletes the master once and purges cached occurrences,
  preserving other accounts" (foreign-grant rows survive the purge).
- *DST correctness* — `recurrence.test.ts` expands a daily-9am rule across the
  2026-03-08 spring-forward and 2026-11-01 fall-back (America/New_York):
  local wall-clock time holds, exactly one occurrence per local day; expected
  instants independently verified against `Intl.DateTimeFormat`.
  COUNT/UNTIL termination and weekly/monthly next-occurrence covered.

## Required evidence not applicable

- **Video walkthrough / before-after screenshots (desktop + mobile)** —
  N/A: no UI surface changed; this is an action/service/contract change. The
  user-visible surface is chat replies, which are captured verbatim (grounded
  reply text) in `live-llm-trajectory.json`.
- **Live Google Calendar API round-trip** — N/A in this environment: no
  `GOOGLE_CALENDAR_ACCESS_TOKEN` available. The provider seam is covered by
  the recorded-wire contract tests (`google-calendar-connector.contract.test.ts`
  pattern, extended in `plugins/plugin-google/src/index.test.ts`) and the
  existing live drift lane `google-calendar-connector.real.test.ts`
  (post-merge, token-gated) exercises `mapEvent` against the real API,
  including the new `recurrence`/`recurringEventId` fields.
- **Audio** — N/A: no voice path touched.
