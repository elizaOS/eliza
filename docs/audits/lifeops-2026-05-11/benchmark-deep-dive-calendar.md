# Calendar benchmark deep-dive — W5-cal

> Source run: `~/.milady/runs/lifeops/lifeops-multiagent-best/`
> Scope: 25 calendar scenarios × 3 harnesses (eliza, hermes, openclaw) × gpt-oss-120b
> All numbers come from the saved per-scenario JSON; no fresh bench was run.

## 1. What this benchmark tests

The calendar benchmark exercises the elizaOS `CALENDAR` umbrella action (plus
its promoted granular siblings `CALENDAR_CREATE_EVENT`,
`CALENDAR_UPDATE_EVENT`, `CALENDAR_DELETE_EVENT`, `CALENDAR_CHECK_AVAILABILITY`,
`CALENDAR_PROPOSE_TIMES`, `CALENDAR_SEARCH_EVENTS`, `CALENDAR_NEXT_EVENT`,
`CALENDAR_UPDATE_PREFERENCES`, `CALENDAR_FEED`, `CALENDAR_BULK_RESCHEDULE`,
`CALENDAR_TRIP_WINDOW`). The umbrella expects:

- A `subaction` discriminator (the manifest schema labels the property
  `action`, but the description, examples, and runner consistently use
  `subaction` — see [section 5.2](#52-manifest-description-tightening)).
- A FLAT top-level `title` for `create_event`.
- A NESTED `details` object for `create_event`/`update_event`/`delete_event`
  containing `calendarId`, `eventId`, `start`, `end`, `location`, `attendees`,
  `description` (the Python executor `_u_calendar` in
  `eliza_lifeops_bench/runner.py` reads these from `details` only for
  `update_event`/`delete_event` — `create_event` accepts flat fallback for
  `calendarId`/`start`/`end`).
- TOP-LEVEL fields for `check_availability` (`startAt`/`endAt`),
  `propose_times` (`windowStart`/`windowEnd`/`durationMinutes`/`slotCount`),
  and `update_preferences` (`preferredStartLocal`/`preferredEndLocal`/
  `blackoutWindows`).

Scoring (`scorer.py`, STATIC weighting): `0.5 × state_hash_match +
0.4 × action_score + 0.1 × substring_score`. State-hash dominates: scenarios
that mutate the world need the agent to pick correct kwargs (nested in
`details`, correct `eventId`, etc.). Read-only scenarios match the state
hash trivially because the world doesn't change.

Subactions exercised by the 25 calendar scenarios:

| Subaction | Count | Mutation? |
|---|---:|---|
| `create_event` | 5 | yes |
| `delete_event` | 5 | yes |
| `update_event` | 4 | yes |
| `propose_times` | 3 | no |
| `check_availability` | 4 | no |
| `search_events` | 1 | no |
| `next_event` | 1 | no |
| `update_preferences` | 1 | no (no LifeWorld persistence) |
| smoke (`create_event`) | 1 | yes |

Read-only:write-op split = **10 : 15**, so 60% of the corpus needs a clean
state-hash match.

## 2. Per-harness headline

| Agent    | n  | pass@1 | mean  | state_match | term=max_turns | term=respond |
|----------|---:|-------:|------:|------------:|---------------:|-------------:|
| eliza    | 25 |   0.04 | 0.518 |          11 |             25 |            0 |
| hermes   | 25 |   0.04 | 0.480 |          11 |              8 |           17 |
| openclaw | 25 |   0.04 | 0.505 |          11 |              4 |           21 |

Score-bucket distribution:

| Agent    | 0.20 | 0.30 | 0.50 | 0.80 | 1.00 |
|----------|-----:|-----:|-----:|-----:|-----:|
| eliza    |    1 |   13 |    0 |   10 |    1 |
| hermes   |   11 |    3 |    0 |   10 |    1 |
| openclaw |    4 |   10 |    0 |   10 |    1 |

The shape is identical across all three harnesses:
- **11 read-only scenarios** clear `state_hash_match=true` and land at
  0.80–1.0. All three harnesses match exactly the same 11.
- **14 write-op scenarios** miss state_hash and pile up at 0.20–0.30
  (state=0, action=partial-name-match=0.5 → 0.4×0.5=0.20, plus 0.1 if a
  substring matches).
- The single 1.0 is `calendar.next_event_today` (read-only, substring
  `"tomorrow"` happens to be in the agent's reply for all three).

Eliza wins on mean by 0.013 over openclaw and 0.038 over hermes — this gap
is entirely from eliza's `term=max_turns` behavior: it keeps emitting more
candidate actions across turns, so it has more chances to hit the
`name=CALENDAR(subaction=create_event)` partial-name match. Hermes and
openclaw give up after 1–3 turns with a verbal "I couldn't find the event",
which leaves them stuck at the bare 0.20 floor (substring-only match).

**No scenario was passed by only one harness.** The biggest cross-agent
score-spread on any scenario is 0.10, driven by eliza's
`max_turns`/`respond` asymmetry. The three harnesses agree on which 11
scenarios are easy and which 14 are hard.

## 3. Five representative scenarios

### 3.1 All three passed at 1.0: `calendar.next_event_today`

Trivial read-only. All three emit `CALENDAR_NEXT_EVENT({})` or equivalent
on turn 1, REPLY with "your next meeting is tomorrow at 10:00 AM...". The
substring `"tomorrow"` is in `required_outputs`. State unchanged →
state_hash_match=true → 0.5 + 0.4 + 0.1 = 1.0.

The only signal here: every harness correctly disambiguates a no-arg
read-action.

### 3.2 All three failed at 0.20–0.30: `calendar.cancel_dentist_appointment`

Ground truth: `CALENDAR(subaction='delete_event',
details={eventId:'event_00045', calendarId:'cal_primary'})`.

| Agent | T1 action | T2 action | Outcome |
|---|---|---|---|
| eliza | `CALENDAR(subaction=delete_event, title='dentist appointment')` | `CALENDAR(subaction=delete_event, title='Dentist Appointment')` | 6 turns, 0.30 (extra action-name credit) |
| hermes | `CALENDAR(subaction=search_events, query='dentist')` | (repeat) | 3 turns → "couldn't find", 0.20 |
| openclaw | `CALENDAR_SEARCH_EVENTS(query='dentist', time_range={start:'2023-01-01',end:'2025-12-31'})` | (repeat search) | 3 turns → "couldn't find", 0.20 |

All three miss the same thing: `delete_event` requires `details.eventId`,
and no agent ever calls `search_events` and *then* uses the returned
`event_00045` to delete. They either guess by title (eliza) or give up
after a failed search (hermes/openclaw). Openclaw's `time_range` shape
isn't even a valid kwarg.

### 3.3 Eliza-strongest: `calendar.create_dentist_event_next_friday`

Eliza, hermes, openclaw all score 0.30 / 0.20 / 0.30 — but eliza's
trajectory is illustrative. Across 6 turns it tries:
1. `CALENDAR(subaction=create_event, title, start, end, location, calendar='personal')` — wrong: `calendar` not `calendarId`, fields not in `details`.
2. `CALENDAR_CREATE_EVENT(title, start, duration_minutes, location)` — wrong: granular name uses same schema (still needs `details`), and snake-case `duration_minutes` instead of `durationMinutes`.
3. `CALENDAR_CREATE_EVENT(title, start_time, duration_minutes, location)` — wrong: `start_time` not in schema.
4. (repeat shape variation)
5. flat `{start, end, location}` again.
6. flat `{start, end, location}` again.

Eliza never *once* nests the time/calendar fields inside `details`, which
is what `_u_calendar` requires. Same root cause for hermes and openclaw:
the manifest's `details` description, while explicit, is buried at the end
of a very long parameter list; the planner consistently flattens.

### 3.4 Hermes-uniquely-cleaner: `calendar.reschedule_roadmap_sync_to_afternoon`

Hermes/openclaw both score 0.30 here, eliza 0.25. Hermes emits a single
`CALENDAR(subaction=update_event, details={eventId, start, end})` on turn 1
with the right *shape* — but the wrong eventId (it guessed from the title
without searching first). State hash misses, but the GT action-name +
discriminator + nested-details shape gets the kwargs-soft credit. Eliza
emits `new_start`/`new_end` (snake-case, top-level) for 8 turns.

This is the only failure where hermes/openclaw narrowly beat eliza, and
the reason is hermes's prompt template encourages a single concise tool
call rather than a planner-style multi-step retry.

### 3.5 Openclaw-uniquely-cleaner: `calendar.create_meeting_john_next_monday`

Openclaw 0.267, hermes 0.233, eliza 0.30 — all three failed. Openclaw's
turn 5 actually emits `CALENDAR(subaction=search_events, query='')` to
discover calendar IDs; in turn 8 it tries `CALENDAR_UPDATE_PREFERENCES`
to set `defaultCalendarId='work'`, which is creative but doesn't help.
No agent ever called `search_events` and used the returned IDs.

## 4. Harness behavior patterns

### 4.1 Eliza

- **Tool-call path**: forces the elizaOS planner through HTTP at
  `/api/benchmark/lifeops_bench/message`. The adapter (`eliza-adapter/
  eliza_adapter/lifeops_bench.py`) sends ONLY `last_user_text` per turn,
  not the full `MessageTurn` history. Tool results emitted by the Python
  runner's `_execute_action` are appended to bench history but never
  reach the eliza server — the eliza server has its OWN history.
- **Discriminator**: emits both umbrella `CALENDAR(subaction=create_event,
  ...)` and granular `CALENDAR_CREATE_EVENT(...)` interchangeably across
  turns of the same scenario. The scorer canonicalizes both forms (W4-A),
  so both paths get equal credit.
- **kwargs shape**: aggressively flat. Never nests in `details`. Uses
  snake_case (`duration_minutes`, `start_time`, `new_start`, `old_day`,
  `preferred_meeting_hours`, `daily_blackout`) — all rejected by the
  Python executor.
- **Termination**: ALWAYS emits a tool_call along with REPLY; never sends
  a tool-call-free turn → bench loop always burns to `max_turns`. This
  gives eliza extra retry attempts and a small action-name partial-credit
  edge over hermes/openclaw, but it's a *symptom* of the planner not
  treating execution as terminal.

**Characteristic failure modes:**
1. Flat `start`/`end`/`calendarId`/`eventId` at top level instead of nested
   in `details` (every single create/update/delete trajectory).
2. snake_case args (`start_time`, `duration_minutes`,
   `preferred_meeting_hours`) when the schema is camelCase / specific
   (`durationMinutes`, `preferredStartLocal`).
3. Never searches to resolve `eventId` before update/delete — hallucinates
   the event by title instead.

### 4.2 Hermes

- **Tool-call path**: native OpenAI `tool_calls` field via OpenAI-compat
  endpoint (Cerebras). The Hermes adapter threads the FULL history
  including assistant `tool_calls` and `role="tool"` results back to the
  model (`hermes-adapter/hermes_adapter/lifeops_bench.py::
  _history_to_openai_messages`).
- **Finalizes correctly (W1-10 fix verified)**: emits a tool call on
  turn 1, gets the tool result back, and in turn 2 emits a plain
  assistant message with no tool_calls → bench loop terminates with
  `respond`. 17 of 25 calendar scenarios terminate this way for hermes.
- **Pattern**: prefers SINGLE-shot. Right shape, wrong content (e.g.
  `CALENDAR(subaction=propose_times, details={duration_minutes,
  date_range:{start,end}, participants, num_options})` — nests under
  `details` for propose_times, where the schema wants top-level
  `windowStart`/`windowEnd`/`durationMinutes`).
- **System prompt**: a single-line "You are running LifeOpsBench. Use the
  supplied tools exactly when they are needed, and keep responses
  concise." — no shape guidance.

**Characteristic failure modes:**
1. Over-nests: wraps propose_times args inside `details`, exact opposite
   of the manifest's instruction. The manifest description includes
   ridicule-tone "Do NOT wrap propose_times args inside a `details`
   object" but Hermes ignores it.
2. Gives up after 2 turns with "I couldn't find that event" instead of
   trying another shape (which is what hermes is *supposed* to do — but
   the early-stop loses retry chances eliza gets accidentally).
3. snake_case args even though the OpenAI tool schema is camelCase
   (matches eliza's mode — both are downstream of gpt-oss-120b's bias).

### 4.3 OpenClaw

- **Tool-call path**: `<tool_call>{"tool":"NAME","args":{...}}</tool_call>`
  XML wrappers; parser has a brace-balanced fallback for unclosed tags
  (W1-11 fix). I see zero unclosed-tag failures in this run — the parser
  recovers every block.
- **Discriminator confusion**: emits granular `CALENDAR_CREATE_EVENT`
  with a redundant `subaction: 'create_event'` AND `CALENDAR` umbrella in
  alternating turns — same scenario, both forms. Scorer canonicalizes
  both, so no penalty.
- **Reasoning prose leaks**: each turn's `agent_message` starts with
  prose like `"We need to find the event.We should search.Search calendar
  for dentist.We'll call CALENDAR_SEARCH_EVENTS"` then the tool_call.
  Cute but harmless.
- **Hallucinated IDs**: `event_12345` appears for the cancel_team_sync
  scenario — invents an event_id without searching.

**Characteristic failure modes:**
1. Hallucinated `event_id` values (e.g. `event_12345`) instead of
   searching first.
2. Same nest/flat confusion as eliza — flat `start`/`end`/`location` at
   top level.
3. `time_range` kwarg with natural-language bounds (`"next Monday 23:59"`)
   — not a schema-valid type.

## 5. Eliza improvement plan

### 5.1 Action coverage gaps

The 25 calendar scenarios touch 8 distinct subactions, all of which exist
in the manifest. There's NO missing subaction. The gap is entirely
*kwarg-shape*. However:

- **`CALENDAR_DELETE_EVENT` granular shape vs `CALENDAR(subaction=delete_event)`**:
  the runner's `_u_calendar` requires `details.eventId` for delete, but
  every `CALENDAR_DELETE_EVENT(title=...)` call from a granular path
  bypasses `details` entirely. The promoted granular form should either
  (a) accept `eventId` at top level when subaction is delete/update, or
  (b) be removed from the manifest so the planner only sees the umbrella
  form. Today the granular form is misleading: it suggests a flat shape
  but the executor requires nested.

- **No `discover-calendar-ids` action**: the planner can call
  `search_events` to discover events, but there's no first-class way to
  list calendars (cal_primary, cal_family, cal_work). Several scenarios
  ("on my personal calendar", "on my family calendar") fail because the
  planner guesses `calendar='personal'` instead of `calendarId='cal_primary'`.
  Either expose a `CALENDAR(subaction='list_calendars')` action OR have
  the system prompt enumerate the seeded calendarIds.

- **Similes overlap with `LIFE_FOCUS_BLOCK`**: per
  `action-collisions.md`, `CREATE_CAL`/`SCHEDULE` similes collide with
  focus-block creation. Not a calendar-bench problem today (focus blocks
  don't surface here), but flag for cross-domain regression.

### 5.2 Manifest description tightening

The single biggest lever. Three fixable description bugs:

1. **Discriminator-field name mismatch.** The schema property is named
   `action` (enum: feed|next_event|...|update_preferences) but the runner,
   ground-truth, and `details.description` all use `subaction`. The
   planner emits `subaction` because the description and examples say
   so; but a model that obeys the schema strictly would emit `action`
   and break. Rename the schema property from `action` to `subaction`
   everywhere (or accept both at the runner level — currently only
   `subaction` is read via `_required(kw, "subaction", ...)`).

2. **Granular `CALENDAR_CREATE_EVENT` etc. publish the same schema as
   `CALENDAR` umbrella.** This is confusing: the granular name implies a
   focused shape, but it still demands `details: {...}`. Either author a
   separate, *granular* parameter schema for each
   `CALENDAR_<SUBACTION>` (one flat shape per subaction — e.g.
   `CALENDAR_CREATE_EVENT(title, calendarId, start, end, location,
   attendees, description)`) and have the manifest exporter emit those,
   OR remove the granular forms from the manifest and require everyone
   to use `CALENDAR(subaction=...)`. The current half-step misleads.

3. **Description is way too long.** The `details` property description
   crams 6 examples and one anti-pattern into a single 900-char string.
   The planner has demonstrably not been reading it (every eliza
   trajectory ignores the `Do NOT wrap propose_times args inside a
   details object` warning). Break it into:
   - Top-level: 1-line "what is this subaction".
   - Per-subaction concrete schema (use anyOf / oneOf with `subaction`
     as the discriminator and per-branch required fields).
   - Drop the "Example: { subaction: ... }" prose entirely once the
     schema enforces it.

### 5.3 Planner prompt (server-side)

The server-side prompt that gpt-oss-120b receives is opaque from this
audit (the eliza adapter is HTTP-only), but the bench-server handler
at `eliza/packages/app-core/src/benchmark/lifeops-bench-handler.ts`
constructs the planner invocation. Concrete recommendations:

- **Inject a "you are in benchmark mode" preamble** that says: "Calendar
  CRUD subactions (create/update/delete_event) require a nested
  `details: {...}` object. Top-level kwargs are ignored for those
  subactions. For propose_times, check_availability, and
  update_preferences, all kwargs MUST be top-level — do NOT wrap in
  `details`. Use the manifest schema exactly."
- **Inject the seeded calendar IDs** (`cal_primary`, `cal_family`,
  `cal_work`) as a system-prompt fixture. Today the planner guesses
  `calendar='personal'` because it has no way to know the seeded
  catalog.
- **Require a `search_events` round-trip before delete/update**. Either
  prompt-side ("If you don't know the eventId, search first and use the
  returned id") or runner-side (return a structured "events found"
  payload that the agent can cite verbatim).

### 5.4 Runtime layer

- **Tool-result feedback is broken for eliza.** The bench runner appends
  `role="tool"` MessageTurn entries with the executor result, but the
  eliza HTTP adapter only forwards the most recent USER turn. When the
  agent emits tool_calls and no user reply follows, eliza re-receives the
  ORIGINAL instruction with no diff — so the planner has no signal that
  its previous shape was rejected. Fix one of:
  - Forward the executor `error` payload back as a user-role "tool result"
    string the agent can read (matches what hermes does).
  - Have the eliza bench server include the prior tool-result as
    `context.last_tool_result` on the next `/message` call and have the
    planner prompt include it explicitly.
- **Reply-format constraint**: eliza always emits both a tool_call AND a
  REPLY action, which means it never terminates via `respond`. Hermes
  terminates after 1–2 turns. Adding a system-prompt rule "Do NOT emit
  REPLY in the same turn as a CALENDAR write subaction; wait for the
  tool result first" would let eliza burn fewer turns and converge on
  successful shapes faster.

### 5.5 Tool-selection accuracy

- **Granular over umbrella oscillation.** Eliza alternates between
  `CALENDAR(subaction=delete_event, ...)` and `CALENDAR_DELETE_EVENT(...)`
  across turns of a single scenario. The scorer accepts both (W4-A), but
  it suggests planner-level confusion: the retrieval funnel surfaces
  both, and ranking ties get re-broken nondeterministically. Recommend:
  - Demote `CALENDAR_<SUBACTION>` variants in the retrieval index (push
    them to a lower priority bucket) so the planner sees one canonical
    form. Or
  - Remove them from the manifest entirely (forces planner to use the
    umbrella). The granular variants only exist as a UX/clarity prop —
    benchmarks would be cleaner without them.

- **REPLY shadows tool action.** Many turns emit `REPLY` alongside the
  CALENDAR action. Strong similes on REPLY ("answer", "respond", "tell")
  shouldn't fire when a write-op is pending. Audit `app-lifeops` REPLY
  similes for terms that might over-trigger on phrases like "cancel my
  appointment" (where the user wants action, not chat).

## 6. Hermes / OpenClaw harness improvements

### 6.1 Hermes

- **System prompt is one line.** Hermes's lifeops adapter ships a
  single-sentence prompt: "You are running LifeOpsBench. Use the
  supplied tools exactly when they are needed, and keep responses
  concise." It does NOT mention the `details` nesting rule, the
  propose_times-top-level rule, or the seeded calendar IDs. Replace with
  a short bench-aware preamble:

  ```
  You are running LifeOpsBench. All times are UTC ISO-8601 anchored to
  2026-05-10T12:00:00Z. Calendar write subactions (create_event,
  update_event, delete_event) require a NESTED `details` object with
  `eventId`/`calendarId`/`start`/`end`. propose_times, check_availability,
  and update_preferences require TOP-LEVEL fields (windowStart, windowEnd,
  durationMinutes, slotCount, startAt, endAt, preferredStartLocal,
  preferredEndLocal, blackoutWindows). Calendars: cal_primary,
  cal_family, cal_work. Search by event title BEFORE updating/deleting
  — never invent an event_id.
  ```

  Same preamble would also help openclaw and eliza.

- **Hermes terminates too early on negative results.** When search
  returns 0 events, hermes immediately sends "I couldn't find it." A
  retry prompt ("If search returns 0, try fuzzy_match or broaden the
  time range") would close the gap on cancel/reschedule scenarios.

### 6.2 OpenClaw

- **Zero unclosed-tag failures** in this run — W1-11 fix is holding.
- **Reasoning prose pollutes assistant_message.** OpenClaw emits the
  model's chain-of-thought ("We need to find the event…") as
  `agent_message`. This is harmless to scoring (substring matches
  ignore non-required prose) but adds noise to trajectories and slightly
  inflates output_tokens. Recommend stripping the pre-tool-call prose
  in `parse_openclaw_tool_calls()` and returning only the
  post-tool-call content as `agent_message`.
- **Hallucinated event IDs**: openclaw is the only harness that emits
  literal placeholders like `event_12345`. Could be mitigated by the
  same "search before write" prompt fix above. Detection-side: the
  scorer/runner could mark any `event_id` that doesn't match `event_
  [0-9]{5}` as a hard fail before executing — this would surface the
  bug faster than waiting for a state-hash mismatch.

## 7. Cross-cutting recommendations

- **Scorer**: don't add more leniency. The current scorer (post-W4-A)
  already gives 0.5 partial credit for name-only matches; making it
  more lenient would devalue successful writes. Instead, tighten the
  `_kwargs_match` rule to require that the discriminator subaction
  field be **strictly present** for write subactions, otherwise force
  0.0 action_score. Today an agent that emits
  `CALENDAR(subaction=create_event, title='X')` gets 0.5 even though
  no real CRUD happens.

- **Manifest export**: stop publishing the granular `CALENDAR_<SUB>`
  forms in the OpenAI tool list. The scorer's `_canonicalize_action`
  proves both forms collide on score anyway, and keeping only the
  umbrella form removes one degree of planner confusion. Mirror the
  fix for MESSAGE (`MESSAGE_SEND`/`MESSAGE_DRAFT_REPLY` etc.).

- **Manifest schema**: convert `CALENDAR.parameters` to an explicit
  discriminated union (`oneOf` keyed on `subaction`) so the planner's
  JSON-schema layer enforces "details required for create/update/delete"
  / "top-level windowStart for propose_times". Today the schema accepts
  any shape and the runner rejects at execution time; the planner
  doesn't see the rejection.

- **Scenario authoring rubric**: add to `_authoring/spec.md` a
  required "list the exact action kwarg keys here" section per
  scenario template, plus a unit-test that validates GT kwargs against
  the manifest property schema. Several existing GT entries already
  diverge from the schema (`new_start`/`old_day` would never validate),
  but they happen to live in dead-end retries — a tighter rubric stops
  this from creeping into new scenarios.

- **Bench server**: in
  `lifeops-bench-handler.ts::applyAction`, the action name `CALENDAR`
  is passed directly to `LifeOpsFakeBackend.applyAction` which only
  knows dotted names like `calendar.create_event`. Every CALENDAR call
  from the eliza path therefore raises `LifeOpsBackendUnsupportedError`
  even when the agent emits a perfect kwargs shape. Add a translation
  layer (umbrella `CALENDAR(subaction=X)` → `calendar.X` →
  `LifeOpsFakeBackend` method) — without this fix, the eliza harness
  CANNOT mutate world state regardless of how good the planner is. This
  is the single highest-impact bug.

- **Tool-result feedback for eliza**: ensure the eliza bench server
  echoes the prior turn's `tool_calls[].error` back to the planner
  prompt on the next message. Today the planner is blind to its own
  rejected calls.

- **Headline measurement**: today's `term=respond` vs `max_turns` split
  hides that eliza is artificially elevated by its inability to
  terminate. Either (a) penalize tool-call-with-REPLY-on-same-turn or
  (b) cap the action_score to 0 when the run terminates with
  `max_turns` AND zero successful tool executions. Otherwise eliza
  looks "better" than hermes purely on retry-volume.
