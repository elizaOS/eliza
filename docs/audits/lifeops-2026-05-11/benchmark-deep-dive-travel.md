# Travel benchmark — deep dive (W5-trv)

Generated 2026-05-11 by sub-agent **W5-trv**, branch `develop`, read-only.
Cross-links: [`benchmark-deep-dive-calendar.md`](./benchmark-deep-dive-calendar.md)
(W5-cal), [`wave-5a-gap-list.md`](./wave-5a-gap-list.md),
[`REPORT.md`](./REPORT.md), [`rebaseline-report.md`](./rebaseline-report.md).

This is the cross-stack assessment of the `travel.*` benchmark slice across
elizaOS runtime, hermes adapter, openclaw adapter, and the LifeOpsBench
Python harness. The travel domain has been exercised in scenario authoring
but **never benchmarked** end-to-end on `develop` — no saved runs match
`^travel\.` in `packages/benchmarks/lifeops-bench/lifeops_bench_results/`
(only `calendar` + `mail` slices have run-files).

---

## 1. Inventory

### 1.1 Eliza (TypeScript) scenarios

`test/scenarios/lifeops.travel/` — **15** scenarios authored by W2-4.

| Scenario | Acceptable actions | Approval-gated? | Side-effect type |
| --- | --- | --- | --- |
| `travel.book-flight-after-approval` | `BOOK_TRAVEL`, `APPROVE_REQUEST` | yes (2-turn lifecycle) | `expectApprovalRequest` + `expectApprovalStateTransition(pending→approved)` + `expectNoSideEffectOnReject` |
| `travel.book-hotel-with-loyalty-number` | `BOOK_TRAVEL`, `PROFILE` | yes | `expectApprovalRequest` + arg includes "Bonvoy"/"MR12345678" |
| `travel.flight-conflict-rebook` | `BOOK_TRAVEL`, `CALENDAR` | yes | seeded existing booking memory; rebook must be approval-gated |
| `travel.duffel-cloud-relay` | `BOOK_TRAVEL` | no (search-only) | `minCount: 0` — search does NOT create approval |
| `travel.capture-preferences-first-time` | `PROFILE`, `LIFE`, `BOOK_TRAVEL` | n/a | `memoryWriteOccurred` on `messages` / `facts` |
| `travel.recurring-business-trip-template` | `PROFILE`, `LIFE`, `BOOK_TRAVEL` | n/a | template persisted to memory |
| `travel.itinerary-brief-with-links` | `CALENDAR`, `BOOK_TRAVEL`, `RELATIONSHIP` | n/a | `connectorDispatchOccurred` on dashboard/desktop |
| `travel.cancel-trip-rollback-events` | `BOOK_TRAVEL`, `CALENDAR` | yes | calendar holds must be enumerated for rollback |
| `travel.upgrade-offer-flagged-for-approval` | `BOOK_TRAVEL`, `PROFILE` | yes | $480 upgrade must NOT auto-accept |
| `travel.travel-blackout-defends-no-booking-during-focus` | `BOOK_TRAVEL`, `CALENDAR` | n/a (refusal) | judge-only |
| `travel.cross-tz-itinerary-formatting` | `CALENDAR`, `BOOK_TRAVEL` | n/a | judge-only (PT + JST both rendered) |
| `travel.passport-expiry-warning` | `BOOK_TRAVEL`, `PROFILE` | n/a (warning) | judge-only |
| `travel.layover-too-tight-warning` | `BOOK_TRAVEL` | n/a | judge-only |
| `travel.partial-day-trip-no-hotel` | `BOOK_TRAVEL` | yes (flight only) | approval + no hotel |
| `travel.asset-deadline-checklist` | `LIFE`, `CALENDAR`, `BOOK_TRAVEL` | n/a | `memoryWriteOccurred` |

All 15 use `judgeRubric` with threshold 0.7 and `expectScenarioToCallAction`
coverage. Helper assertions live at
`test/scenarios/_helpers/action-assertions.ts:195` (`expectApprovalRequest`),
`:223` (`expectApprovalStateTransition`), `:364` (`expectNoSideEffectOnReject`),
`:256` (`expectConnectorDispatch`).

### 1.2 LifeOpsBench (Python) — static suite

`packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/travel.py`
— **26** static scenarios. GT action distribution:

| Action | Count |
| --- | --- |
| `CALENDAR` | 7 |
| `LIFE_CREATE` | 7 |
| `MESSAGE` | 5 |
| `BOOK_TRAVEL` | 3 |
| `CALENDAR_CREATE_EVENT` | 3 |
| `CALENDAR_UPDATE_PREFERENCES` | 1 |
| `CALENDAR_PROPOSE_TIMES` | 1 |

Only **3 of 26** Python travel scenarios actually exercise `BOOK_TRAVEL`:
- `travel.search_flights_sfo_jfk_next_friday` (round-trip search)
- `travel.search_flights_nyc_lax_next_week` (one-way search)
- `travel.search_flights_with_flexible_dates` (date-range search: `'2026-05-20/2026-05-25'`)

The remaining 23 are OOO-block / reminder / iMessage-itinerary scenarios that
*incidentally* live under the `travel` domain because the user instruction
mentions a trip — they actually score against `CALENDAR.create_event`,
`LIFE_CREATE`, `MESSAGE.send`, etc. **The Python `travel` slice does not
benchmark booking at all in any meaningful sense; it benchmarks calendar
and reminder behavior with travel-adjacent prompts.**

### 1.3 LifeOpsBench (Python) — live suite

`packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/live/travel.py`
— **33** live scenarios. All have empty `ground_truth_actions=[]` and rely
on persona-driven `success_criteria` + `world_assertions` (see for example
`live.travel.plan_nyc_trip_end_to_end`, `live.travel.flight_cancelled_replan`).
Live mode adds value for crisis-replan and multi-domain composition
(`Disruption(at_turn=4, kind="rule_change", ...)`), but every scenario
defers to judge / persona behavior — there is no executable match against
`BOOK_TRAVEL.*` kwargs in the live suite.

### 1.4 BOOK_TRAVEL handler

`plugins/app-lifeops/src/actions/book-travel.ts` — 645 LoC.

Key facts that the deep-dive flushes out:

1. **`BOOK_TRAVEL` is no longer a planner-visible action.** The header
   comment at line 327 reads: *"The travel surface is delegated to from the
   registered PERSONAL_ASSISTANT umbrella in owner-surfaces.ts; this module
   no longer publishes a planner-visible Action."* The action is now
   accessed via `PERSONAL_ASSISTANT(action=book_travel)` (see
   `owner-surfaces.ts:554-625`). `BOOK_TRAVEL` only survives as a **simile**
   on `PERSONAL_ASSISTANT` (`owner-surfaces.ts:558`).

2. **The handler is a single transactional compound**, not an umbrella with
   subactions. Internal phases (search → extract → quote/`prepareFlightBooking`
   → approval enqueue → on-approve `executeApprovedBookTravel` → Duffel
   `createOrder` → `createPayment` → calendar sync) are private to the
   compound. There is **no `subaction` discriminator** on `BOOK_TRAVEL`,
   despite what the W5-trv brief asserts ("Subactions: search, draft,
   check_availability, book, cancel, hold, balance_payment"). Those names
   correspond to *internal phases of the compound and Duffel API verbs the
   adapter calls*, not user-facing subactions:
   - `searchFlights` (`service-mixin-travel.ts:228`)
   - `prepareFlightBooking` (`:240`)
   - `bookFlightItinerary` (`:346`) which composes `createOrder` (hold or
     instant) + `createPayment` (balance-payment for hold) + calendar event
   - `cancel` is **not implemented** in the handler at all (see §3.4).

3. **Approval is mandatory.** First invocation always returns
   `success: true` with an enqueued approval (`book-travel.ts:531-567`); the
   real Duffel `createOrder` only fires from `executeApprovedBookTravel`
   (`:573-645`) after `APPROVE_REQUEST` flips the queue entry to `approved`.

4. **Feature flag gate.** Line 339 requires
   `requireFeatureEnabled(runtime, "travel.book_flight")` before any other
   work — surfaces a `FEATURE_NOT_ENABLED` terminal state if Eliza Cloud
   isn't paired.

### 1.5 PRD action map vs runtime

From `packages/docs/action-prd-map.md` (rows 65–69):

| PRD ID | Source action | Status |
| --- | --- | --- |
| `TRAVEL_CAPTURE_PREFERENCES` | `PROFILE.save` + `BOOK_TRAVEL` first-turn capture | ✅ |
| `TRAVEL_BOOK_FLIGHT` | `BOOK_TRAVEL` with kind=flight | ✅ |
| `TRAVEL_BOOK_HOTEL` | `BOOK_TRAVEL` (hotel kind not yet implemented) | 🟡 **Duffel adapter is flights-only; hotel adapter not wired** |
| `TRAVEL_SYNC_ITINERARY_TO_CALENDAR` | `BOOK_TRAVEL.calendarSync` | ✅ |
| `TRAVEL_REBOOK_AFTER_CONFLICT` | `BOOK_TRAVEL` conflict path | 🟡 covered but weak rubric (audit gap #37) |

And row 72:

| `EVENT_BUILD_ITINERARY_BRIEF` | (none) | ❌ **no action assembles per-event itinerary briefs** |

These confirm the two flagged 🟡/❌ items called out in the brief.

---

## 2. Critical assessment

### 2.1 P0 — Contract drift on `BOOK_TRAVEL.passengers`

**Symptom**: three independent definitions of `BOOK_TRAVEL.passengers` are
in active use, and they do not agree.

| Source | `passengers` shape |
| --- | --- |
| Bench manifest exporter | `passengers: { "type": "number" }` (`manifest_export.py:197`) — i.e. integer count |
| Python GT scenarios (3) | `passengers: [{"type": "adult"}]` — array of `{type: <pax-type>}` |
| Eliza TS handler | `passengers: BookTravelPassengerInput[]` requiring `{givenName, familyName, bornOn, ...}` (`book-travel.ts:41-105`); a separate `passengerCount: number` field exists for the count |

This guarantees zero cross-stack scoring fidelity:

- A perfect Eliza-runtime agent that emits the canonical
  `passengers: [{givenName: "...", familyName: "...", bornOn: "..."}]`
  will not match the Python GT (`{type: "adult"}`).
- A planner that emits `passengers: 1` (matching the bench manifest schema)
  will not match either GT or the TS handler's expected array.
- The TS scenarios sidestep this by using `selectedActionArguments` with
  string-contains assertions (e.g. `includesAny: ["SFO", "LAX"]`), but the
  Python scorer uses `_kwargs_match` which compares value-by-value.

**Why**: bench-only umbrella manifest entries in `manifest_export.py` were
authored from the PRD parameter table without cross-checking the TS
handler signatures or the GT scenario fixtures. The promotion sequence
landed via three separate waves with no canonical type owner.

**Risk**: any future `travel.*` run will score `0.0` on action-match for
the three real booking scenarios unless the manifest, GT, and handler are
brought into agreement.

### 2.2 P0 — `BOOK_TRAVEL` is not a real action in the runtime

The action `BOOK_TRAVEL` exists in two places:

1. As a **simile** on `PERSONAL_ASSISTANT` (`owner-surfaces.ts:558`).
2. As a **bench-only umbrella** synthesized into the manifest by
   `manifest_export.py:188`.

The compiled actions manifest at
`packages/benchmarks/lifeops-bench/manifests/actions.manifest.json`
contains **two `BOOK_TRAVEL` entries** plus
`PERSONAL_ASSISTANT_BOOK_TRAVEL`. The duplicate is a leftover of the
bench-promotion plus the natural `BOOK_TRAVEL` simile pickup; neither has
a `passengers` schema that matches the TS handler.

On the runtime side, the planner will resolve user travel intent to
`PERSONAL_ASSISTANT(action=book_travel, …)` and the handler will then
dispatch internally to `runBookTravelHandler` (`owner-surfaces.ts:593-601`).
The bench scorer, however, expects the plan history to contain `BOOK_TRAVEL`
as the *root* action. A correctly-functioning runtime will be scored as
"called the wrong action" because it called `PERSONAL_ASSISTANT` and not
`BOOK_TRAVEL` — even though the latter is documented as a simile.

**Fix scope**: either (a) extend `_canonicalize_action` in
`scorer.py:93-115` to fold `PERSONAL_ASSISTANT(action=book_travel)` into
`BOOK_TRAVEL`, or (b) rewrite the 3 Python GT scenarios + the 15 TS
scenarios' `acceptedActions` to use `PERSONAL_ASSISTANT`. Option (a) is the
correct architectural answer because it matches what `_canonicalize_action`
already does for `CALENDAR_CHECK_AVAILABILITY → CALENDAR(subaction=check_availability)`.

### 2.3 P1 — Hotel booking is documented but unimplemented

The TS scenario `travel.book-hotel-with-loyalty-number` exists and asserts
`approvalRequestExists` on `BOOK_TRAVEL`. The handler has no hotel branch:
`executeApprovedBookTravel:583` throws `Unsupported travel kind: ${payload.kind}`
when `payload.kind !== "flight"`. The Duffel adapter
(`travel-adapters/duffel.ts`) contains zero hotel symbols
(`grep -i hotel` returns nothing). `TRAVEL_CAPABILITIES` in
`service-mixin-travel.ts:46` explicitly declares
`outbound: "partial"` with the comment "flights can be searched and booked;
hotel and ground transport remain out of scope."

So this scenario is **guaranteed to fail real execution** — the agent can
only succeed at the *judge rubric* (surface the Bonvoy number and request
approval) but the underlying booking will never resolve. The
`expectApprovalRequest({actionName: ["BOOK_TRAVEL"]})` check will pass in
the live runner (an approval *is* enqueued), but the approval payload will
carry `kind: "hotel"` (no such code path in the TS handler — the handler
will only get there if the LLM-extracted plan claims it's a hotel and the
caller forces it past the `prepareFlightBooking` call, which only knows
flights). Concretely: this scenario is currently testing surface behavior
only, with a real-world side-effect gap.

### 2.4 P1 — No `EVENT_BUILD_ITINERARY_BRIEF` / itinerary brief action

The TS scenario `travel.itinerary-brief-with-links` seeds memory with a
trip containing flight/hotel/car confirmations and asks for a "full brief
… with links and confirmations". The PRD row `EVENT_BUILD_ITINERARY_BRIEF`
(action-prd-map.md:72) is marked ❌ — no action exists. The PRD's
**Recommendation 4** (`action-prd-map.md:111-113`) is to add either
`BOOK_TRAVEL.build_itinerary_brief` as a subaction or a new
`EVENT_BUILD_ITINERARY_BRIEF` action; nothing has landed.

Current best-effort handling: the agent reads the seeded memory and either
crafts a free-form text reply (will satisfy `responseIncludesAny` if it
echoes the confirmation handles) or falls through to one of the
`acceptedActions: ["CALENDAR", "BOOK_TRAVEL", "RELATIONSHIP"]`. The scenario
asserts `connectorDispatchOccurred` on `dashboard`/`desktop`, which the
normal reply path satisfies.

Net effect: the scenario doesn't measure "did we build a structured brief"
— it measures "did we surface the seeded fields in a reply". The judge
rubric (threshold 0.7) is the only real test of structure.

### 2.5 P1 — Flight-conflict rebook has weak GT

PRD row 69 calls out: *"covered but weak rubric (audit gap #37)"*. The TS
scenario seeds an existing United flight in memory then asks for an
overlapping Delta flight. Final-check is just `selectedActionArguments
includesAny: ["Delta", "United", "rebook", "conflict"]` — any mention of
either airline plus the word "conflict" satisfies the substring assertion.
The judge rubric requires "named the conflicting United booking, proposed
cancel-and-rebook on Delta, and waited for approval", which is the only
real signal.

There is also no `noSideEffectOnReject` paired with explicit cancel-then-
rebook semantics: a plan that *only* enqueues the Delta booking (and
silently leaves the United event) would still pass the substring assertion
since "rebook" is in the bag of keywords.

### 2.6 P2 — Cloud relay is asserted by string match, not codepath

`travel.duffel-cloud-relay.scenario.ts:71` says:
*"search itself does not require an approval — only book does. This check
passes when zero or more approvals exist for BOOK_TRAVEL search."* —
`minCount: 0`. So the "cloud relay" assertion devolves to
`selectedActionArguments includesAny: ["SFO", "LAX", "search", "duffel",
"offer"]`. Mentioning "Duffel" anywhere in the action arguments passes.

The actual cloud-vs-direct routing happens in `readDuffelConfigFromEnv`
(`travel-adapters/duffel.ts:58`) and is tested in
`plugins/app-lifeops/test/travel-duffel.integration.test.ts:88-112`
(unit-level), where cloud mode is the default and direct mode requires
`ELIZA_DUFFEL_DIRECT=1 + DUFFEL_API_KEY`. The benchmark scenario does not
verify that codepath was hit — it only checks the action name and a
substring of the args. **The benchmark cannot tell cloud from direct mode.**

### 2.7 P2 — Asset deadline checklist is collapsed into one action

`travel.asset-deadline-checklist.scenario.ts` asks for four distinct
deadlines (slides, bio, headshot, sponsor form). The final-check accepts
any of `["LIFE", "CALENDAR", "BOOK_TRAVEL"]` and only requires a
`memoryWriteOccurred` on `messages`/`facts` whose content mentions one of
the four assets. A single combined memory entry "slides, bio, headshot,
sponsor form due this week" passes. There's no assertion that four
*distinct* tracked deadlines were created. The PRD row
`EVENT_TRACK_ASSET_DEADLINES` (action-prd-map.md:73) is ✅ via
`SCHEDULED_TASK.create` with `subjectKind=document`, but the scenario
doesn't pin the schedule path — `SCHEDULED_TASK_CREATE` isn't in
`acceptedActions`.

This is a measurement gap: the scenario is title-faithful to its goal
("each deadline must be distinct" in the rubric) but the harness only
exercises the *narrative* side of distinctness, not the persistence.

### 2.8 P3 — No saved travel run on disk

`packages/benchmarks/lifeops-bench/lifeops_bench_results/` has three JSON
files (May 10), all calendar/mail. Zero travel run. Per
`RUNBOOK.md` §3 the operator command exists
(`python -m eliza_lifeops_bench --agent hermes --suite core --domain travel`),
but it has not been executed yet. The pipeline rebuild is calendar-only.

### 2.9 P3 — Python "travel" suite mostly isn't travel

23 of 26 static Python travel scenarios actually exercise
`CALENDAR.create_event` (OOO block), `LIFE_CREATE` (trip-related reminder),
or `MESSAGE.send` (itinerary share). When the operator finally runs the
`travel` domain, mean-score numbers will be dominated by calendar/reminder
behavior, *not* travel booking. Only the 3 BOOK_TRAVEL scenarios measure
the actual Duffel surface. This will be invisible in the rollup unless the
report breaks out per-GT-action.

---

## 3. Per-scenario findings

### 3.1 `travel.book-flight-after-approval` (the canonical lifecycle test)

**Strongest of the 15.** Two-turn protocol exercises the full approval
state machine. Turn 1 must enqueue `pending`, turn 2 must transition
`pending → approved` with `expectApprovalStateTransition`. Has
`expectNoSideEffectOnReject` paired (the rejection branch is *not*
exercised in this scenario but the predicate covers post-hoc inspection
of the queue, which is reasonable).

**Gap**: rejection isn't directly exercised. A separate rejection-path
scenario would catch a regression where reject still triggers Duffel
`createOrder` — currently `executeApprovedBookTravel` is only invoked
from the approve branch in `resolve-request.ts:177`, but there's no
benchmark guard against that getting rewired.

### 3.2 `travel.flight-conflict-rebook`

See §2.5. The substring-only assertion is the weakest spot. Recommend
adding an explicit `expectApprovalRequest({actionName: ["CALENDAR"],
state: ["pending"]})` to require the United cancel-event to also be
queued (currently the scenario only requires `BOOK_TRAVEL` approval).

### 3.3 `travel.book-hotel-with-loyalty-number`

See §2.3. Will pass surface checks (approval enqueued, Bonvoy substring
in args) but the underlying `executeApprovedBookTravel` will throw
`Unsupported travel kind: hotel` on real execution. The scenario passes
because final-checks fire *before* the approval is executed, and approval
execution is asynchronous to the scenario turn.

### 3.4 `travel.cancel-trip-rollback-events`

The brief mentions `BOOK_TRAVEL.cancel` as a subaction. **There is no
cancel codepath in `book-travel.ts`.** The Duffel adapter has
`createOrder`/`getOrder`/`createPayment` but no order-cancel verb. The
scenario therefore tests an aspirational behavior; current handler will
either re-trigger the search→approval cycle (which doesn't make sense
for cancellation) or reply free-form without any side effect.

Recommend either implementing `executeApprovedCancelTravel` (new payload
variant on the approval queue) or rewriting the scenario to use
`CALENDAR.delete_event` only and document that flight/hotel cancellation
is a Wave-N+1 capability.

### 3.5 `travel.travel-blackout-defends-no-booking-during-focus`

Tests refusal behavior against a seeded `calendar-focus-window` memory.
No side-effect assertion (judge-only). The acceptedActions include
`CALENDAR` because the agent may legitimately surface the conflict via
`CALENDAR.search_events` — this is correct. Tight scenario.

### 3.6 `travel.upgrade-offer-flagged-for-approval`

Tests no-auto-accept against a seeded upgrade offer. `approvalRequestExists`
+ `noSideEffectOnReject` is the right shape, but the approval payload
type `book_travel` in `approval-queue.types.ts:82-118` does not have an
"upgrade" variant — it expects `kind: "flight"` with a fresh `offerId`
or `search`. An upgrade is a *modification of an existing booking*, not a
new search. So the codepath the scenario asserts is technically
unimplemented; the LLM will most likely emit a `BOOK_TRAVEL` call with an
invented offerId and the handler will fail the Duffel quote step. Like
§3.3, the surface checks will pass while the side-effect would fail.

### 3.7 `travel.passport-expiry-warning`, `travel.layover-too-tight-warning`,
`travel.cross-tz-itinerary-formatting`, `travel.partial-day-trip-no-hotel`

All four are pure judge-rubric scenarios. They measure model behavior
(surfacing a risk, formatting both TZs, refusing to silently add a hotel)
rather than runtime side effects. These are the most useful for
**personality + reasoning** judge evaluation and the least useful for
**action selection / kwargs match** scoring. They should remain in the
slice but should not be counted in any "action-match" rollup.

### 3.8 `travel.capture-preferences-first-time`,
`travel.recurring-business-trip-template`

Both rely on `memoryWriteOccurred` against tables `messages` / `facts`.
A turn that writes a `messages` record (which every turn does by default)
trivially satisfies the assertion. To pin the actual semantics, these
should assert on the `facts` table specifically with a stricter
`contentIncludesAny` filter that requires the *preference key* (cabin,
seat, bag) — not just the word "class" anywhere in any message.

### 3.9 Python `travel.search_flights_with_flexible_dates`

GT emits `'departureDate': '2026-05-20/2026-05-25'` (date range encoded
as a slash-separated string). The TS handler's `departureDate` pattern is
`^\d{4}-\d{2}-\d{2}$` (book-travel.params.notes.md:3) so a real Eliza
agent will reject the GT value at parameter validation. This is a third
contract drift on top of `passengers` (§2.1): the GT uses a range
encoding that the runtime cannot accept.

---

## 4. Recommendations

### 4.1 High confidence — implement now

1. **Add `BOOK_TRAVEL` to `_canonicalize_action` and `_UMBRELLA_SUBACTIONS`.**
   Either accept `PERSONAL_ASSISTANT(action=book_travel)` as canonical and
   normalize, or document the inverse. Today the scorer cannot match a
   correctly-functioning runtime. Fix scope: ~20 LoC in
   `scorer.py:59` and add a `(_normalize)` test case in
   `tests/test_scorer_kwargs.py`.

2. **Reconcile `passengers` schema.** Pick one canonical shape and update
   all three locations:
   - `manifest_export.py:197` (currently `number`)
   - `scenarios/travel.py` BOOK_TRAVEL kwargs (currently `[{type: adult}]`)
   - `book-travel.ts` handler (currently `BookTravelPassengerInput[]`)

   Recommended shape, matching the TS handler:
   `passengers: [{givenName, familyName, bornOn, gender}]` with the count
   in a separate `passengerCount: number` field. Update the 3 Python GT
   scenarios and the manifest exporter to emit the canonical shape.

3. **Drop or fix `travel.search_flights_with_flexible_dates`.** The
   slash-encoded date range is not in the handler contract. Either widen
   `book-travel.params.notes.md` to accept ranges and add a parser, or
   remove the scenario.

4. **Strengthen `travel.flight-conflict-rebook` final-checks.** Add
   `expectApprovalRequest({actionName: ["CALENDAR"], state: ["pending"]})`
   alongside the existing `BOOK_TRAVEL` approval assertion so the test
   pins both sides of the cancel-and-rebook.

5. **Document `BOOK_TRAVEL` is a compound, not an umbrella.** The
   wave-5a brief explicitly listed seven subactions (search/draft/check_availability/
   book/cancel/hold/balance_payment); those are internal phases and Duffel
   adapter verbs. Update `wave-5a-gap-list.md` and the brief generator to
   reflect that BOOK_TRAVEL has no `subaction` discriminator, so future
   waves don't try to author subaction-keyed kwargs.

### 4.2 Medium confidence — needs prioritization

6. **Implement `executeApprovedCancelTravel`** (book-travel.ts +
   approval-queue.types.ts) so `travel.cancel-trip-rollback-events` has a
   real codepath. Alternatively rewrite the scenario to only assert on
   `CALENDAR.delete_event` for the holds, deferring carrier/hotel
   cancellation to Wave-N+1.

7. **Implement Duffel hotel adapter** OR explicitly bench-skip hotel
   scenarios. `TRAVEL_CAPABILITIES.outbound: "partial"` is honest about
   the gap; the benchmark should match. Until the adapter lands, the
   `travel.book-hotel-with-loyalty-number` scenario should be marked
   "judge-only" with a comment that approval execution will fail.

8. **Land `EVENT_BUILD_ITINERARY_BRIEF` or `BOOK_TRAVEL.build_itinerary_brief`.**
   Pick the action surface (the PRD recommends either) and implement a
   typed brief assembler. Without it, `travel.itinerary-brief-with-links`
   measures narrative behavior only.

### 4.3 Low confidence — operator decision

9. **Re-bin the Python `travel.*` static suite.** 23 of 26 scenarios are
   really CALENDAR/LIFE_CREATE/MESSAGE. Either rename them
   (`travel.calendar_block_*`, `travel.reminder_*`, `travel.message_*`)
   so the domain-rollup means something, or split the suite into
   `travel.booking` (3 scenarios, BOOK_TRAVEL-bound) and `travel.adjacent`
   (23 scenarios, other actions).

10. **Add a rejection-path booking scenario.** Today no scenario flips
    `pending → rejected` and asserts no Duffel side-effect. The
    `expectNoSideEffectOnReject` predicate exists; pair it with a turn
    where the user says "actually, no, don't book it".

---

## 5. Smoke verification

No saved runs exist for `^travel\.`. Per RUNBOOK.md §3 a CEREBRAS-driven
smoke would be:

```bash
python -m eliza_lifeops_bench --agent hermes --suite core --domain travel
```

This was not executed during this audit (read-only, no Cerebras call
budget allocated for W5-trv). Confirmed scenario shape via static load:

```text
travel scenario count: 26 (static)
BOOK_TRAVEL scenarios: 3 (search_flights_sfo_jfk_next_friday,
                          search_flights_nyc_lax_next_week,
                          search_flights_with_flexible_dates)
action distribution: BOOK_TRAVEL=3, CALENDAR=7, LIFE_CREATE=7, MESSAGE=5,
                     CALENDAR_CREATE_EVENT=3, CALENDAR_UPDATE_PREFERENCES=1,
                     CALENDAR_PROPOSE_TIMES=1
```

Live suite: 33 scenarios, all GT-empty (persona + success-criteria driven).

TS scenarios: 15 under `test/scenarios/lifeops.travel/`, all
`isolation: per-scenario`, all gated on `@elizaos/plugin-agent-skills`.

---

## 6. References

Runtime:
- `plugins/app-lifeops/src/actions/book-travel.ts` (645 LoC)
- `plugins/app-lifeops/src/actions/owner-surfaces.ts:554-625` (PERSONAL_ASSISTANT umbrella)
- `plugins/app-lifeops/src/actions/book-travel.params.notes.md` (parameter contract)
- `plugins/app-lifeops/src/lifeops/service-mixin-travel.ts` (capabilities + Duffel routing)
- `plugins/app-lifeops/src/lifeops/travel-adapters/duffel.ts` (cloud/direct mode)
- `plugins/app-lifeops/src/lifeops/approval-queue.types.ts:82-118` (book_travel payload)

Tests (TS):
- `test/scenarios/lifeops.travel/*.scenario.ts` (15 scenarios)
- `test/scenarios/_helpers/action-assertions.ts:195/223/364/256` (approval helpers)
- `plugins/app-lifeops/test/book-travel.approval.integration.test.ts` (approve + reject paths)
- `plugins/app-lifeops/test/flight-rebook.e2e.test.ts` (live conflict rebook)
- `plugins/app-lifeops/test/booking-preferences.e2e.test.ts` (live capture)
- `plugins/app-lifeops/test/travel-duffel.integration.test.ts` (cloud vs direct config)

LifeOpsBench (Python):
- `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/travel.py` (26 static)
- `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/live/travel.py` (33 live)
- `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/runner.py:190,1102,1390` (BOOK_TRAVEL dispatch)
- `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scorer.py:59-115` (`_UMBRELLA_SUBACTIONS`, `_canonicalize_action`)
- `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/manifest_export.py:188-199` (BOOK_TRAVEL manifest schema)
- `packages/benchmarks/lifeops-bench/manifests/actions.manifest.json` (compiled, has 2 BOOK_TRAVEL entries)

PRD:
- `packages/docs/action-prd-map.md:65-72, 111-113` (travel rows + itinerary-brief recommendation)
