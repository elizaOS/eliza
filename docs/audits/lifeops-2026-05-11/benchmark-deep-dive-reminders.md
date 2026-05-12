# Reminders benchmark deep-dive — W5-rem

> Saved trajectory sources:
> - `~/.milady/runs/lifeops/lifeops-multi-tier-2026-05-12T03-14-04-023Z/large/{hermes,openclaw}/lifeops_gpt-oss-120b_2026*.json` — 1 reminders scenario each (after W4-D's manifest patch)
> - W1-9 (hand-noted in `eliza-tool-call-fix.md`) — eliza-side data point for the same scenario
> Scope: 36 static reminder scenarios are defined in
> `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/reminders.py`,
> but the **post-W4-D corpus runs only re-exercised
> `reminders.create_pickup_reminder_tomorrow_9am`**. The other 35 scenarios
> have not been re-run since W4-D's planner-disambiguation pass. All numbers
> below are read from those saved JSONs and the scenario file; no fresh
> bench was kicked off here (read-only, ≤60 tool calls).
> Conclusion is therefore **conservative**: where I generalize from one
> scenario to the corpus, I call it out.

## 1. What this benchmark tests

The reminders domain exercises the `LIFE_*` umbrella family
(`LIFE_CREATE`, `LIFE_COMPLETE`, `LIFE_SNOOZE`, `LIFE_REVIEW`,
`LIFE_DELETE`; `LIFE_UPDATE` / `LIFE_SKIP` exist but no static scenario
uses them) dispatched through the bench runner against a `LifeWorld`
seeded from `data/snapshots/medium_seed_2026.json`. 60 seed reminders
across three lists (`list_inbox`, `list_personal`, `list_work`); six are
overdue relative to the canonical `now_iso = 2026-05-10T12:00:00Z`.

Subaction breakdown of the 36 static scenarios
(`packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/reminders.py`):

| Ground-truth action | Count | Mutation? |
|---|---:|---|
| `LIFE_CREATE` | 12 | yes (creates `reminder_auto_<hash>`) |
| `LIFE_COMPLETE` | 7 | yes (marks `completed_at`) |
| `LIFE_DELETE` | 5 | yes (only when target is a real `reminder_*`) |
| `LIFE_SNOOZE` | 6 | yes (rewrites `due_at`) |
| `LIFE_REVIEW` | 6 | no — read-only no-op in the executor |

Read-only : write-op split = **6 : 30**, so 83% of the corpus needs a
clean state-hash match to score above 0.20–0.30.

Scoring (`scorer.py:382-412`, STATIC weighting): `0.5 × state_hash_match +
0.4 × action_score + 0.1 × substring_score`, plus a **triviality guard**
(`scorer.py:405-407`): if the agent emits zero structurally-matching
actions, both state and substring credit are zeroed. Substring matching
is liberal (NFKC + lower + time-equivalents in `scorer.py:200-243`).

### Expected wire shape (per `_u_life_create` in `runner.py:899-967`)

```
LIFE_CREATE({
  subaction: "create",               // top-level discriminator
  title:     "...",                  // TOP-LEVEL (flat)
  details: {                          // NESTED
    kind:     "reminder" | "alarm" | "workout" | "health_metric",
    listId:   "list_personal" | "list_work" | "list_inbox",
    due:      "ISO-8601",            // or due_at, both accepted
    cadence:  "daily" | "weekly" | "monthly" | "yearly",   // unscored
    timeOfDay: "HH:MM",              // unscored
  },
})
```

`_u_life_create` reads `title` from **top-level** kwargs only
(`kw.get("title")`) and falls back to literal string `"Untitled"`. It
reads `kind`, `listId`, `due` / `due_at` from `details` only — top-level
`time` / `type` / `datetime` are silently ignored. The created reminder
id is `reminder_auto_<sha256_12(t=title, l=listId, d=due, kind)>`. Two
runs with the same four inputs collide deterministically and produce a
matching world hash; any mismatch in any of the four breaks state-hash.

`cadence` and `timeOfDay` are **not** in the synthetic id and **not**
persisted on the `Reminder` row (see `lifeworld/world.py` →
`create_reminder` only accepts `reminder_id`, `list_id`, `title`,
`due_at`). The recurring-pill / weekly-team-sync / monthly-budget
scenarios therefore cannot score below state-hash on cadence semantics —
they only score on title, list, and (optionally) due. **The benchmark
silently passes recurring-reminder scenarios with no recurrence at all.**

## 2. Per-harness headline (1-scenario sample)

Only one reminders scenario has post-W4-D data, so this is a single
observation per harness, not a corpus-mean:

| Agent    | scenario | score | state_hash | term     | action emitted |
|----------|----------|------:|------------|----------|----------------|
| openclaw | `create_pickup_reminder_tomorrow_9am` | 0.30 | false | `respond` | `LIFE_CREATE { subaction: "create", details: { time, title, type: "reminder" } }` |
| hermes   | `create_pickup_reminder_tomorrow_9am` | 0.00 | false | `respond` | `LIFE { subaction: "create", details: { type: "reminder", title, datetime } }` |
| eliza    | `create_pickup_reminder_tomorrow_9am` | 0.30* | false | `respond`* | `LIFE_CREATE { subaction: "create", details: { title, time } }` |

*eliza row is taken from W1-9 hand-notes in
`eliza-tool-call-fix.md:124-148` — the saved post-W4-D run for
`large/eliza/` failed at aggregate stage (`SUMMARY.md` row: `FAILED
(failed)`) so I have no JSON of my own to cite.

The 0.30 = `0 × 0.5 (state) + 0.5 × 0.4 (action name match, kwargs mismatch
→ half credit per compare_actions:317-319) + 1.0 × 0.1 (substring
"uniforms" appears in reply) = 0.20 + 0.10`. Hermes scored **0.00**
because it picked the bare `LIFE` umbrella, not `LIFE_CREATE` — and the
scorer's `_UMBRELLA_SUBACTIONS` table in `scorer.py:89-120` **only**
canonicalizes CALENDAR and MESSAGE, not LIFE. So `LIFE != LIFE_CREATE`
under name comparison → `action_score = 0` → triviality guard zeroes
state + substring → final 0.

The 35 unrun reminder scenarios can't be tabulated. Based on the W4-D
note that "scores remain `null` for the eliza adapter", and the
arg-shape pattern visible in the openclaw + hermes single-shot, the
realistic ceiling without further fixes is **~0.30 mean** on the 30
write-op scenarios and **~0.80 mean** on the 6 read-only scenarios.

## 3. Did W4-D's manifest fix actually shift arg shape?

**No.** The patch is present (verified in
`packages/benchmarks/lifeops-bench/manifests/actions.manifest.json` — six
occurrences of the `TOP-LEVEL (flat) field. NEVER place title inside
details` string, on all `OWNER_REMINDERS_*` entries and on the second
`LIFE_CREATE` entry sourced from `@elizaos/lifeops-bench` at index 57
[lines 7096-7102]) but it does not reach the agent.

Three reasons:

### 3.1 The agent never sees the patched manifest

The bench runtime builds the agent's tool catalogue from
`runner.build_tool_manifest()` (`runner.py:273-301`), which uses
`_TOOL_DESCRIPTIONS` (line 153-207) and `_tool_parameters_for_action`
(line 245-270). That schema **only** declares the discriminator
property:

```python
schema["properties"] = { field: { type: "string", enum: values,
                                  description: f"LifeOps {action_name} discriminator." } }
schema["required"] = [field]
```

`title` and `details` are not in the runtime schema at all. The agent's
view of `LIFE_CREATE` is the bench description "Create personal life
records such as reminders, alarms, workouts, or health metrics. Use
subaction=create and put typed fields in details." (no flat/nested
hint) and a one-property schema requiring only `subaction`. The agent
free-styles every other kwarg.

The on-disk `manifests/actions.manifest.json` that W4-D patched is the
**corpus gate** manifest — it is consumed by `tests/test_budget.py` and
related corpus tests to verify every ground-truth action exists in the
plugin manifest. It is never injected into the agent's tool catalogue
during a real run.

### 3.2 OWNER_REMINDERS_* is not exposed at runtime

Even more surgically: `_ACTION_HANDLERS` in `runner.py:1345-1419`
contains no `OWNER_REMINDERS_*` keys. The CALENDAR_* granular forms are
promoted (`CALENDAR_CREATE_EVENT`, `CALENDAR_UPDATE_EVENT`, etc., lines
1411-1418), so the agent at runtime can pick either umbrella or
granular. The OWNER_REMINDERS family has no analogous promotion. So
**OWNER_REMINDERS_CREATE — the place where W4-D's hint sits — is in the
file but unreachable**. Both the W4-D scope note ("source `owner-
surfaces.ts` is out of scope; the JSON manifest was patched in place
across all 39 owner-surface entries that carried the old generic
strings") and `planner-disambiguation-fix.md:115-121` flag this as a
known stop-gap, but it surfaces here as the proximate cause of the
post-fix bench regression.

### 3.3 Duplicate manifest entries dilute even the on-disk hint

`jq '[.actions[].function.name] | group_by(.) | map(select(length > 1))'`
on the manifest produces 20 duplicate names, eight of them in the LIFE
family: `LIFE`, `LIFE_CREATE`, `LIFE_COMPLETE`, `LIFE_DELETE`,
`LIFE_REVIEW`, `LIFE_SKIP`, `LIFE_SNOOZE`, `LIFE_UPDATE`. Each LIFE_*
appears twice: once with `_plugin: "@elizaos/lifeops-bench"` (generated
by `manifest_export.augment_manifest` → carries the W4-D hint on
`LIFE_CREATE`'s `title`/`details`) and once with `_plugin:
"lifeops-bench"` (older/orphan entries — generic descriptions like
"Human-visible title" / "Structured action-specific details", no
TOP-LEVEL hint). The orphan entries are sorted into the manifest by
`augment_manifest`'s alphabetical sort (line 318), so when a downstream
tool reads the action list in order it sees the orphan first or
intermixed. Either entry is a valid OpenAI tool, so a strict consumer
would emit both copies into the agent's tool catalogue — except the
runtime doesn't read this file at all (§3.1), so the duplication is
inert from the planner's perspective. **It still confuses every corpus
test that joins ground-truth to manifest by name.**

### 3.4 Net effect on the 1 post-fix scenario

Openclaw emitted `details: { title, time, type: "reminder" }` —
identical to W2-9 → no observed behavioral change → confirms the patch
didn't reach the runtime tool catalogue, and the planner is still
free-styling. The W4-D claim of "Bug B title-shape half is fixed" was
true only for the CALENDAR umbrella (where the patch landed in
`plugins/app-lifeops/src/actions/calendar.ts`, which **is** read by the
TS exporter and propagates into the agent's view). For reminders, where
the patch only landed in the JSON manifest, nothing happened.

## 4. LIFE_CREATE vs OWNER_REMINDERS_* — which does the planner pick?

In every observed reminders trajectory, the planner picks `LIFE_CREATE`
(eliza, openclaw) or the bare `LIFE` umbrella (hermes). Never
`OWNER_REMINDERS_*`. The mechanism is plain:

- Eliza runtime: gets the bench tool catalogue (LIFE_CREATE) but can
  also see its own registered actions including OWNER_REMINDERS_CREATE.
  In the W1-9 observed trajectory it still picked `LIFE_CREATE`,
  presumably because LIFE_CREATE's bench description verb ("Create
  personal life records such as reminders…") is a closer keyword match
  to the user prompt than OWNER_REMINDERS_CREATE's compressed-form
  description ("owner reminders: action=create|update|...").
- Hermes/Openclaw: never have OWNER_REMINDERS_* available — the bench
  runtime tool catalogue is the only thing they see (`build_tool_manifest`
  reads `_ACTION_HANDLERS` keys, which omit OWNER_*).

So the OWNER_REMINDERS_* surface in `actions.manifest.json` is purely
descriptive (used by corpus gates, training datasets, and benchmark
docs) — it has zero runtime effect on agent behavior. The W4-D patch is
in the right file but it influences the wrong consumer.

## 5. Escalation ladder (in_app → SMS → voice) coverage

**Not in this benchmark.** Grep for "escalation" in
`packages/benchmarks/lifeops-bench`: hits are scenario instruction text
("customer escalation" as a thread topic in mail scenarios, an "Send
overdue invoice reminder" live scenario in
`scenarios/live/mail.py:260`). None of the 36 static reminders scenarios
exercises an escalation ladder; `_u_life_create` has no concept of
notification channels at all.

The production code does model escalation, but on a different action:
`SCHEDULED_TASKS` (see `action-docs.ts:6500-6510` →
`{ name: "escalation", description: "create-only: escalation ladder or
explicit channel steps." }`). The schema accepts an `escalation: object`
parameter on the create subaction. That action is dispatched in the
bench under `SCHEDULED_TASK_CREATE` (`runner.py:1401`), which folds into
a `Reminder` row on `list_personal` (per `LIFEOPS_BENCH_GAPS.md`:
"`SCHEDULED_TASK_CREATE`: folded into the reminder store. If scenarios
start needing scheduled-task semantics that diverge from reminders
(escalation, retry, source tracking), promote to a real `ScheduledTask`
entity. Wave 4C."). The escalation ladder is therefore **declared in
production, modeled as a free-form `object` parameter, and discarded by
the bench executor**.

This is a gap: the channel-escalation feature has tests in the
production `plugins/app-lifeops/src/actions/scheduled-task.ts` codepath
but no benchmark scenario to keep the planner honest about *when* to
emit one vs a plain reminder. A user prompt like "remind me to take my
meds every morning, and if I haven't acknowledged within 15 minutes
call my partner" should route to SCHEDULED_TASK_CREATE with an
`escalation` ladder, not LIFE_CREATE. No scenario exists.

## 6. Cross-platform real bridge (Apple Reminders + ntfy + twilio)

The benchmark is **fully synthetic** — `LifeWorld` is an in-memory store
and `_u_life_create` writes to `world.reminders` only. Real-platform
bridges live in the production runtime, not the bench world:

- **Apple Reminders (EventKit).** `packages/native-plugins/calendar/ios/
  Sources/CalendarPlugin/CalendarPlugin.swift` imports `EventKit` but is
  a calendar plugin, not a reminders plugin. The reminders permission
  prober is in `packages/agent/src/services/permissions/probers/
  reminders.ts:4` — *"LifeOps creates/updates/deletes Apple Reminders
  through EventKit"*. The reminders-side EventKit dylib path lives in
  `packages/app-core/platforms/electrobun/native/macos/window-effects.mm`
  (`elizaEventKitHasFullAccess(EKEntityTypeReminder)` at line 1007), so
  the macOS desktop path is wired in. The bench never traverses this —
  the `Reminder` row written by `world.create_reminder` is a Python
  dataclass.

- **ntfy / push.** The benchmark has no notification dispatch. The
  `mockoon-redirect.ts:17-21` registry slot for `apple-reminders` is
  empty (`P3-3` in `packages/docs/docs/launchdocs/14-lifeops-qa.md:201`
  — "lists slack/discord/github/notion/bluebubbles/apple-reminders/
  spotify as having no env-var override — strongly suggests an intended
  future expansion that hasn't landed").

- **Twilio / voice.** `OWNER_VOICE_CALL` exists in `action-docs.ts:7877`
  and supports `recipientKind=owner|external|e164` with
  Twilio/Android-app-phone as the dispatch provider. Again, no
  reminders-bench scenario exercises this — reminders never go to
  voice in the bench world.

- **macOS native alarms.** `packages/native-plugins/macosalarm/src/
  actions.ts:386-451` defines the `ALARM` action (subaction = set |
  cancel | list) backed by UNUserNotificationCenter. The bench
  collapses both `kind: 'reminder'` and `kind: 'alarm'` into the same
  `_u_life_create` reminder row (`runner.py:909`) — so the bench's
  recurring-pill-alarm scenario (GT `kind: "reminder"`, `cadence:
  "daily"`) tests reminder semantics, not the macOS-alarm
  notification-center semantics. The fake backend's
  `LifeOpsFakeBackend.createReminder` (`packages/app-core/src/benchmark/
  lifeops-fake-backend.ts:839-869`) tags the source as
  `"apple-reminders"` in the list metadata but otherwise behaves
  identically.

The bench therefore exercises only the upstream tool-call shape: it can
verify the planner emits `LIFE_CREATE(kind: alarm, …)` for a prompt
that mentions an alarm, but it cannot verify that the alarm fires, that
ntfy was hit, or that twilio dialed. Those paths are tested in
`packages/native-plugins/macosalarm/__tests__/` (helper unit tests) and
`packages/agent/src/services/permissions/probers/` (permission state),
not in the lifeops bench.

## 7. Eliza improvement plan

### 7.1 P0 — Make the W4-D hint actually reach the agent

Two small edits unblock the entire reminders corpus from the same
arg-shape failure mode:

1. **Inline the title/details hint in `_TOOL_DESCRIPTIONS` for `LIFE_CREATE`.**
   The agent only sees the description string. Change
   `runner.py:170-173` from:

   ```python
   "LIFE_CREATE": (
       "Create personal life records such as reminders, alarms, workouts, or health "
       "metrics. Use subaction=create and put typed fields in details."
   ),
   ```

   to something like:

   ```python
   "LIFE_CREATE": (
       "Create personal life records (reminders, alarms, workouts, health metrics). "
       "Required wire shape: {subaction:'create', title:'<flat top-level title>', "
       "details:{kind:'reminder'|'alarm'|'workout'|'health_metric', "
       "listId:'list_personal'|'list_work'|'list_inbox', due:'<ISO-8601>'}}. "
       "title MUST be top-level — never inside details. listId, due, kind go inside details."
   ),
   ```

   ~8 LoC. Resolves the openclaw / eliza `details:{title,time}` failure
   that was the W1-9 / W2-9 / W5-rem observation.

2. **Add `LIFE_CREATE` to `_tool_parameters_for_action`'s schema.**
   Extend the schema branch in `runner.py:245-270` so that for
   `LIFE_CREATE` (and the other LIFE_* mutating verbs) it emits not just
   the discriminator but `title` (string, top-level) and `details`
   (object with documented inner properties). Strict-schema-respecting
   models (hermes via gpt-oss-120b) will then refuse to nest title.
   Permissive ones (openclaw) will still see the documented shape in
   the schema description. ~25 LoC across LIFE_CREATE/COMPLETE/SNOOZE/
   DELETE/UPDATE.

### 7.2 P0 — Add `LIFE` to scorer `_UMBRELLA_SUBACTIONS`

Hermes's 0.00 on the one reminders scenario is entirely from
`scorer.py:89-120` only canonicalizing `CALENDAR` and `MESSAGE`.
Extending the table:

```python
"LIFE": (
    "subaction",
    frozenset({"create", "complete", "snooze", "review", "delete", "update", "skip"}),
),
```

would make `LIFE(subaction=create)` canonicalize to `LIFE_CREATE(...)`
so the name comparison succeeds. The action_score then becomes 0.5
(name match, kwargs mismatch) instead of 0.0, lifting the score from
0.00 to ~0.20. ~6 LoC.

This is symmetric with the existing CALENDAR/MESSAGE handling and
matches the runner's own dispatch table (line 1377: `"LIFE":
_u_life_review` — the runner already accepts bare LIFE, only the scorer
doesn't recognize the equivalence).

### 7.3 P1 — Deduplicate the manifest

Run `manifest_export.augment_manifest` exactly once. Today the JSON has
20 duplicate entries (`@elizaos/lifeops-bench` augmented copies + older
`lifeops-bench` orphan copies). Either:

- Remove the orphan `lifeops-bench` entries by deleting them and
  re-running the exporter (the `augment_manifest` "existing name wins"
  guard at line 311-317 would prevent re-creation), OR
- Update the corpus gate test to dedup-by-name before counting.

The duplicates aren't actively harmful to the runtime (which doesn't
read this file), but they are harmful to every downstream tool that
expects manifest names to be unique (training dataset exporters,
training prompt ranker, action collision audit). They also mean the
W4-D patch landed on only 1 of 2 LIFE_CREATE entries (index 57, plugin
`@elizaos/lifeops-bench`); the orphan at index 171 still carries
"Human-visible title" / "Structured action-specific details".

### 7.4 P1 — Promote OWNER_REMINDERS_* into the runtime tool catalogue, or remove it from the corpus

The current half-step is misleading: ground-truth scenarios use LIFE_*
(line 42, 76, 99, 124, … of `scenarios/reminders.py`), the runtime tool
catalogue exposes only LIFE_*, but `actions.manifest.json` still
publishes 39 OWNER_REMINDERS_* + OWNER_ALARMS_* + OWNER_TODOS_* +
OWNER_GOALS_* + OWNER_ROUTINES_* entries that the agent never sees.
Either:

- (Recommended) **Remove the OWNER_REMINDERS_* family from the bench
  manifest.** The corpus gate already proves the action exists in the
  production plugin manifest (`@elizaos/app-lifeops` in
  `plugins/app-lifeops/src/actions/owner-surfaces.ts`). It does not need
  a second declaration here. Removes 39 dead entries.
- Or **promote OWNER_REMINDERS_* into `_ACTION_HANDLERS`** the way
  CALENDAR_CREATE_EVENT was promoted (line 1411-1418). Then the
  granular forms become real runtime tools and the W4-D hint applies.
  Adds ~7 keys to the dispatch table; all route to `_u_life_*` with a
  pre-set `kind`.

### 7.5 P2 — Score `cadence` / `timeOfDay` for recurring reminders

`reminders.create_recurring_pill_alarm`,
`reminders.create_weekly_team_sync`,
`reminders.create_monthly_budget_review`,
`reminders.create_annual_tax_deadline`,
`reminders.create_medication_evening`,
`reminders.create_daily_stretch_reminder`,
`reminders.create_daily_journal_prompt`,
`reminders.create_weekly_grocery_shopping`,
`reminders.create_monthly_tax_estimate` (9 of 12 LIFE_CREATE scenarios)
all specify cadence/timeOfDay in GT, but neither field reaches the
state hash. Either:

- Fold cadence+timeOfDay into `_synthetic_id`'s payload so they
  contribute to the reminder id and break state-hash equality on
  mismatch, OR
- Persist them on the `Reminder` row so `LifeWorld.state_hash` reads
  them out.

Without this, the bench cannot distinguish "set a daily 8am pill alarm"
from "set a one-off 8am pill reminder for today" — both produce
identical state hashes today. ~20 LoC across `runner.py` + the
LifeWorld Reminder dataclass.

### 7.6 P2 — Add an escalation-ladder scenario

Coverage gap. One static scenario along the lines of:

```python
Scenario(
    id="reminders.escalate_meds_via_partner_call",
    instruction="Remind me daily at 8am to take my meds, and if I "
                "don't ack within 15 minutes, call my partner.",
    ground_truth_actions=[Action(name="SCHEDULED_TASK_CREATE", kwargs={
        "subaction": "create", "kind": "reminder", ...,
        "escalation": [{"after_minutes": 15, "channel": "voice_call",
                        "target": {"kind": "contact_relation",
                                   "relation": "partner"}}],
    })],
)
```

would lock in the escalation contract that today exists only as a
description in `action-docs.ts:6500-6510`. Routes through the existing
`SCHEDULED_TASK_CREATE` handler (`runner.py:1401`) — no executor change
needed, just a scenario.

### 7.7 P3 — Connect the macOS native-alarm path to the bench

Today `kind: 'alarm'` and `kind: 'reminder'` are
indistinguishable in `_u_life_create`. If the production roadmap
intends to dispatch `kind: 'alarm'` through
`packages/native-plugins/macosalarm` (UNUserNotificationCenter) rather
than the in-app reminder store, the bench should at least separate the
two: a `_h_alarm_set` handler that hashes on `(title, timeIso)` rather
than `(title, listId, due, kind)`, and a corpus scenario that uses the
macOS-native ALARM action verbatim. Otherwise the macOS-native alarm
codepath has zero bench coverage.

## 8. Verification

- Manifest patch present: `grep -c "TOP-LEVEL (flat)"` on the manifest
  → 6 occurrences (matches W4-D's stated 1 LIFE_CREATE + 5 of 6
  OWNER_REMINDERS_* / OWNER_ALARMS_* / OWNER_TODOS_* / OWNER_GOALS_* /
  OWNER_ROUTINES_* — the LIFE_DELETE / LIFE_UPDATE / LIFE_SKIP family
  was not patched).
- Action duplication confirmed: `jq '[.actions[].function.name] |
  group_by(.) | map(select(length > 1)) | map({name: .[0], count:
  length})'` → 20 dup names, 8 in the LIFE family.
- Runtime tool catalogue verified to omit OWNER_REMINDERS_* by reading
  `_ACTION_HANDLERS` keys in `runner.py:1345-1419` directly.
- Scorer canonicalization gap (LIFE not in `_UMBRELLA_SUBACTIONS`)
  confirmed by reading `scorer.py:89-120`.
- Post-W4-D arg shape unchanged: `~/.milady/runs/lifeops/lifeops-multi-
  tier-2026-05-12T03-14-04-023Z/large/openclaw/lifeops_gpt-oss-
  120b_20260511_201444.json` shows openclaw still emitting `details:
  {title, time, type}`.
- Cross-checked: no `~/.milady/runs/lifeops/**` JSON other than the two
  multi-tier-2026-05-12 files contains a `reminders.*` scenario — the
  35 unrun scenarios cannot be assessed.

## 9. Out-of-scope notes

- The `eliza` adapter still doesn't propagate per-turn cost/latency
  (W1-9 P2). Confirmed in the W4-D smoke summary
  (`lifeops-multi-tier-2026-05-12T03-14-04-023Z/SUMMARY.md`) which lists
  `large/eliza` as `FAILED (failed)` with no per-scenario JSON
  preserved. The eliza row in §2 is reconstructed from
  `eliza-tool-call-fix.md`, not direct JSON.
- The bench's `LIFE_REVIEW` no-op (`runner.py:998-1000`) means the 6
  read-only reminders.* review scenarios cannot distinguish a correct
  filtered list from "I refuse to look". Substring matching ("overdue",
  "upcoming") is the only signal — same gap flagged in
  `benchmark-deep-dive-calendar.md` §5 for read-only calendar
  scenarios.
