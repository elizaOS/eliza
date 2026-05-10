# LifeOps Scenario / Test / Benchmark LARP Audit

**Date:** 2026-05-09
**Scope:** every file under `eliza/test/scenarios/lifeops.habits/`, `eliza/test/scenarios/lifeops.workflow-events/`, `eliza/test/scenarios/browser.lifeops/`, `eliza/plugins/app-lifeops/test/**`, plus the lifeops benchmark harness and seed/fixture helpers.

Verdict legend:
- **SOLID** — exercises tool-search → planner → action → effect end-to-end against a real provider/runtime, with an assertion that fails if the agent doesn't actually do the work.
- **SOFT** — runs against real components but the assertion is a substring/regex on a phrase the prompt itself contains, OR asserts on internal state seeded by the test, not user-visible outcome.
- **LARP** — pretends to test agent behavior but bypasses the planner, mocks the action under test, asserts on its own seed, or asserts only "no error thrown".
- **TRIVIAL** — < 20 lines of meaningful body, single trivial assertion, copy-pasted N-way variant.
- **SKIPPED-BY-DEFAULT** — gated by an env var that is unset in CI; passes by skipping.

---

## Cross-cutting LARP machinery

These files are imported by many scenarios/tests and define the LARP pattern at the source.

### `eliza/plugins/app-lifeops/test/helpers/lifeops-deterministic-llm.ts` — **LARP factory**

This helper short-circuits the planner. `useModel` reads the prompt, classifies it via hard-coded substring heuristics, and returns a hand-crafted JSON object. The test author writes both the planner answer AND the assertion that downstream code uses it. Examples:

- `planLifeOperation` (lines 105-160) returns `operation: "complete_occurrence"` literally because `request.includes("brushed my teeth")` (line 107). The agent never decides anything.
- `planTaskCreate` (lines 162-252) hard-codes `title: "Hug my wife", timeZone: "America/Denver"` for any prompt containing `"april 17"` and `"mountain"` (line 164). This is the answer the `one-off-mountain-time` scenario asserts on.
- `planTaskCreate` (line 218) hard-codes `title: "Brush teeth", windows: ["morning", "night"]` whenever the request contains `"brush"` or `"cepillar"`. This is the answer the Spanish brush-teeth scenario asserts on.
- `planGoalCreate` (lines 254-300) hard-codes `title: "Stabilize sleep schedule"` for the sleep-goal scenario.
- `crossChannelPlan` (lines 539-586) hard-codes `target: "alice@example.com"` when the request contains `"alice@example.com"`. Then the cross-channel-composition scenario asserts the planner output contains `"alice@example.com"`.
- The judge prompt branch (lines 668-678) returns `{passed: true, score: 1, reasoning: "Deterministic fixture pass."}` — every `responseJudge` rubric automatically passes.

Any scenario that ends up routed through this helper is by definition LARP — the deterministic LLM literally is the answer the test verifies.

The helper is exported but I found only one consumer (`createLifeOpsDeterministicLlm` is grepped only inside the helper file itself). It is dead code in the current tree, but it documents the intended shape of the LARP and is referenced by the prompt-benchmark prompt scaffolding.

### `eliza/plugins/app-lifeops/test/helpers/lifeops-chat-runtime.ts` — fully-mocked SQLite "runtime"

Builds a fake `AgentRuntime` from scratch using `:memory:` SQLite, no plugins, no real action loop, no real planner. Every consumer must pass its own `handleTurn` callback (line 65) — the test author provides the planner. Anything built on top of this helper is dead-or-LARP scaffolding. Currently grep shows zero in-tree consumers (the helper is dead but still ships).

### `eliza/plugins/app-lifeops/test/helpers/lifeops-morning-brief-fixtures.ts` — pre-bakes the brief

`seedMorningBriefFixtures` (lines 123-277) writes the literal answers into PGLite before the agent runs:
- Pre-creates an approval queue request with subject `"Re: Investor diligence packet"` (line 195).
- Hand-writes assistant memories like `"Pending draft for the vendor contact is still waiting for sign-off about the investor diligence packet."` (line 213) and `"Document blockers: Clinic intake packet still needs signature and the investor diligence packet still needs review before noon."` (line 259).
- Pre-classifies triage entries as `urgency: "high"`, `classification: "urgent"`, with `triageReasoning` and `suggestedResponse` literally written by the fixture author (lines 501-549).

The morning-brief test (`assistant-user-journeys.morning-brief.e2e.test.ts`) then asks for a brief and asserts `containsAllFragments(digestText, ["telegram", "discord", "Clinic intake packet", "wire cutoff"])` (line 328) where `digestText` is built from the **same** triage rows the fixture seeded. The agent reply is checked only against `not.toMatch(/something went wrong/i)` (line 307). The agent could literally return `"hi"` and the test would pass.

### `eliza/plugins/app-lifeops/test/helpers/lifeops-identity-merge-fixtures.ts` — pre-merges then asserts merged

`seedCanonicalIdentityFixture` (lines 185-305) creates four entities, four rooms, four DM message pairs, and four upserted identities for "Priya Rao" across gmail/signal/telegram/whatsapp. `acceptCanonicalIdentityMerge` (lines 307-327) explicitly calls `relationships.proposeMerge` then `acceptMerge` for each non-primary platform — i.e. the helper performs the merge before the agent runs. The downstream test then asserts the merge happened (`assertCanonicalIdentityMerged`, lines 365-408). The agent is irrelevant.

### `eliza/test/scenarios/_helpers/lifeops-seeds.ts` — seed helpers (legitimate)

These actually do real DB upserts via the runtime repository (`seedCalendarCache`, `seedBrowserExtensionTelemetry`, `seedScreenTimeSessions`, `seedActivityEvents`, `seedCheckinDefinition`). They are seed primitives used by scenarios; not LARP themselves. The LARP shows up downstream when scenarios assert on a string the seed wrote.

### `eliza/test/mocks/fixtures/lifeops-presence-active.ts`

A 880-line static catalog of seven hand-authored "moves" with literal `userRequest`, `expectedWorkflow`, and `expectedAssertions` strings. This is documentation, not a test — nothing in the test suite executes the `expectedAssertions`. Delete-on-sight candidate but it is not active LARP because nothing asserts against it.

### `eliza/test/mocks/fixtures/lifeops-presence-day.ts`

Real, narrowly scoped: builds a 24-hour synthetic activity-signal trace (lines 58-323) and is consumed by a contract test that checks `LIFEOPS_ACTIVITY_SIGNAL_SOURCES` parity. SOLID for what it is (a fixture-integrity assertion).

### `eliza/test/mocks/fixtures/lifeops-simulator.ts` + `eliza/test/mocks/helpers/lifeops-simulator.ts`

The simulator seeds 4 fake people, 3 fake emails, 3 fake calendar events, 10 fake channel messages across 5 platforms, and 2 fake reminders. Used as the substrate for almost every `*.e2e.test.ts` journey. The fixture itself is fine; the LARP comes from the journey tests pre-populating the answer they then "assert".

---

## `eliza/test/scenarios/lifeops.habits/`

| File | Verdict | Justification |
|---|---|---|
| `habit.missed-streak.escalation.scenario.ts` | **SOLID** | Seeds two missed `life_task_occurrences` rows for Stretch (file:33-49), runs `CHECKIN`, asserts `data.habitEscalationLevel === 2` and `missedOccurrenceStreak === 2` (file:117-127). Real DB rows, real action result, structured assertion. |
| `habit.morning-routine.full-stack.scenario.ts` | **SOFT** | Two-turn preview/confirm. Final checks are real DB-row deltas (`definitionCountDelta`, file:39-67) requiring 4 separate definitions with reminder plans — that part is good. But the two `responseIncludesAny` assertions (file:30-37) are substring checks on words ("brush", "stretch", "water", "vitamins") that the user prompt itself contains, so the agent could echo them back. The DB-delta saves it from full LARP. |
| `habit.night-routine.full-stack.scenario.ts` | **SOFT** | Same pattern. `responseIncludesAny: ["brush", "stretch", "wind", "routine", "night"]` (file:29) — the user prompt says exactly those words. DB delta on three definitions saves it (file:39-65). |
| `habit.pause-while-traveling.scenario.ts` | **SOLID** | Seeds a paused habit and a future `pauseUntil` metadata row (file:30-39), runs `CHECKIN`, then asserts `data.habitEscalationLevel === 0`, `stretch.isPaused === true`, `pauseUntilMs > Date.now()`, AND that the paused stretch is excluded from `overdueTodos` (file:104-127). Multi-field state assertion on real action output. |
| `habit.sit-ups-push-ups.daily-counts.scenario.ts` | **SOFT** | Two-turn preview/confirm. `responseIncludesAny: ["push-ups", "push ups", "sit-ups", "sit ups", "morning"]` (file:30-35) is echo-able. DB delta with `cadenceKind: "daily"` and `requiredWindows: ["morning"]` (file:46-58) is real. |

---

## `eliza/test/scenarios/lifeops.workflow-events/`

| File | Verdict | Justification |
|---|---|---|
| `workflow.event.calendar-ended.create.scenario.ts` | **SOLID** | Pure API contract: `POST /api/lifeops/workflows` and `GET /api/lifeops/workflows`, asserts the response body literally contains `'"triggerType":"event"'`, `'"kind":"event"'`, `'"eventKind":"calendar.event.ended"'` (file:78-84) and the listing roundtrips (file:92-94). No agent involved; this is an API persistence test, not a planner test. SOLID for what it claims. |
| `workflow.event.calendar-ended.filter-mismatch.scenario.ts` | **SOLID** | Seeds a `Coffee with friend` event whose title doesn't match the filter (file:36-65), creates the workflow, ticks the scheduler, asserts `workflowRuns` is empty via regex on the JSON response (file:111-122). Real scheduler tick, real negative assertion. |
| `workflow.event.calendar-ended.fires.scenario.ts` | **SOLID** | Mirror — seeds a `Quarterly review` event whose end is in the past (file:73-97), creates a workflow, ticks, asserts response contains `"workflowRuns"` and `"success"` (file:142-145), then ticks again and asserts the workflowRuns array is empty on second tick (file:147-167). Real idempotency assertion. |

---

## `eliza/test/scenarios/browser.lifeops/`

| File | Verdict | Justification |
|---|---|---|
| `1password-autofill.non-whitelisted-refused.scenario.ts` | not read | (out of audit scope; not lifeops-suffix) — lives in browser.lifeops/ but is a 1Password scenario. |
| `1password-autofill.whitelisted-gmail.scenario.ts` | not read | same |
| `1password-autofill.whitelisted-site.scenario.ts` | not read | same |
| `browser.computer-use.agent-fails-calls-user-for-help.scenario.ts` | not read | not lifeops-prefixed |
| `browser.computer-use.click-captcha-via-user.scenario.ts` | not read | same |
| `lifeops-extension.daily-report.scenario.ts` | **SOFT** | Seeds three screen-time sessions (Safari, github.com, docs.google.com) (file:24-46), expects `SCREEN_TIME` action, asserts the result-data JSON serialisation contains the lowercased seeded identifiers (file:96-112). Real action call with real seeded data — but the assertion is `payload.includes("safari")` etc. on a JSON.stringify of the action result.data, which by definition includes the seeded session rows. The `acceptedActions: ["SCREEN_TIME", "SCREEN_TIME"]` (file:65,78,93) duplicate is a code-smell. |
| `lifeops-extension.reports-to-agent-ui.scenario.ts` | **SOFT** | Same pattern. Seeds two browser focus windows for `github.com` and `docs.google.com` (file:32-44), asserts the action payload contains those domains and the `deviceId: "browser-ui-primary"` it just seeded (file:96-103). Asserts on its own seed. |
| `lifeops-extension.see-what-user-sees.scenario.ts` | **SKIPPED-BY-DEFAULT** | `status: "pending"` (file:16) — scenario is explicitly disabled. The body would be SOFT (asserts `page.url`, `page.title`, `page.selectionText`, `page.mainText` all match seeded values, file:130-141 — i.e. asserts on its own seed). |
| `lifeops-extension.time-tracking.per-site.scenario.ts` | **SOFT** | Seeds `https://x.com/shawmakesmagic` for 18 minutes (file:33-44), asks "How much time did I spend on x.com today?", asserts `data.domain === "x.com"` and `data.totalMs > 0` (file:99-104). The domain assertion is on the seeded value; the `totalMs > 0` is the only non-trivial check. |
| `lifeops-extension.time-tracking.social-breakdown.scenario.ts` | **SOFT** | Same as daily-report. Seeds x.com / instagram.com / facebook.com sessions, asserts JSON payload contains each lowercased seeded host (file:101-107). |
| `subscriptions.cancel-google-play.scenario.ts` | not read | not lifeops-prefixed |
| `subscriptions.login-required.scenario.ts` | not read | same |

---

## `eliza/plugins/app-lifeops/test/scenarios/*.scenario.ts`

These all rely on a `definitionCountDelta` final-check (real DB row delta) and are run via the prompt-benchmark or live-chat tests. The chat preview text assertions are typically substring checks on the user prompt's own words.

| File | Verdict | Justification |
|---|---|---|
| `brush-teeth-basic.scenario.ts` | **SOFT** | `responseIncludesAny: ["brush teeth", "brushing habit", "set that up"]` (file:24) and final `definitionCountDelta` with `requiredSlots: [{minuteOfDay:480},{minuteOfDay:1260}]` (file:33-46). The slot assertion is real; the response checks are echoable. |
| `brush-teeth-bedtime-wakeup.scenario.ts` | **SOFT** | Same pattern, `responseIncludesAny: ["brush teeth", "brushing", "bed", "wake"]` (file:23-24) — every needle is in the user prompt. Final `definitionCountDelta` is real. |
| `brush-teeth-cancel.scenario.ts` | **SOFT** | Tests *no* save: `delta: 0` (file:36-38) and `responseExcludes: ['saved "brush teeth"']` (file:30). The negative assertion is meaningful but tiny (15-line scenario). |
| `brush-teeth-night-owl.scenario.ts` | **SOFT** | Same pattern as basic. |
| `brush-teeth-repeat-confirm.scenario.ts` | **SOFT** | Three-turn re-confirm test asserting only one definition is saved (delta:1). Real but narrow. |
| `brush-teeth-retry-after-cancel.scenario.ts` | **SOFT** | Cancel-then-retry, asserts one definition exists at end (delta:1). |
| `brush-teeth-smalltalk-preference.scenario.ts` | **SOFT** | Five-turn test that uses `responseJudge` (file:34-37, 42-46). The judge rubric assertion runs against the **deterministic LLM judge** which always returns `passed: true` (see deterministic-llm.ts:670-678). Final `definitionCountDelta` + `reminderIntensity` (file:60-74) — those are real. The judge passes are LARP. |
| `brush-teeth-spanish.scenario.ts` | **SOFT** | Spanish prompt; the deterministic LLM hard-codes the Brush teeth answer for any prompt with `"cepillar"` (deterministic-llm.ts:218). When run via the live LLM the test is real; when run deterministic it is LARP. |
| `calendar-llm-eval-mutations.scenario.ts` | **SOFT** | Five turns, each with `plannerIncludesAll: ["calendar_action", "create_event", "alex"]` (file:30-32) etc. The planner output is asserted to contain "alex"/"dentist"/"team" — the deterministic LLM literally hard-codes those titles per request (deterministic-llm.ts:319-320, 333-336, 343-345). Run against real LLM the assertion is real; against deterministic it round-trips its own answer. |
| `calendar-vague-followup.scenario.ts` | **SOFT** | Three turns, all asserting `plannerIncludesAll: ["calendar_action"]` and `plannerExcludes` of unrelated tools (file:24-58). Decent negative-action coverage, no `responseIncludesAny`. |
| `cross-channel-composition.scenario.ts` | **LARP** when run deterministic, **SOFT** when live | `plannerIncludesAll: ["owner_send_message", "alice@example.com"]` (file:24). The deterministic helper hard-codes `target: "alice@example.com"` for any prompt containing the literal string `"alice@example.com"` (deterministic-llm.ts:566-575) — the prompt itself contains `alice@example.com`. The assertion is `planner contains string the prompt also contains`. |
| `daily-left-today-variants.scenario.ts` | **SOLID** | Seeds two definitions via API, runs three message variants in two rooms, completes one occurrence, then asserts via API that completed occurrence is excluded from the overview (file:140-160, 170). Real lifecycle, real cross-room. |
| `gmail-direct-message-sender-routing.scenario.ts` | **TRIVIAL** | 35-line single-turn scenario. Sole positive assertion: `plannerIncludesAll: ["gmail_action", "pat"]` (file:24) — "pat" is the user's prompt. Negative assertions on `spawn_agent` etc. (file:25-30) are real but the positive case is round-tripping. |
| `gmail-llm-eval-search-priority.scenario.ts` | **SOFT** | Four turns asserting `plannerIncludesAll: ["gmail_action"]` plus various subject-keyword `includesAny` — the deterministic helper hard-codes `triage` for "urgent blockers" prompts (deterministic-llm.ts:466-473). |
| `gmail-retry-followup.scenario.ts` | **SOFT** | Three-turn refinement, asserts `gmail_action` + `suran` (file:23-26, 42-49); deterministic helper hard-codes `from:suran` query for "suran" prompts (deterministic-llm.ts:533-535). |
| `goal-sleep-basic.scenario.ts` | **LARP** | Three turns, every one uses `responseJudge` (file:24-46). The deterministic LLM judge always returns `passed: true` (deterministic-llm.ts:670-678). Final `goalCountDelta` with strict shape requirements (file:48-60) is real but the deterministic plan helper hard-codes the entire grounded goal payload for any "stabilize sleep schedule" prompt (deterministic-llm.ts:256-278). The user prompt contains "Stabilize sleep schedule"; the deterministic planner returns the exact title; the test asserts the exact title was saved. Self-fulfilling. |
| `invisalign-weekday-lunch.scenario.ts` | **SOFT** | `responseIncludesAny: ["invisalign", "weekdays", "lunch", "afternoon"]` (file:24) — needles in prompt. `requiredWeekdays: [1,2,3,4,5]` and `requiredWindows: ["afternoon"]` final check is real. |
| `one-off-mountain-time.scenario.ts` | **LARP** | `responseIncludesAny: ["hug", "wife", "8:00", "8pm", "april 17", "mountain"]` (file:24-32) — every word is in the user prompt. Final check `expectedTimeZone: "America/Denver"` (file:42) is real, but the deterministic helper hard-codes that timezone for any "april 17"+"mountain" prompt (deterministic-llm.ts:163-180). |
| `reminder-lifecycle-ack-complete.scenario.ts` | **SOLID** | Eight-turn API+chat lifecycle: seed → fire reminder → ack → re-process (asserts no re-attempt) → inspect lifecycle → overview → complete → check `totalCompletedCount:1, currentOccurrenceStreak` (file:153-166). This is a real reminder state-machine test. |
| `reminder-lifecycle-snooze.scenario.ts` | **SOLID** | Five-turn lifecycle: seed → fire → snooze via chat → assert overview shows `snoozed` → re-process before snooze expires asserts `attempts:[]` (file:81-122). Real state machine. |
| `shave-weekly-formal.scenario.ts` | **SOFT** | `responseIncludesAny: ["shave", "twice a week", "weekly"]` — needles in prompt. `requiredWeekdays: [1,4]` is real (file:38-41) but deterministic helper hard-codes Mon/Thu for "shave" + "twice a week" (deterministic-llm.ts:182-198). |
| `shower-weekly-basic.scenario.ts` | **SOFT** | Same pattern. |
| `stretch-breaks.scenario.ts` | **SOFT** | `requiredEveryMinutes: 360`, `requiredMaxOccurrencesPerDay: 2`, `requiredWindows: ["afternoon", "evening"]` (file:39-43). Real but the prompt is one line. |
| `vitamins-with-meals.scenario.ts` | **SOFT** | Same as invisalign. |
| `water-default-frequency.scenario.ts` | **SOFT** | `requiredEveryMinutes: 180`, `requiredMaxOccurrencesPerDay: 4` (file:38-43). Real cadence assertion. |
| `workout-blocker-basic.scenario.ts` | **SOLID-ish** | Final `websiteAccess: { unlockMode: "fixed_duration", unlockDurationMinutes: 60, websites: ["x.com", "twitter.com", "instagram.com", "news.ycombinator.com"] }` (file:41-50). The four websites are derived from the prompt mention of "X, Instagram, Hacker News" — deterministic helper does not hard-code blockers, so the planner has to actually do something. Slightly more solid. |

---

## `eliza/plugins/app-lifeops/test/*.test.ts` — top-level (alphabetical)

### Skipped-by-default suites (`ELIZA_LIVE_TEST=1` unset → silent pass)

**Env vars unset by default that gate these:**
- `ELIZA_LIVE_TEST=1`
- `ELIZA_LIVE_APPLE_REMINDERS_TEST=1` (apple-reminders only)
- `ELIZA_DESKTOP_HEADLESS_SMOKE=1` / `ELIZA_LIVE_DESKTOP_WATCH_TEST=1` (selfcontrol-desktop)
- `ELIZA_LIFEOPS_REMOTE_E2E_URL` + `ELIZA_LIFEOPS_REMOTE_E2E_TOKEN` (activity-signals.remote)
- `DUFFEL_API_KEY` (travel-duffel live block)
- `NTFY_BASE_URL` (notifications-push live block)
- `GOOGLE_OAUTH_TEST_TOKEN` (google-drive)
- `SIGNAL_HTTP_URL` / `SIGNAL_CLI_PATH` (lifeops-signal-inbound stub vs live)

| File | Gating env | Verdict |
|---|---|---|
| `apple-reminders.live.test.ts` | `ELIZA_LIVE_TEST=1`, `ELIZA_LIVE_APPLE_REMINDERS_TEST=1`, macOS | **SKIPPED-BY-DEFAULT**. When run, it is SOLID — drives a real osascript against macOS Reminders.app and re-reads via osascript to confirm (file:135-204). |
| `assistant-user-journeys.live.e2e.test.ts` | `ELIZA_LIVE_TEST=1`+provider | **SKIPPED-BY-DEFAULT**. When run, the four `it()` blocks exercise real cross-platform memory assertions (`expectContainsAtLeast`, `expectContainsAll`) against a real LLM (file:710-817). SOLID when enabled, but invisible to CI. |
| `assistant-user-journeys.followup-repair.e2e.test.ts` | `ELIZA_LIVE_TEST=1`+provider | **SKIPPED-BY-DEFAULT**, and even when run is **LARP**. After sending the user turn, if no approval is pending, the test enqueues one itself (`pending[0] ?? (await approvalQueue.enqueue({...repairDraft...}))`, file:363-378), approves it, then *manually* calls `executeApprovedRequest` (file:393) and `service.completeFollowUp(followUpId)` (file:414). The agent gets to wave at the test and the assertions all run against fixtures the test author wrote. |
| `assistant-user-journeys.identity-merge.live.e2e.test.ts` | `ELIZA_LIVE_TEST=1`+provider | **SKIPPED-BY-DEFAULT**. When run, **LARP**: `seedCanonicalIdentityFixture` then `acceptCanonicalIdentityMerge` are called in `beforeAll` (file:164-171). The merge happens BEFORE the agent message. The test then sends a chat message and asserts `assertCanonicalIdentityMerged` — an assertion that holds because the helper merged everything in setup. |
| `assistant-user-journeys.morning-brief.e2e.test.ts` | `ELIZA_LIVE_TEST=1`+provider | **SKIPPED-BY-DEFAULT**, **LARP** when run. `seedMorningBriefFixtures` seeds the answer; the test sends a long structured prompt; agent reply is checked only against `not.toMatch(/something went wrong\|flaked\|try again/i)` (file:307); state assertions (file:309-343) are on the same approval queue / triage rows the fixture seeded. |
| `booking-preferences.e2e.test.ts` | `ELIZA_LIVE_TEST=1`+provider | **SKIPPED-BY-DEFAULT**, **LARP**: after sending the prefs prompt, if `profile.travelBookingPreferences` doesn't match the regex, the test calls `updateLifeOpsOwnerProfile` itself to write the answer (file:101-106), then asserts. Sole turn-2 assertion is `not.toMatch(/what seat\|what hotel budget/)` (file:115) — i.e. "agent didn't ask the question." |
| `bundle-meetings.e2e.test.ts` | `ELIZA_LIVE_TEST=1`+provider | **SKIPPED-BY-DEFAULT**. Sole assertion `expect(reply).not.toMatch(/something went wrong/i)` (file:118). Pure smoke. |
| `cancellation-fee.e2e.test.ts` | `ELIZA_LIVE_TEST=1`+provider | **SKIPPED-BY-DEFAULT**, **LARP**: only assertion is `not.toMatch(/something went wrong/i)` (file:112). The actual journey ("agent warns about $150 fee") is tagged `it.todo` (file:117-119). |
| `daily-brief.drafts.e2e.test.ts` | `ELIZA_LIVE_TEST=1`+provider | **SKIPPED-BY-DEFAULT**, **LARP**: seeds two pending draft approvals (file:61-95) then asserts the approval queue contains those drafts (file:140-154). The agent's reply is checked only against `not.toMatch(/something went wrong/i)` (file:135). The journey claims "the brief mentions the drafts" but the test never reads the brief. |
| `eow-escalation.e2e.test.ts` | `ELIZA_LIVE_TEST=1`+provider | **SKIPPED-BY-DEFAULT**, **TRIVIAL**: enqueues a `sign_document` approval in setup, sends a turn, optionally inspects Twilio ledger but `if (smsCalls.length > 0) { expect(smsCalls[0].path).toMatch(/messages/i); }` (file:136-138) — the assertion only runs when SMS exists, which means it's a no-op when SMS doesn't exist. The journey body is `it.todo` x2 (file:143-149). |
| `flight-rebook.e2e.test.ts` | `ELIZA_LIVE_TEST=1`+provider | **SKIPPED-BY-DEFAULT**, **LARP**: when no approval appears AND no "alternative flight" pattern matches the reply, the test enqueues the `book_travel` approval itself (file:148-187), then asserts `pending.length > 0 \|\| hasSafeIntermediateStep` (file:191-194). Always passes. |
| `group-chat-handoff.e2e.test.ts` | `ELIZA_LIVE_TEST=1`+provider | **SKIPPED-BY-DEFAULT**, **TRIVIAL**: sole assertion `not.toMatch(/something went wrong/i)` (file:116). |
| `lifeops-activity-signals.remote.live.e2e.test.ts` | `ELIZA_LIFEOPS_REMOTE_E2E_URL` + token | **SKIPPED-BY-DEFAULT**. SOLID when enabled — POSTs activity-signals to a remote API, GETs them back, asserts both sources present and overview shape (file:51-138). |
| `lifeops-chat.live.e2e.test.ts` | `ELIZA_LIVE_TEST=1`+provider | **SKIPPED-BY-DEFAULT**. When run, **SOLID** — asserts via `waitForDefinitionByTitle` that `Brush teeth` definition has `cadence: { kind: "times_per_day", slots: [{ minuteOfDay: 480, label: "Morning" }, { minuteOfDay: 1260, label: "Night" }] }` (file:223-229). 946-line file with multiple end-to-end planner→action→DB-state journeys including `Workout` blocker policy (file:436-446). The most legitimate live coverage in the suite — but also entirely behind `ELIZA_LIVE_TEST`. |
| `lifeops-gmail-chat.live.e2e.test.ts` | `ELIZA_LIVE_TEST=1`+provider | **SKIPPED-BY-DEFAULT**. The "strict single-attempt" tests assert `responseText.match(/venue\|morgan/i)` (file:359) and `match(/next week\|thank/i)` (file:372). The "recovery coverage" block (file:378-426) **explicitly retries 3 times** until one of the regexes hits — this is documented planner flake-tolerance baked into the test. Ranked SOFT-when-run. |
| `lifeops-llm-extraction.live.test.ts` | `ELIZA_LIVE_TEST=1`+provider | **SKIPPED-BY-DEFAULT**. SOLID-when-run — calls real `extractLifeOperationWithLlm` etc. and asserts exact `operation` enum values (file:118-133) for 10 cases. Wrapped in `stochasticTest`. The closest thing to a real benchmark in the file. |
| `lifeops-memory.live.e2e.test.ts` | `ELIZA_LIVE_TEST=1`+provider | **SKIPPED-BY-DEFAULT**. Not read in full; uses `MemoryServiceLike` shape (file:55-63). |
| `lifeops-screen-context.live.e2e.test.ts` | `ELIZA_LIVE_TEST=1`+Chrome | **SKIPPED-BY-DEFAULT**. SOLID when run — actually starts Chrome, captures a frame, samples it, asserts `summary.source === "browser-capture"` and dims > 0 (file:131-136). |
| `multilingual-action-routing.integration.test.ts` | `ELIZA_LIVE_TEST=1`+provider | **SKIPPED-BY-DEFAULT**. SOLID when run — 4 languages × 7 calendar verbs + 4 × 3 LIFE ops, calls real `extractCalendarPlanWithLlm` and asserts `plan.subaction === expected` (file:215-241). |
| `notifications-push.e2e.test.ts` | `NTFY_BASE_URL` | **SKIPPED-BY-DEFAULT**. Live block `describe.skipIf(!LIVE_BASE_URL)` (file:13-18). Comment says "always skipped in CI today". |
| `portal-upload.e2e.test.ts` | `ELIZA_LIVE_TEST=1`+provider+`ELIZA_BROWSER_WORKSPACE_URL` | **SKIPPED-BY-DEFAULT**, **LARP**: when `BROWSER_WS_AVAILABLE=false`, the assertion is `expect(browserRequests).toHaveLength(0)` (file:127) — i.e. asserts that *nothing happens* when the prerequisite isn't there. When BROWSER_WS available, asserts `browserRequests.length >= 1` (file:118). The follow-up "actually fills the form" is `it.todo` (file:131-133). |
| `selfcontrol-chat.live.e2e.test.ts` | `ELIZA_LIVE_TEST=1`+provider | **SKIPPED-BY-DEFAULT**. Two describe blocks. |
| `selfcontrol-desktop.live.e2e.test.ts` | `ELIZA_LIVE_TEST=1` (+macOS+headless flags) | **SKIPPED-BY-DEFAULT**. |
| `selfcontrol-dev.live.e2e.test.ts` | `ELIZA_LIVE_TEST=1` | **SKIPPED-BY-DEFAULT**. |
| `signature-deadline.e2e.test.ts` | `ELIZA_LIVE_TEST=1`+provider | **SKIPPED-BY-DEFAULT**, **LARP**: enqueues a `sign_document` approval itself if none exists (file:133-150), then asserts `outboundCalls.length + gmailSends.length >= 0` (file:165-170) — that's literally `count >= 0`, always true. Body comment admits "may be queued for approval first". |
| `stuck-agent-call.e2e.test.ts` | `ELIZA_LIVE_TEST=1`+provider | **SKIPPED-BY-DEFAULT**. |

### Non-live tests

| File | Verdict | Justification |
|---|---|---|
| `approval-queue.integration.test.ts` | **SOLID** | Real PGLite, real state machine: enqueue→approve→executing→done, reject, expired, invalid-transition (file:113-194). Asserts on every state and resolver. No agent involved; pure data-layer test, accurately scoped. |
| `book-travel.approval.integration.test.ts` | **SOLID-ish** | 619-line PGLite + fetch-mock integration of the approval-gated book-travel flow. Did not read in full; the `approveRequestAction`/`rejectRequestAction` are exercised against real DB. |
| `bundle-meetings.e2e.test.ts` | **SKIPPED-BY-DEFAULT** (live) | see above |
| `contracts.test.ts` | **SOLID** | 452 lines of registry-shape assertions. Pure structural validation of `ConnectorRegistry`, `ChannelRegistry`, `SendPolicyRegistry`, `decideDispatchPolicy`, `PRIORITY_TO_POSTURE`, `DEFAULT_ESCALATION_LADDERS` (file:74-452). All assertions are on real registry helpers; no agent. |
| `cross-channel-search.integration.test.ts` | **SOFT** | Three tests. Real PGLite, seeds five platform messages with "ProjectAtlas" keyword (file:135-164). Tests 1 & 2 call `runCrossChannelSearch` and `searchAcrossChannelsAction.handler` directly with explicit `query: "ProjectAtlas"` — bypassing the planner (file:175-188, 217-232). Test 3 unsets `useModel` and calls handler with empty params, asserts `noop === true \|\| === undefined` (file:295-298) — trivial. |
| `default-pack-morning-brief.parity.test.ts` | **SOLID** | Pure parity test: `buildMorningBriefPromptFromReport` vs `buildCheckinSummaryPrompt` produce byte-identical output (file:73-100). Strong invariant. |
| `default-packs.helpers.test.ts` | **SOLID** | Helper-function unit tests: `deriveQuietObservations`, `runQuietUserWatcher`, `deriveOverdueFollowupTasks` etc. (file:28-200). Real branches, real assertions, narrow scope. |
| `default-packs.lint.test.ts` | **SOLID** | Lint-rule unit tests for PII / absolute-path / hardcoded-time / embedded-conditional rules. Real positive and negative cases (file:18-212). |
| `default-packs.schema.test.ts` | **SOLID** | Schema-validation contract test for every shipped pack record (file:79-...). Validates kind, priority, trigger.kind, idempotency-key, source enums. |
| `default-packs.smoke.test.ts` | **SOLID** | Three tests asserting nudge-budget invariant `<=6/day`, merge-mode collapse on `wake.confirmed`, and watcher-records (`ownerVisible:false`) don't count (file:148-240). Pure simulation, no LLM. Real maths. |
| `entities.e2e.test.ts` | **SOLID** | Real PGLite EntityStore tests: ensureSelf, upsert with multiple identities, `observeIdentity` collapsing by (platform, handle) with provenance, recordInteraction (file:38-...). 287 lines of real graph-store assertions. |
| `first-run-abandon-resume.e2e.test.ts` | not read in full (105 lines) | likely SOLID like other first-run-* tests. |
| `first-run-config-validation.test.ts` | **SOLID** | 185-line schema validator — buildDefaultsPack returns 4 ScheduledTaskInputs with required fields, valid enums, idempotency keys (file:67-88). Real assertions. |
| `first-run-customize.e2e.test.ts` | **SOLID** | Walks the 5-question customize path, asserts question order, conditional Q5 branch on follow-ups, channel-validation fallback warning, 4 scheduled tasks (file:27-88). Real. |
| `first-run-defaults.e2e.test.ts` | **SOLID** | Provider+action contract: pending-affordance, run-defaults, post-completion silence, 4 task slots (`gm`, `gn`, `checkin`, `morningBrief`) (file:38-119). Real. |
| `first-run-replay.e2e.test.ts` | **SOLID** | Idempotency replay test — tasksBefore vs tasksAfter share idempotency keys (file:48-67). |
| `global-pause.integration.test.ts` | **SOLID** | Real pause store lifecycle, action handler verb=pause/wipe, runner-helper contract `shouldSkip` (file:27-122). |
| `google-drive.integration.test.ts` | **SKIPPED-BY-DEFAULT** | `GOOGLE_OAUTH_TEST_TOKEN` unset. Curiously the file uses `it.skipIf(LIVE_CREDS_AVAILABLE)` (file:44) — i.e. the "documents that live tests are skipped" test runs only when credentials are *missing*; that test asserts `ACCESS_TOKEN === ""` (file:47), which is trivial.|
| `graph-migration.e2e.test.ts` | **SOLID** | 80+ lines, seeds 50 legacy rows, runs migrator dry-run + apply, asserts shape (file:28-203). |
| `handoff.e2e.test.ts` | **SOLID** | Multi-test handoff state machine with `roomPolicyProvider` injecting "stay quiet" directive, `evaluateResume` per condition (file:50-...). 312 lines. |
| `lifeops-action-gating.integration.test.ts` | **SOLID** | Real PGLite asserts `MESSAGE` validates true for owner messages (file:76-89), action surface includes the canonical 7 (file:92-104), removed actions don't appear (file:106-124), ENTITY rejects non-owner (file:128-149). |
| `lifeops-calendar-chat.real.test.ts` | **SOFT** | 332-line PGLite calendar repository test. Bypasses the action handler entirely — comment says so (file:8-12). Real DB-layer coverage; not a planner test. |
| `lifeops-feature-flags.integration.test.ts` | **SOLID** | Real DB feature-flag CRUD, cloud-link policy switching (file:46-159). |
| `lifeops-inbox-triage.integration.test.ts` | **SOLID** | Schema bootstrap + ranking invariant (`urgency: high` before `low`) (file:5-105). |
| `lifeops-life-chat.real.test.ts` | **SOFT** | 377 lines. Sets `confirmed: true` to skip preview/confirm (file:42), passes explicit `action: "create"` to bypass action selection (file:75). Comment: "Provides explicit `action` params (simulating the LLM's action selection) so tests are deterministic about which operation runs". So it tests parameter extraction in isolation — not the planner's action selection. SOFT for what it is. Live-LLM-only via `describeWithLLM = provider ? describe : describe.skip` (file:30). |
| `lifeops-scheduling.real.test.ts` | **SOFT** | 317 lines. The "pure slot logic" describe block (file:80-...) is real maths — solid. The handler-level tests use explicit subactions (file:8-22 comment) and skip the LLM. |
| `lifeops-signal.real.e2e.test.ts` | **SOLID-ish** | 574 lines. Real Signal stub HTTP server, real signal-cli detection (`SIGNAL_CLI_AVAILABLE` from `fs.existsSync`, file:43). Stub-based tests run in CI; real-binary tests skip. |
| `lifeops-signal-inbound.integration.test.ts` | **SOLID** | Stub-based integration test of `readSignalInbound` against a fake signal-cli HTTP server (file:51-...). 282 lines. Real integration. |
| `life-smoke.integration.test.ts` | **SOFT** | 380 lines. Life action handler called with explicit action params — bypasses LLM action selection. |
| `multilingual-action-routing.integration.test.ts` | **SKIPPED-BY-DEFAULT** | see above. |
| `native-parameters.test.ts` | **SOLID** | Real planner-parameter passthrough test with mocked `hasOwnerAccess` and approval queue. Asserts `runtime.useModel` is NEVER called (file:78, 114). Real "trust the planner" contract test. 136 lines. |
| `pending-prompts.integration.test.ts` | **SOLID** | Provider/store integration with retain-window + resolve (file:28-...). |
| `plugin-health-anchor.integration.test.ts` | **SOLID** | Asserts plugin-health exposes `HEALTH_ANCHORS`, `wake.confirmed` etc.; runner accepts anchor-relative trigger (file:62-...). Pure structural integration. |
| `prd-coverage.contract.test.ts` | **SOFT** | 353 lines. Asserts every coverage-matrix.md row points to a real test file and every test file is referenced once. **Self-referential** — proves the matrix is consistent with the file tree, not that the linked tests are SOLID. The matrix itself can include LARP tests and this contract still passes. |
| `recent-task-states.integration.test.ts` | **SOLID** | Real cache-backed log + provider summary; asserts streak `consecutive: 3`, kind/lookback filtering (file:14-62). 62 lines. |
| `relationships.e2e.test.ts` | **SOLID** | 626 lines. Real PGLite, calls service + handler with explicit `subaction` (skips LLM extraction) and asserts on DB state (file:54-...). Comment admits the LLM path is skipped. |
| `relationships-graph.e2e.test.ts` | **SOLID** | Multi-typed edges, RelationshipStore.observe strengthening, retire-with-audit, extraction.ts ("Pat is my manager at Acme" → 2 entities + 3 edges) (file:29-...). |
| `reminder-review-job.real.e2e.test.ts` | **SOLID-ish** | 442 lines. Real reminder lifecycle; did not read in full. |
| `schedule-merged-state.real.test.ts` | **SOLID** | 197 lines. Seeds screen-time + activity signals, builds expected `LifeOpsScheduleMergedStateRecord`, asserts merge correctness (file:17-...). |
| `scheduled-task-end-to-end.e2e.test.ts` | **SOLID** | 308 lines. ScheduledTask spine end-to-end via in-memory runner; verb→pipeline→completion→reopen (file:14-...). No LLM. |
| `screen-time.real.test.ts` | **SOLID** | 415 lines. Real PGLite, asserts session insert + daily aggregate + summary ordering (file:39-...). |
| `signature-deadline.e2e.test.ts` | **SKIPPED-BY-DEFAULT** + **LARP** | see above. |
| `spine-and-first-run.integration.test.ts` | **SOLID** | First-run defaults seam to scheduler runner; verbs and acks against in-memory store (file:50-...). 181 lines. |
| `stretch-gate-parity.parity.test.ts` | **SOLID** | 30-day × 24-hour parity replay against legacy stretch-decider (file:88-141). Documents Wave-3 deferral for missing gates (file:143-155). |
| `travel-duffel.integration.test.ts` | **SKIPPED-BY-DEFAULT** for live block; **SOLID** for unit block | Config + error-path unit tests (file:66-119) always run; live block always skipped. Header comment is explicit about CI status (file:13-29). |
| `w2c-calendar-decomposition.test.ts` | **SOLID** | 134 lines. Asserts CALENDAR umbrella shape (≤14 verbs, no calendly_/negotiate_) and SCHEDULING_NEGOTIATION owns the 7-verb lifecycle (file:56-134). Pure structural. |

---

## Benchmark / smoke harnesses

### `eliza/packages/app-core/scripts/lifeops-prompt-benchmark.ts`

CLI driver. Loads cases from `buildLifeOpsPromptBenchmarkCases`, runs `runLifeOpsPromptBenchmark`, writes report+markdown+jsonl. Pass through.

### `eliza/plugins/app-lifeops/test/helpers/lifeops-prompt-benchmark-cases.ts`

Generates 10 prompt-rewrite variants × N base scenarios. Variants are mostly substring transforms ("Please handle this carefully: …", "uh … thanks", etc., file:182-282). The expected action is derived from `selectedAction` final-checks in the source scenario (file:298-310). For self-care scenarios, `deriveSelfCareExpectation` (file:313-360) maps any scenario with a confirm-style turn-2 to `expectedAction: "LIFE"` and any goal scenario to `expectedOperation: "create_goal"`. The `subtle-null` variant prepends `"Do not do this yet. I'm only thinking out loud:"` and asserts `expectedAction: null` — a real guard against false positives.

The benchmark is real *if and only if* a live provider is configured (see runner). Without a provider, `runLifeOpsPromptBenchmark` throws.

### `eliza/plugins/app-lifeops/test/helpers/lifeops-prompt-benchmark-runner.ts`

`createLifeOpsPromptBenchmarkRuntime` requires a real provider via `selectLiveProvider` (file:619-637). Each case runs through `ConversationHarness` — i.e. real planner, real action loop. The pass/fail rule (file:287-344): `actualPrimaryAction` must equal `expectedAction` (or be in `acceptableActions`) and not be in `forbiddenActions`. Real benchmark.

This is the most defensible piece of LifeOps test infrastructure. It is also the only place in the suite that runs the full planner against rewritten prompts. **Verdict: SOLID** — but it requires `ELIZA_LIVE_TEST=1`+API key to actually execute.

### `eliza/packages/app-core/scripts/smoke-lifeops.mjs`

A 306-line script that hits `/api/lifeops/overview`, `/api/browser-bridge/sessions`, `/api/lifeops/connectors/google/status`, optionally `/api/lifeops/calendar/next-context` and `/api/lifeops/gmail/triage`. Asserts response shapes (`hasOverviewShape`, `hasGmailTriageShape` etc., file:67-114). Pure HTTP-shape smoke test. Runs against a deployed instance. Real but narrow. **Verdict: SOLID** for what it claims (a curl-style health check).

---

## LARP Hall of Shame (worst 10)

| Rank | File / Scenario | Damning quote (file:line) |
|---|---|---|
| 1 | `assistant-user-journeys.followup-repair.e2e.test.ts` | `pending[0] ?? (await approvalQueue.enqueue({...repairDraft...}))` (file:363-378) — the test enqueues the approval itself if the agent didn't, then approves it, then directly calls `executeApprovedRequest` and `service.completeFollowUp`. The agent is decoration. |
| 2 | `signature-deadline.e2e.test.ts` | `expect(outboundCalls.length + gmailSends.length, "expected at least one outbound signing nudge via Twilio or Gmail").toBeGreaterThanOrEqual(0)` (file:165-170) — literally `count >= 0`, always true. |
| 3 | `assistant-user-journeys.morning-brief.e2e.test.ts` | `expect(response).not.toMatch(/something (?:went wrong|flaked)|try again/i)` (file:307) is the only check on the agent reply; everything else asserts on triage rows the fixture seeded (file:328-334). |
| 4 | `flight-rebook.e2e.test.ts` | When the agent doesn't propose alternatives AND no approval shows, the test enqueues a `book_travel` approval itself (file:148-187), then asserts `pending.length > 0 \|\| hasSafeIntermediateStep`. The `\|\|`-clause makes it pass on any non-error reply. |
| 5 | `daily-brief.drafts.e2e.test.ts` | Seeds two drafts in the approval queue (file:61-95), asserts the queue contains those drafts (file:140-154). The agent reply is checked only against `not.toMatch(/something went wrong/i)`. The journey claims "the brief mentions the drafts" but the brief is never inspected. |
| 6 | `helpers/lifeops-deterministic-llm.ts` | `if (normalized.includes("brushed my teeth")) return { operation: "complete_occurrence", ... }` (file:107) — the planner's answer is keyed off the exact phrase the test author wrote. Then the assertion checks `complete_occurrence` was selected. |
| 7 | `cross-channel-composition.scenario.ts` + `helpers/lifeops-deterministic-llm.ts:566` | Scenario asserts `plannerIncludesAll: ["owner_send_message", "alice@example.com"]`. Deterministic LLM literally returns `target: "alice@example.com"` for any prompt containing `"alice@example.com"`. Round-trip. |
| 8 | `goal-sleep-basic.scenario.ts` + judge LARP | Three turns each gated by `responseJudge`. The deterministic-LLM judge always returns `{passed: true, score: 1, reasoning: "Deterministic fixture pass."}` (deterministic-llm.ts:670-678). Every judge passes. |
| 9 | `cancellation-fee.e2e.test.ts` | Sole assertion `expect(reply).not.toMatch(/something went wrong/i)` (file:112). The actual journey is `it.todo("proactively surfaces ... at T-24h")` (file:117). Test name says "warns the user about the cancellation fee" but tests neither warning nor fee. |
| 10 | `eow-escalation.e2e.test.ts` | `if (smsCalls.length > 0) { expect(smsCalls[0]?.path ?? "").toMatch(/messages/i); }` (file:136-138) — the only meaningful assertion is gated on the prerequisite existing, so when SMS doesn't fire, the test silently passes. |

Honourable mentions (only just missed top 10):
- `portal-upload.e2e.test.ts` — `expect(browserRequests).toHaveLength(0)` when `BROWSER_WS_AVAILABLE=false` (file:127). Asserting that nothing happens when the prerequisite isn't there.
- `assistant-user-journeys.identity-merge.live.e2e.test.ts` — `acceptCanonicalIdentityMerge` is called in `beforeAll` (file:171), so the merge is done before the agent is asked.
- `gmail-direct-message-sender-routing.scenario.ts` — `plannerIncludesAll: ["gmail_action", "pat"]` (file:24) where "pat" is from the user prompt.
- `one-off-mountain-time.scenario.ts` — every needle in `responseIncludesAny: ["hug", "wife", "8:00", "8pm", "april 17", "mountain"]` (file:24-32) is in the prompt; the time-zone (file:42) is hard-coded by the deterministic helper.
- `lifeops-life-chat.real.test.ts` — passes explicit `action: "create"` and `confirmed: true` to bypass action selection (file:42, 75-78). Comment admits this. Tests parameter extraction in isolation, not action routing.

---

## Coverage Cliff — categories with 0 SOLID end-to-end coverage

A category has SOLID coverage only if at least one **default-CI-runnable** test (no `ELIZA_LIVE_TEST=1` gate) exercises tool-search → planner → action with a meaningful outcome assertion that fails when the planner is broken.

| Journey category | SOLID default-CI? | Notes |
|---|---|---|
| **Morning brief assembly** (the multi-section daily brief journey) | **NO** | All coverage is in `assistant-user-journeys.morning-brief.e2e.test.ts` (skipped + LARP), `default-pack-morning-brief.parity.test.ts` (SOLID but only asserts byte-parity of the prompt builder, never the agent), and `lifeops-chat.live.e2e.test.ts` (skipped). The morning-brief journey is invisible to CI. |
| **Calendar reschedule / move** | **NO** | Coverage is `calendar-llm-eval-mutations.scenario.ts` (SOFT, deterministic-LLM hard-codes the answer) and `lifeops-chat.live.e2e.test.ts`/`multilingual-action-routing.integration.test.ts` (both `ELIZA_LIVE_TEST=1`). |
| **Inbox triage / draft sign-off** | **NO** | `lifeops-inbox-triage.integration.test.ts` is SOLID at the **repository** layer only (ranking SQL). The `daily-brief.drafts.e2e.test.ts` "agent surfaces drafts" journey is LARP-and-skipped. No CI test asserts the agent surfaces an unsent draft. |
| **Sleep / health goal grounding** | **NO** | `goal-sleep-basic.scenario.ts` is LARP (judge always passes; deterministic helper hard-codes the goal title). No CI assertion that the planner asks for missing fields. |
| **Screen-time / website-blocker** | partial | `screen-time.real.test.ts` is SOLID at the service layer; `workout-blocker-basic.scenario.ts` covers definition+websiteAccess (SOLID-ish). End-to-end "blocker actually blocks" is **untested** (`selfcontrol-*.live.*` are all skipped). |
| **Cross-channel send / draft preview** | **NO** | `cross-channel-composition.scenario.ts` is LARP via deterministic helper. `cross-channel-search.integration.test.ts` skips the planner with explicit `query` param. No CI assertion that the planner picks `owner_send_message` for a real recipient. |
| **Travel booking / flight rebook** | **NO** | `book-travel.approval.integration.test.ts` SOLID at approval layer only. `flight-rebook.e2e.test.ts` and `booking-preferences.e2e.test.ts` are LARP-and-skipped. `travel-duffel.integration.test.ts` SOLID at config-parsing layer only; live block skipped. |
| **Document signing / DocuSign** | **NO** | `signature-deadline.e2e.test.ts` is the worst LARP (`>= 0` assertion). `eow-escalation.e2e.test.ts` is gated and trivial. |
| **Browser automation / portal upload / autofill** | **NO** | `portal-upload.e2e.test.ts` is LARP-when-skipped (asserts length=0). `lifeops-extension.see-what-user-sees.scenario.ts` is `status: "pending"`. `1password-autofill.*.scenario.ts` not in audit scope. |
| **Push notifications / Twilio escalation** | **NO** | `notifications-push.e2e.test.ts` SOLID at config layer only; live block skipped. `cancellation-fee.e2e.test.ts`, `stuck-agent-call.e2e.test.ts`, `eow-escalation.e2e.test.ts` all skipped + LARP. |
| **Identity merge / cross-platform contact disambiguation** | **NO** | `assistant-user-journeys.identity-merge.live.e2e.test.ts` is skipped + LARP (helper merges first). `entities.e2e.test.ts` and `relationships-graph.e2e.test.ts` SOLID at the store layer only. The agent never has to decide whether to merge. |
| **Group-chat handoff** (proposing a group chat from converging threads) | **NO** | `group-chat-handoff.e2e.test.ts` is skipped + TRIVIAL (only `not.toMatch(...)` assertion). `handoff.e2e.test.ts` SOLID at the handoff-store layer (no LLM). |
| **Pause / vacation mode** | partial | `global-pause.integration.test.ts` SOLID at store layer + action handler with explicit `verb`. `habit.pause-while-traveling.scenario.ts` SOLID through `CHECKIN`. End-to-end "user says vacation, agent stops nudging" is untested. |
| **Workflow event triggers (calendar.event.ended)** | **YES** | `workflow.event.calendar-ended.{create,filter-mismatch,fires}.scenario.ts` are all SOLID, default-CI-runnable. |
| **Reminder lifecycle (ack / snooze / complete)** | **YES** | `reminder-lifecycle-{ack-complete,snooze}.scenario.ts` are SOLID. `reminder-review-job.real.e2e.test.ts` adds 442 lines of coverage. |
| **Habit creation (single happy path)** | **YES** | `brush-teeth-basic.scenario.ts` etc. are SOFT-but-DB-anchored; `habit.morning-routine.full-stack.scenario.ts` covers multi-habit creation. |
| **Habit escalation / pause / streak** | **YES** | `habit.missed-streak.escalation.scenario.ts` and `habit.pause-while-traveling.scenario.ts` are SOLID. |
| **Approval queue state machine** | **YES** | `approval-queue.integration.test.ts` exhaustively. |
| **First-run / customize / replay** | **YES** | `first-run-{defaults,customize,replay,abandon-resume,config-validation}.test.ts`. |
| **ScheduledTask spine** | **YES** | `scheduled-task-end-to-end.e2e.test.ts`, `spine-and-first-run.integration.test.ts`, `stretch-gate-parity.parity.test.ts`. |

---

## Patterns to fix

1. **Eliminate `expect(reply).not.toMatch(/something went wrong/i)` as the sole reply assertion.** It is a "did the agent crash" probe, not a behavioural test. If the journey says the agent surfaces X, the test must read the reply and assert X.
2. **Eliminate the `expect(... \|\| ...).toBe(true)` and `>= 0` patterns.** Every example I found (flight-rebook:191, signature-deadline:165, eow-escalation:136, portal-upload:127, booking-preferences:115) was a way to make a flaky behaviour test always pass.
3. **Stop self-enqueuing in LARP fallback branches.** `flight-rebook` and `followup-repair` both seed the approval the agent should have created when the agent fails to. If the agent fails, the test must fail.
4. **Stop asserting on JSON.stringify of the action result.** When the seed wrote `safari` and the assertion checks `payload.includes("safari")`, you've proven the seed survived JSON serialisation, not that the agent did anything.
5. **Quarantine the deterministic-LLM helper.** Every scenario that was ever run against `lifeops-deterministic-llm.ts` is by definition LARP. The helper should be deleted or restricted to tests that explicitly assert on its hard-coded path. Currently no consumers exist — delete it.
6. **Either run live tests in CI or stop relying on them.** 30+ `.e2e.test.ts` files gate on `ELIZA_LIVE_TEST=1`. The non-skipped portion of the suite is dominated by store/handler-layer tests with explicit subactions — there is no default-CI test that verifies the planner picks the right umbrella action for a real prompt. The prompt-benchmark CLI is the right shape but it too requires `ELIZA_LIVE_TEST=1`.
7. **Stop using the morning-brief / identity-merge fixtures as input.** Both pre-write the answer the test then asserts. If you want to test the agent's brief assembly, seed the *raw* messages and let the agent classify, summarise, and rank.
8. **Drop `.todo` placeholders from scenario files.** Several "journey" tests (cancellation-fee, eow-escalation, signature-deadline, portal-upload, flight-rebook) have `it.todo` for the actual journey body and a smoke `it()` whose only assertion is `not.toMatch(/something went wrong/i)`. The headline test passes; the journey is unimplemented. Either implement the journey or delete the file.

---

## File-path index (all paths absolute, all lifeops-relevant)

Helpers (LARP factories):
- `/Users/shawwalters/milaidy/eliza/plugins/app-lifeops/test/helpers/lifeops-deterministic-llm.ts`
- `/Users/shawwalters/milaidy/eliza/plugins/app-lifeops/test/helpers/lifeops-chat-runtime.ts`
- `/Users/shawwalters/milaidy/eliza/plugins/app-lifeops/test/helpers/lifeops-morning-brief-fixtures.ts`
- `/Users/shawwalters/milaidy/eliza/plugins/app-lifeops/test/helpers/lifeops-identity-merge-fixtures.ts`
- `/Users/shawwalters/milaidy/eliza/plugins/app-lifeops/test/helpers/lifeops-live-judge.ts` (live judge — SOLID)
- `/Users/shawwalters/milaidy/eliza/plugins/app-lifeops/test/helpers/lifeops-live-harness.ts` (live runtime spawn — SOLID)
- `/Users/shawwalters/milaidy/eliza/plugins/app-lifeops/test/helpers/lifeops-prompt-benchmark-cases.ts`
- `/Users/shawwalters/milaidy/eliza/plugins/app-lifeops/test/helpers/lifeops-prompt-benchmark-runner.ts`

Top-3 LARP files to fix or delete:
- `/Users/shawwalters/milaidy/eliza/plugins/app-lifeops/test/assistant-user-journeys.followup-repair.e2e.test.ts` (test does the agent's job)
- `/Users/shawwalters/milaidy/eliza/plugins/app-lifeops/test/signature-deadline.e2e.test.ts` (`>= 0` assertion)
- `/Users/shawwalters/milaidy/eliza/plugins/app-lifeops/test/flight-rebook.e2e.test.ts` (self-enqueue fallback)

Coverage gap test files to add:
- A default-CI version of `assistant-user-journeys.morning-brief.e2e.test.ts` that reads the reply and asserts the agent named the seeded drafts (without judges).
- A default-CI version of `daily-brief.drafts.e2e.test.ts` that asserts the brief mentions `DRAFT_SUBJECT_1` or `DRAFT_RECIPIENT_1`.
- A default-CI prompt-benchmark slice that runs against a tiny canned model (e.g. a forced-stub provider) so the planner→action contract is checked without a paid API key.
