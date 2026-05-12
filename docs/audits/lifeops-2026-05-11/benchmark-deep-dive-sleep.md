# Sleep benchmark deep-dive — W5-slp

> Sources:
> - TypeScript scenarios: `test/scenarios/lifeops.sleep/` (9 scenarios — 8 W2/W3 additions + 1 prior multi-source-conflict) and the cross-domain `test/scenarios/lifeops.calendar/calendar.sleep-window-defense.scenario.ts`.
> - Python LifeOpsBench corpus: `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/sleep.py` (29 STATIC) + `scenarios/live/sleep.py` (~40 LIVE).
> - Saved run filter `^sleep\.`: **no per-harness run JSON exists for the sleep filter** in `packages/benchmarks/lifeops-bench/lifeops_bench_results/` — the three persisted runs are all smoke/calendar/mail seeds. Per the W5-slp brief ("Smoke ≤10 if no data"), this audit is therefore a **static analysis of the scenario corpus and the runtime/scorer surface**, not a per-harness pass-rate report.
> - Reference template: `benchmark-deep-dive-calendar.md` (W5-cal).
>
> Runtime / scorer / manifest evidence is pulled live from this branch (`shaw/more-cache-toolcalling`).

---

## 1. What this benchmark tests

The sleep benchmark exercises four distinct action surfaces — there is **no
`SLEEP` umbrella**. Sleep operations are dispersed across:

| Action umbrella     | Used for                                                             | Manifest source                                                                |
|---------------------|----------------------------------------------------------------------|--------------------------------------------------------------------------------|
| `LIFE_CREATE`/`LIFE_UPDATE`/`LIFE_DELETE`/`LIFE_SKIP` (`kind=alarm`/`definition`) | Bedtime, weekday/weekend bedtime, wake-up, nap alarms; skip/disable a night | `app-lifeops/src/actions/owner-surfaces.ts` (mapped onto generic `LIFE` shape via `makeOwnerLifeAction`) |
| `SCHEDULED_TASK_CREATE`/`SCHEDULED_TASK_UPDATE`/`SCHEDULED_TASK_SNOOZE` (`kind=reminder`, `trigger.kind=once|daily`) | Wind-down sessions, nap reminders, sleep-coach prompts                | `plugin-scheduled-tasks` (promoted into the LifeOps manifest exporter)         |
| `CALENDAR` (`subaction=search_events`)                                                              | Late-night conflict discovery against `cal_primary`/`cal_family`/`cal_work` | `app-lifeops/src/actions/calendar.ts`                                          |
| `HEALTH` (`subaction=by_metric|summary|trends`)                                                     | Read sleep_hours / sleep_quality trends over 3/7/30/90-day windows    | `app-lifeops/src/actions/health.ts`                                            |

Inside `LifeOpsService` (`plugins/app-lifeops/src/lifeops/service-mixin-sleep.ts`),
the sleep domain itself exposes `getSleepHistory`, `getSleepRegularity`, and
`getPersonalBaseline`, all backed by `app_lifeops.life_health_sleep_episodes`
rows. The scenarios in `lifeops.sleep/*` seed that table directly via
`executeRawSql` to control the world.

### Scoring (`scorer.py`)

```
STATIC = 0.5 × state_hash_match + 0.4 × action_score + 0.1 × substring_score
LIVE   = 0.7 × state_hash_match                       + 0.3 × substring_score
```

`HEALTH` calls are **read-only no-ops** in the Python runner
(`runner.py:1046 _u_health` returns `{"subaction":..., "ok": True, "noop": True}`
without consulting `metric` or `days`). Every sleep scenario whose ground
truth is `HEALTH(...)` therefore matches `state_hash` trivially (the world
doesn't change). All the discrimination happens through:

- `action_score` (name + kwargs canonicalization in
  `scorer._kwargs_match` — name-only match is worth 0.5; full match 1.0),
- `substring_score` (10% — `required_outputs` like `['sleep','7:00','wake‑up']`).

`LIFE_CREATE`/`LIFE_UPDATE`/`LIFE_DELETE`/`LIFE_SKIP` and
`SCHEDULED_TASK_*` *do* mutate `LifeWorld` (via `_u_life_create`,
`_u_scheduled_task_create`), so for the 17 mutating Python scenarios the
state hash is the dominant signal — and there the planner has to nest under
`details` and pick the right `kind`/`cadence`/`trigger.kind` to be correct.

### TS scenario corpus (the 9 files this wave authored / preserved)

| File                                                       | What it checks                                                                | Failure-mode guarded                                                                  |
|------------------------------------------------------------|-------------------------------------------------------------------------------|---------------------------------------------------------------------------------------|
| `sleep.apple-vs-oura-conflict`                             | `HEALTH` + custom predicate + judgeRubric — both providers and at least one of 7h/8h surfaced | Silent averaging (7.5h) or silently dropping a provider                              |
| `sleep.oura-vs-apple-conflict-trust-policy`                | `HEALTH` + custom — agent picks Oura 8h when user states "I trust Oura more"  | Trust statement ignored; agent stays neutral instead of obeying explicit preference   |
| `sleep.nap-night-disambiguation`                           | `HEALTH` + custom — 30-min nap + 7h night → reply must NOT contain `"7.5"` or `"7 and a half"` | `is_main_sleep` filter dropped; nap gets summed into nightly total                    |
| `sleep.late-night-vs-schedule-conflict`                    | Custom — 4h sleep last night + 7am standup; morning checkin must surface "sleep" / "rest" / "tired" / "4 hour" | Agent gives a generic checkin and never wires sleep debt to the early meeting        |
| `sleep.sleep-window-protection-enforcement`                | Custom — "schedule a 6am call" must elicit pushback (`"early"/"sleep"/"later"/"after"/"wake"/"9"`) | Agent silently books before wake-up                                                   |
| `sleep.bedtime-reminder-90min-before`                      | `definitionCountDelta(title="Wind down", aliases [...], delta=+1, requireReminderPlan=true)` | Two-turn confirm flow misses the persistence write or fails to create a recurring plan |
| `sleep.wake-up-alarm-cascade`                              | `definitionCountDelta` for 7:00/7:05/7:10 weekday wake-up                     | Three-slot cascade collapsed to one alarm                                              |
| `sleep.travel-jet-lag-adjustment`                          | Custom — "I landed in Tokyo from SF" → reply must mention `gradual/hour/over/light/morning/shift` | Agent prescribes "sleep at 11pm Tokyo" immediately, ignoring 17h jet-lag             |
| `sleep.health-goal-grounding-weekly-review`                | Seeds goal `"Sleep 8 hours per night"` + 7 nights of 6h sleep, custom — weekly review must flag under-target | Agent reports "8h goal" without grounding against the data                            |

### Python STATIC corpus (29 scenarios in `scenarios/sleep.py`)

Subaction distribution:

| Umbrella + subaction                                | Count | Mutates LifeWorld? |
|-----------------------------------------------------|------:|--------------------|
| `LIFE_CREATE` (alarm definitions — bedtime/wake/nap)|   8   | yes                |
| `LIFE_UPDATE` (move time, disable a date range)     |   2   | yes                |
| `LIFE_DELETE` (nap alarm)                           |   1   | yes                |
| `LIFE_SKIP` (skip one occurrence)                   |   1   | yes                |
| `LIFE` (list)                                       |   1   | yes (writes counter)|
| `SCHEDULED_TASK_CREATE` (wind-down / nap reminder)  |   5   | yes                |
| `SCHEDULED_TASK_UPDATE` (move start time)           |   1   | yes                |
| `SCHEDULED_TASK_SNOOZE`                             |   1   | yes                |
| `CALENDAR` (`search_events` — family/work/primary)  |   3   | no                 |
| `HEALTH` (`by_metric`/`trend` — sleep_hours/quality)|   5   | no                 |
| `HEALTH` (`delete_metric` — sleep_quality)          |   1   | **GT-only, no executor — see §5.1** |

Read-only:write-op split = **8 : 21**, so 72% of the Python corpus needs a
clean `state_hash_match`. That makes nesting / `kind` / `cadence` /
`trigger.kind` correctness the dominant axis — same as calendar.

### Python LIVE corpus (`scenarios/live/sleep.py`, ~40 scenarios)

All `ground_truth_actions=[]` / `required_outputs=[]`, so scoring collapses
to **`0.7 × state_hash + 0.3 × 1.0`** — i.e. **0.3 floor** when the model
correctly does nothing destructive, plus state-hash credit if it executes
a recognized world-mutating action that matches `world_assertions`. The
LIVE coverage is good (jet-lag, shift work, marathon training, DST,
caregiver night-shift, partner-coordination, new-baby) but the world
assertions are written in prose ("a new reminder titled containing 'sleep
review'") which the scorer doesn't parse today — they are reviewer hints,
not executable checks.

---

## 2. Per-harness headline

No saved per-harness sleep run exists. Inferences below come from (a) the
calendar deep-dive's harness profile (same model, same adapters, same
runner), (b) the action-collision report, and (c) the runtime evidence in
`service-mixin-sleep.ts` and `parseHealthSleepEpisodes`. I am explicit
where this is a projection rather than a measurement.

Projected headline (sleep STATIC, 29 scenarios, gpt-oss-120b):

| Agent    | Likely pass@1 | Likely mean | Why                                                                            |
|----------|--------------:|------------:|--------------------------------------------------------------------------------|
| eliza    |     ~0.10 | ~0.55 | Same `term=max_turns` retry-volume edge; HEALTH no-ops inflate state_hash on read scenarios |
| hermes   |     ~0.10 | ~0.50 | Single-shot tool-calling; correct nesting more often, early-stops on negative reads |
| openclaw |     ~0.10 | ~0.52 | Reasoning-prose preamble; recovers tag closure but hallucinates `task_00001` style IDs |

The 5 HEALTH-read scenarios + 3 CALENDAR-search scenarios = **8 trivial
state_hash matches** for every harness (~0.5 floor before action/substring
credit). The 21 mutating scenarios then fan out the same way calendar
does: shape-correct hits a 1.0, shape-wrong hits 0.20–0.30.

**Cross-harness agreement** should be high: the failure modes are not
about reasoning capacity but about kwarg shape (`details` nesting,
`trigger.kind`, snake_case vs camelCase), which all three harnesses share
because they're all downstream of the same gpt-oss-120b biases.

---

## 3. Five representative scenarios

### 3.1 Easy across the board: `sleep.find_calendar_conflict_with_bedtime_window`

Read-only `CALENDAR(subaction=search_events, details={windowStart, windowEnd})`.
World unchanged → `state_hash_match=true` → 0.5 floor. Required substring
`"bedtime"` lands trivially because every agent reply to a "what's on my
calendar tonight after 10pm" prompt includes the word.

Signal here: **none**. Every harness gets ~0.9 with no real work because
HEALTH/CALENDAR-search both no-op the world. This is the same pattern
calendar identified as score inflation: read-only scenarios mask harness
quality.

### 3.2 Hard across the board (projected): `sleep.apple-vs-oura-conflict`

This is a TS-only scenario; the Python corpus has no multi-source
disambiguation test. The seed inserts TWO rows into
`app_lifeops.life_health_sleep_episodes` for the same night
(`apple_health`/`oura`), then asks "How much did I sleep last night?".

Root-cause friction: `plugin-health/src/sleep/sleep-cycle.ts:285-287`
dedupes by `asleepAt:end_at` and hard-codes `source: "health"` —
**provider provenance is lost** before the agent ever sees the data.
Even a perfect planner can't surface "Apple vs Oura" because
`parseHealthSleepEpisodes` collapses both rows into a single
`source="health"` cycle. The custom checker (`checkAgentSurfacesBothSources`)
therefore fails not because the model is dumb but because the upstream
pipeline never makes both providers visible.

Expected behavior across harnesses:
- eliza/hermes/openclaw all emit `HEALTH(subaction=by_metric, metric='sleep_hours', days=1)` → planner sees a single sleep cycle (post-dedup) → reply says "you slept about 7-8 hours" without provenance → custom checker fails on missing `apple|oura` substring.
- The judgeRubric (threshold 0.7) likely awards 0.5 because the reply is internally consistent — it just lacks provenance.

Net: this scenario tests a system gap, not a planner gap. The fix is in
`plugin-health/src/sleep/sleep-cycle.ts`, not in the model.

### 3.3 Eliza-strongest (projected): `sleep.create_morning_wakeup_7am`

Single-shot `LIFE_CREATE(subaction=create, kind=definition, title='Morning
Wake-up', details={kind:'alarm', cadence:'daily', timeOfDay:'07:00',
listId:'list_personal'})`. This is the cleanest shape in the Python
corpus: it's a `LIFE_CREATE` with `details` nesting and a single
discriminator. Eliza's retry-volume tendency hurts less here because
turn-1 emission is plausible:

- eliza: alternates `LIFE_CREATE(kind='alarm', timeOfDay='07:00')` (flat) vs `OWNER_ALARMS_CREATE(time='7am')` due to the OWNER_ALARMS/OWNER_REMINDERS retrieval collision flagged in `action-collisions.json`. 6-8 turns; partial-name credit gets ~0.30-0.50.
- hermes: single-shot `LIFE_CREATE` with the right nesting; lands ~0.5-1.0.
- openclaw: same as hermes shape but with `subaction:'create_event'` typo carried over from calendar habits — partial credit.

### 3.4 OWNER_ALARMS / LIFE_CREATE collision: `sleep.set_bedtime_reminder_1030pm_daily`

GT = `LIFE_CREATE(... title='Bedtime', details={kind:'alarm', cadence:'daily',
timeOfDay:'22:30'})`. From `action-collisions.json` row pair
`OWNER_ALARMS@owner-surfaces.ts:265.description` ↔
`OWNER_REMINDERS@owner-surfaces.ts:235.description`:

```
OWNER_ALARMS: "Owner alarms: create, update, delete, complete, skip, snooze, or review alarm-like reminders."
OWNER_REMINDERS: "Owner reminders: create, update, delete, complete, skip, snooze, or review one-off and recurring reminders."
```

Both descriptions claim "alarm-like reminders" / "recurring reminders" so
the retrieval funnel surfaces both. The planner reasonably picks
`OWNER_ALARMS_CREATE` for "bedtime alarm", but the GT is `LIFE_CREATE` —
so `_kwargs_match` falls through to name-only-match (0.5). State hash
*should* still match because `_u_life_create` and `OWNER_ALARMS_CREATE`
both route through the same LifeWorld mutation path… **but the scorer
doesn't canonicalize `OWNER_ALARMS_CREATE → LIFE_CREATE`**, so the
action-name partial-match drops to 0.0. Expected score: 0.5 + 0.4×0.0 +
0.1×1.0 = 0.6, not 1.0.

This is the single biggest cross-cutting tax in the sleep corpus and is
exactly the calendar `CALENDAR_<SUB>` story repeating itself.

### 3.5 Window protection: `sleep.sleep-window-protection-enforcement` (TS)

The TS scenario seeds only
`seedMeetingPreferences({preferredStartLocal:'09:00', preferredEndLocal:'18:00'})`
— it does NOT seed `blackoutWindows`. The cross-domain
`calendar.sleep-window-defense` scenario does seed
`blackoutWindows: [{label:'Sleep', startLocal:'23:00', endLocal:'08:00'}]`,
which is the only thing the runtime's circadian/scheduling layer reads.

Concretely, `actions/schedule.ts:170-183` calls
`circadianContract.getCurrentSleepWindow({timezone})` and only fans that
into the prompt context. `actions/lib/scheduling-handler.ts:862` then
references "sleep windows, no-call hours, and other recurring scheduling
rules". Without seeded `blackoutWindows`, the agent has nothing to defend
against and the only thing it can do is pattern-match "6am" → "too early"
from training data alone.

So the sleep-domain version of window protection is a **lower-fidelity
duplicate** of the calendar-domain version. The custom check passes on a
keyword match (`early|sleep|later|after|wake|9`) which is loose enough
that a model with any common sense passes — but it doesn't certify that
the runtime actually enforced the window. Recommend either:

- Strengthen `sleep.sleep-window-protection-enforcement` to seed
  `blackoutWindows` and require a CALENDAR action emission, OR
- Delete it as redundant with `calendar.sleep-window-defense` and move
  the sleep domain's window-protection coverage entirely to the calendar
  test suite.

---

## 4. Harness behavior patterns

(Projected, calibrated against calendar deep-dive.)

### 4.1 Eliza

- **LIFE_CREATE shape habits**: same flat/nest confusion as calendar.
  `LIFE_CREATE` GT puts `kind`, `cadence`, `timeOfDay`, `listId` all
  inside `details`. Eliza's planner will flatten (`kind` at top level,
  `time_of_day` snake_case) and emit retries within the same scenario.
- **OWNER_ALARMS oscillation**: when the user says "bedtime alarm" or
  "wake-up alarm", the OWNER_ALARMS simile cluster (`ALARM`, `ALARMS`,
  `WAKE_ME`, `WAKE_UP`) fires before LIFE_CREATE. Eliza burns 3-4 turns
  oscillating between `OWNER_ALARMS_CREATE` and `LIFE_CREATE`.
- **CALENDAR for conflict discovery**: same `details` flat-vs-nested
  problem as calendar. `search_events` requires top-level
  `windowStart`/`windowEnd` (NOT inside `details`) per the python
  ground truth, but the LifeOps `CALENDAR` action manifest description
  says `details:{windowStart,...}` for search — there's a real schema
  inconsistency between runner and manifest that hurts all harnesses
  here. (Cross-ref: calendar deep-dive §5.2.3.)
- **HEALTH no-op happens to help**: HEALTH is read-only in both runner
  and manifest; eliza emits `HEALTH(subaction='by_metric',
  metric='sleep_hours', days=7)` cleanly and gets full state-hash credit
  even when the kwargs don't quite match GT.

**Characteristic sleep failure modes:**
1. Snake-case `time_of_day`/`day_of_week`/`skip_date` instead of camelCase.
2. `cadence='daily'` at top level instead of inside `details`.
3. Trigger shape for SCHEDULED_TASK: `trigger='daily 22:00'` (string)
   instead of `{kind:'daily', atIso:'2026-05-10T22:00:00Z'}`.
4. Splits the alarm cascade into three SCHEDULED_TASK_CREATE calls
   instead of one LIFE_CREATE with `dayOfWeek:[Mon..Fri]` and three
   `timeOfDay` entries — there is no canonical "cascade" shape in the
   manifest, so this is a *manifest gap* (see §5.1).

### 4.2 Hermes

- **Single-shot, correct enough**: hermes will more often than not put
  fields inside `details` because the OpenAI tool schema in the manifest
  declares `details` as a property with a description that says "typed
  fields go here". When it gets it right, state-hash matches and
  scenarios pass at 1.0.
- **Trust-policy scenario stays neutral**: the
  `sleep.oura-vs-apple-conflict-trust-policy` scenario asks the agent to
  obey "I trust Oura more". Hermes's one-line system prompt has no
  guidance on resolving multi-source conflicts; expect hermes to surface
  both numbers without preferring Oura, failing the custom
  `has8h && hasOura` check.
- **Jet-lag prose**: the `travel-jet-lag-adjustment` scenario asserts the
  reply mentions `gradual|hour|over|light|morning|shift`. Hermes
  responses tend to be too terse — they may pass the check if "morning"
  appears, but won't propose a concrete plan.

### 4.3 OpenClaw

- **`<tool_call>` parser unchanged from calendar**: brace-balanced
  recovery from W1-11 is still in effect; expect zero unclosed-tag
  failures.
- **Hallucinated task/alarm IDs**: just like calendar's `event_12345`,
  expect openclaw to invent `task_00001`/`alarm_42` for SCHEDULED_TASK
  snooze/update without listing first. The
  `sleep.snooze_winddown_10min` GT uses `taskId='task_00001'` — by sheer
  luck openclaw's invented IDs sometimes match this pattern, which inflates
  apparent pass rate on snooze scenarios.
- **Reasoning prose still leaks**: same chain-of-thought-in-
  `agent_message` story.

---

## 5. Eliza improvement plan

### 5.1 Action coverage gaps

1. **`HEALTH(subaction='delete_metric')` is GT-only.** The Python
   scenario `sleep.delete_sleep_quality_metric` asserts ground truth
   `HEALTH(subaction='delete_metric', metric='sleep_quality')`, but the
   manifest enumerates only `by_metric|summary|trends` and the runner's
   `_u_health` ignores `subaction` entirely. Either:
   - Add `delete_metric` to the manifest subaction enum AND wire it
     through `_u_health` to mutate a `world.health_metrics` registry, OR
   - Delete the scenario as not-supported (cleaner — `health` is meant
     to be read-only per the manifest description "Read health data
     without mutating state").

2. **No `LIFE_LIST` granular path.** The Python `sleep.list_all_sleep_alarms`
   GT uses `LIFE(subaction='list', kind='definition', title='Sleep Alarms')`.
   `LIFE` is listed in the manifest with subactions
   `create|complete|snooze|review|delete|update|skip` — `list` is not in
   that enum. The scenario therefore can never get a name + kwargs
   match. Add `list` to the LIFE enum, or change the GT to `LIFE_REVIEW`
   (which is the closest semantic match in the existing enum).

3. **`SCHEDULED_TASK` mutating subactions are dispersed.** The corpus
   uses `SCHEDULED_TASK_CREATE`, `SCHEDULED_TASK_UPDATE`,
   `SCHEDULED_TASK_SNOOZE` — but the runtime also exposes the umbrella
   `SCHEDULED_TASKS` plus granular `SCHEDULED_TASKS_CREATE`,
   `SCHEDULED_TASKS_UPDATE`, `SCHEDULED_TASKS_SNOOZE` (plural). Both
   forms are in the manifest. Scorer canonicalizes singular↔plural?
   Quick check: `scorer._canonicalize_action` does normalize a name
   prefix but the singular-vs-plural split was raised in W4-A and only
   partially fixed (it canonicalizes `_<SUB>` suffixes against the
   umbrella, not singular vs plural roots). Result: a planner emitting
   `SCHEDULED_TASKS_CREATE` against a GT of `SCHEDULED_TASK_CREATE` may
   get only 0.5 name credit. Recommend either removing the singular
   form from the manifest (the plural is the LifeOps canonical name) or
   teaching the scorer that
   `SCHEDULED_TASK(S)?(_<SUB>)?` → `SCHEDULED_TASK`.

4. **No multi-trigger / "alarm cascade" primitive.** The TS
   `sleep.wake-up-alarm-cascade` scenario asks for three alarms at
   7:00/7:05/7:10. The LIFE schema accepts a single `timeOfDay` (not an
   array), so the agent must emit three separate LIFE_CREATE calls. The
   scenario checks `definitionCountDelta(delta:+1, requireReminderPlan:true)`
   — i.e. it expects ONE definition with a reminder plan that covers all
   three triggers, not three definitions. The runtime
   (`OwnerRoutinesScheduleService`?) supports multi-trigger plans, but
   neither the manifest nor any python scenario exposes the kwarg shape
   that produces a multi-trigger output. This is a manifest gap with a
   test that effectively certifies behavior the planner can't produce
   from the schema alone.

5. **No "provider trust policy" primitive.** The
   `oura-vs-apple-conflict-trust-policy` TS scenario expects the agent
   to obey "I trust Oura more". There is no manifest action to set such
   a preference, and the runtime's
   `parseHealthSleepEpisodes` discards `provider` before reaching the
   reasoner. To make this scenario actually pass on signal rather than
   luck:
   - Preserve `source` (`apple_health`/`oura`/...) through
     `LifeOpsSleepEpisode` instead of hard-coding `source:"health"`.
   - Add a `HEALTH(subaction='set_provider_preference', metric='sleep_hours', provider='oura')` write action OR a per-turn override field on the HEALTH read.
   - Or downgrade the scenario to a comprehension test ("does the agent
     surface both sources and pick one") that doesn't require runtime
     state.

### 5.2 Manifest description tightening

1. **`LIFE_CREATE` description is one-liner**: "Create personal life
   records such as reminders, alarms, workouts, or health metrics. Use
   subaction=create and put typed fields in details." — better than
   calendar's wall-of-text, but it doesn't enumerate the `details`
   shape. The planner emits `cadence`/`timeOfDay`/`listId`/`note`
   correctly only when training data leaks through. Add a per-`kind`
   schema (alarm requires `cadence`/`timeOfDay`; reminder requires
   `trigger`; metric requires `metric`/`value`).

2. **OWNER_ALARMS vs LIFE_CREATE description collision**: from
   `action-collisions.json`, both
   `OWNER_REMINDERS@owner-surfaces.ts:235.description` and
   `OWNER_ALARMS@owner-surfaces.ts:265.description` say variants of
   "create, update, delete, complete, skip, snooze, or review". This is
   identical to LIFE_CREATE/UPDATE/DELETE/COMPLETE/SKIP/SNOOZE/REVIEW.
   Either:
   - Remove OWNER_ALARMS / OWNER_REMINDERS from the manifest (they're
     UX-tier aliases, not benchmark-tier actions), OR
   - Have `_canonicalize_action` in the scorer fold OWNER_ALARMS_* and
     OWNER_REMINDERS_* into LIFE_*. The state mutation path already
     converges (see `makeOwnerLifeAction` in `owner-surfaces.ts`).

3. **`SCHEDULED_TASK_CREATE.trigger` description**: the manifest
   property says "Include kind, trigger, promptInstructions, and other
   structured task fields when known." — there's no example. The
   planner habitually emits `trigger="daily at 10pm"` (string) instead
   of `trigger:{kind:'daily', atIso:'2026-05-10T22:00:00Z'}`. Add an
   anyOf for `trigger` with `kind: once|daily|weekly|cron`,
   `atIso: string` for once/daily, `dayOfWeek: string[]` for weekly,
   `cron: string` for cron.

4. **`HEALTH.subaction` enum vs reality**: manifest enumerates
   `by_metric|summary|trends` but the python `sleep.show_sleep_trends_last_90days`
   GT uses `subaction='trend'` (singular). The runner accepts anything
   (noop), but the scorer's `_kwargs_match` will see `trends!=trend` and
   drop to 0.5. Fix one place — either rename in scenarios or accept both.

### 5.3 Planner prompt (server-side)

Same recommendations as calendar deep-dive apply, plus sleep-specific:

- **Inject seeded list IDs**: every LIFE_CREATE GT uses `listId:'list_personal'`.
  The planner has no way to know that. Add to the bench preamble: "Lists:
  list_personal, list_family, list_work."
- **Tell the planner HEALTH is read-only and has no `delete_metric`**: the
  W2/W3 sleep scenarios include one scenario that wants a metric delete
  — until the manifest expands, the planner should reply that this
  isn't supported, not invent a fake action.
- **Multi-source disambiguation**: the prompt should say "When a sleep
  reading has multiple providers (apple_health / oura), surface both
  values + provider names rather than averaging or picking silently."
  Today the planner has zero guidance and silently averages, which is
  exactly what `checkAgentSurfacesBothSources` is designed to catch.

### 5.4 Runtime layer

- **Provider provenance loss** (the biggest sleep-domain bug):
  `parseHealthSleepEpisodes` hard-codes `source: "health"` on every
  output and dedupes by `asleepAt:end_at` — two providers reporting the
  same night with different durations collide on the dedupe key (or
  pass through as two cycles, depending on millisecond differences) and
  the agent never sees `apple_health`/`oura` names. Fix:
  - Propagate `signal.health.provider` / `signal.provider` into the
    `LifeOpsSleepEpisode.source` field.
  - Dedupe by `(provider, asleepAt, end)` not `(asleepAt, end)`.
  - When two providers report the same night, return both cycles and
    let the reasoner mark them as conflicting.

- **Tool-result feedback** (same as calendar): the eliza HTTP adapter
  only forwards the latest user text; SCHEDULED_TASK_CREATE that fails
  shape validation gets no error echo back to the planner.

- **`OWNER_ALARMS_CREATE` should canonicalize to `LIFE_CREATE` at the
  bench server**: in `lifeops-bench-handler.ts::applyAction`, route
  `OWNER_ALARMS_<SUB>` → `LIFE_<SUB>` before dispatch so state mutates
  even when the planner picks the alias.

### 5.5 Tool-selection accuracy

- **Demote OWNER_ALARMS / OWNER_REMINDERS** in the retrieval index for
  bench mode. The collision report (`action-collisions.md`) shows these
  alias LIFE_* and produce planner-level confusion specifically on
  alarms/reminders, which is most of the sleep corpus.
- **Same REPLY-alongside-tool problem** as calendar: a turn that says
  "Saved a bedtime alarm for 10:30pm" + emits LIFE_CREATE counts the
  state mutation but doesn't terminate; eliza burns retries.

---

## 6. Hermes / OpenClaw harness improvements

### 6.1 Hermes

- **One-line preamble doesn't cover sleep**: add to the hermes
  lifeops-bench adapter preamble:
  ```
  Sleep alarms use LIFE_CREATE(kind:'definition', details:{kind:'alarm',
  cadence:'daily'|'weekly'|'once', timeOfDay:'HH:MM', dayOfWeek:[...],
  durationMinutes, note, listId}). Wind-down and nap reminders use
  SCHEDULED_TASK_CREATE(kind:'reminder', trigger:{kind:'once'|'daily',
  atIso:ISO8601}, priority:'low'|'medium'|'high', promptInstructions,
  source:'user_chat'). HEALTH(subaction:'by_metric'|'summary'|'trends',
  metric:'sleep_hours'|'sleep_quality', days:N) is read-only. Lists:
  list_personal, list_family, list_work.
  ```
- **Multi-source conflict guidance**: same preamble should include "if
  multiple providers (apple_health, oura) report the same metric,
  surface both with provenance — do not average."
- **Trust-policy obedience**: hermes's terse style works against
  `oura-vs-apple-conflict-trust-policy`; it tends to drop "Oura" from
  the reply and just return a number. A "if the user states a
  provider preference, repeat the provider name verbatim in your reply"
  rule would help.

### 6.2 OpenClaw

- **Hallucinated `task_00001`-style IDs**: same fix as calendar
  hallucinated event IDs — require a SCHEDULED_TASKS_LIST round-trip
  before emitting a SNOOZE/UPDATE/CANCEL with a `taskId`. Today
  openclaw guesses IDs that happen to match the GT pattern, which
  inflates apparent quality.
- **Reasoning prose**: same cleanup as calendar.

---

## 7. Cross-cutting recommendations

- **Scorer canonicalization**: extend `_canonicalize_action` to fold
  `OWNER_ALARMS_<SUB>` and `OWNER_REMINDERS_<SUB>` into `LIFE_<SUB>` (the
  state mutation path is identical), and `SCHEDULED_TASKS_<SUB>` (plural)
  into `SCHEDULED_TASK_<SUB>` (singular) — or vice versa, pick one
  canonical. Today this discrepancy quietly halves action-name scores on
  every reminder scenario.

- **Manifest export**: drop OWNER_ALARMS and OWNER_REMINDERS from the
  bench-export filter (they're UX shadows of LIFE_*). Same rationale as
  the calendar deep-dive's recommendation to drop CALENDAR_<SUB>.

- **Provider provenance fix in `plugin-health`**: described in §5.4 — the
  single highest-impact change for the multi-source scenarios.

- **TS-only sleep corpus quality**: the 9 TS sleep scenarios test richer
  behavior (multi-source, trust policy, jet-lag prose, window protection)
  than the 29 Python scenarios, but they're locked behind a TypeScript
  scenario runner (`@elizaos/scenario-schema`) that is *not* the same
  harness as `lifeops-bench`. Two parallel test surfaces with different
  scoring rules and different schemas is the root of the confusion. Pick
  one — either port the TS scenarios into the Python corpus
  (`packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/sleep.py`)
  with the same harness, or move the Python sleep corpus into the TS
  scenario runner. Today the W2/W3 TS additions don't show up in any
  `lifeops_bench_results/` JSON.

- **Sleep-window protection consolidation**: as called out in §3.5, the
  TS `sleep.sleep-window-protection-enforcement` scenario duplicates
  `calendar.sleep-window-defense` with weaker seeds. Delete the
  weaker one or strengthen its seed to match.

- **DST / timezone-travel coverage**: the TS corpus has
  `sleep.travel-jet-lag-adjustment` (Tokyo from SF). The Python
  corpus has `sleep.set_bedtime_reminder_with_timezone` (Eastern).
  Neither tests the actual hard case: a sleep window that crosses a DST
  boundary mid-window (23:00 the night DST starts → 08:00 the morning
  after). The runtime's `getCurrentSleepWindow` uses the resolved IANA
  timezone, so this is testable. Adding one DST-boundary scenario
  would meaningfully improve coverage; today it's a known gap.

- **Sleep-stage detail**: the Python scenario manifest comment says
  "weak on sleep-stage detail" (REM / deep / light / awake). The
  scenarios test `metric='sleep_hours'` and `metric='sleep_quality'`
  but never query stage breakdown. The runtime persists
  `stage_samples_json` per episode (see
  `app_lifeops.life_health_sleep_episodes` schema) but no scenario
  exercises it. Add at least one scenario:
  `HEALTH(subaction='by_metric', metric='sleep_stages', days=1)` with
  GT asserting REM/deep/light proportions. Today the planner has no
  reason to learn the stage schema because nothing tests it.

- **Bedtime-reminder N-minutes-before primitive**: the TS
  `sleep.bedtime-reminder-90min-before` scenario expects a single
  definition with a `requireReminderPlan` that fires 90 minutes before
  bedtime. There is no first-class kwarg for "relative offset before
  another definition" in the LIFE schema — the planner has to either
  hard-code `timeOfDay:'21:00'` (assuming 22:30 bedtime) or chain a
  SCHEDULED_TASK to listen for the bedtime alarm. Neither produces the
  asserted `definitionCountDelta+1 with reminderPlan`. Add a
  `relativeTo:'definitionId', offsetMinutes:-90` shape to the LIFE
  schema, or relax the scenario assertion.

- **Headline measurement**: 8 of 29 sleep STATIC scenarios are HEALTH or
  CALENDAR-search reads that no-op the world. With 0.5 weight on
  `state_hash_match`, that's a guaranteed 0.5 floor per scenario × 8 ÷
  29 = **0.138 baseline** *per harness, without doing any real work*.
  Either tighten HEALTH's runner to actually consult `metric` (so a
  wrong metric → state hash mismatch) or down-weight read-only
  scenarios when computing headline scores.
