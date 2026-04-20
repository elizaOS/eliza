# LifeOps LARP Audit — 2026-04-19

A "LARP" finding is code that looks functional but isn't. This document is
the authoritative queue of issues found during the 2026-04-19 audit that
remediation should work through. It is ordered from highest to lowest
severity.

Companion to `REMEDIATION_LOG.md` — that log records what has been fixed,
this document records what was found (including items that have been
remediated since). When an item is remediated, move it to REMEDIATION_LOG.md
with fix options, selected approach, and risk checks.

Conventions:
- `[open]` — not fixed yet
- `[fixed:<commit>]` — fixed, commit hash (on `shaw/larp-audit-fixes`)
- `[false-positive]` — investigated, not actually a LARP

---

## CRITICAL — code actively lies about what it did

### L1 [open] `APPROVE_REQUEST` marks approval but never executes
- `src/actions/approval.ts:146-167`
- `queue.approve(...)` is called; `markExecuting` / `markDone` are never
  invoked from any action handler (verified with `grep -r markExecuting
  src/actions`).
- No email is sent, no booking made, no cross-channel message dispatched.
- Handler returns `{ success: true, text: "Approved request ${updated.id}." }`
  — the user believes the action happened.
- Fix: add an approval executor that dispatches the ApprovalPayload via
  existing send paths (cross-channel-send, gmail, calendar, twilio). For
  unimplemented action kinds, return `success: false` with
  `APPROVED_BUT_EXECUTOR_NOT_WIRED` rather than fake success.

### L2 [open] Scheduling negotiations write DB rows but never contact counterparty
- `src/lifeops/service-mixin-scheduling.ts:20-209`
- `startNegotiation`, `proposeTime`, `finalizeNegotiation`,
  `respondToProposal`, `cancelNegotiation` all just upsert rows via
  `repository.upsertSchedulingNegotiation` / `upsertSchedulingProposal`.
- No email sent, no Google Calendar event created, no Telegram/Discord
  message, no Calendly invite dispatched.
- Yet `actions/scheduling.ts:991,1051` reports "Started" / "Confirmed".

### L3 [open] Subscription cancellation playbooks default to "open URL + screenshot"
- `src/lifeops/subscriptions-playbooks.ts:152-157` — `definePlaybook` default.
- ~40 branded services (Netflix L351, Spotify L450, Disney+ L367, Max L375,
  Prime L416, YouTube L424, ChatGPT L671, Apple Music L457, …) use the
  default — no override supplied.
- Default steps: `[ {kind:"open", url}, {kind:"screenshot", label:"opened"} ]`
  — no click, no confirm, no actual cancellation.
- Only Google Play / Apple Subscriptions / Fixture override with real click
  flows, which makes the default-empty cancel look deliberate.

### L4 [open] Reminder enforcement overrides wired but never invoked
- `src/lifeops/service-mixin-reminders.ts:2657` explicit TODO:
  ```
  // TODO: wire enforcement overrides here — call
  // buildReminderEnforcementState(now, timezone, definition, twilioVoiceAvailable)
  // and applyEnforcementOverrides(delayMinutes, state) to shorten the gap
  // for morning/night routine occurrences, and force a voice channel
  // when state.forceVoice is true.
  ```
- Both helpers are exported from the same file (L131, L170) but the
  dispatch path never calls them. `enforcement-windows.ts` exists solely
  to feed this unused codepath.

### L5 [fixed:pending] x_dm regression contradicts REMEDIATION_LOG #6
- `src/actions/cross-channel-send.ts` still advertises and dispatches `x_dm`
  at L16 (docstring), L62 (supported channel), L432-469 (dispatcher).
- `src/actions/relationships.ts:686` still lists x_dm as a contact channel.
- `src/actions/search-across-channels.ts:151, 443` still lists "x-dm" as a
  searchable channel.
- Fix: drop x_dm from all three.

---

## HIGH — production success shortcuts / mock paths

### L6 [open] `password-manager-bridge.ts` fixture backend fakes clipboard write
- L583-585: `if (backend === "fixture") return { ok: true, expiresInSeconds: CLIPBOARD_TTL_SECONDS };`
- Gated by `MILADY_TEST_PASSWORD_MANAGER_BACKEND` or `MILADY_BENCHMARK_USE_MOCKS=1`.
- `actions/password-manager.ts:207-222` reports "Copied ${field} to clipboard…" — a lie.
- Fix: surface a `fixtureMode: true` flag on the return and propagate into
  the action text, or perform a real `pbcopy` of a fake value so downstream
  readers can observe the mode transparently.

### L7 [open] `remote-desktop.ts` mock mode fabricates `vnc://127.0.0.1/mock/<id>` as "active"
- L422-434: `if (mockEnabled) { … status: "active", accessUrl: "vnc://127.0.0.1:…/mock/${id}" }`
- `MILADY_TEST_REMOTE_DESKTOP_BACKEND` / `MILADY_BENCHMARK_USE_MOCKS=1`.
- Action wrappers present this URL as a real pixel transport.

### L8 [open] `START_REMOTE_SESSION` returns `success:true` when data plane missing
- `src/actions/start-remote-session.ts:139-153` — when `result.ingressUrl === null`,
  returns `success: true, values: { success: true, ingressUrl: null }`.
- Should be `success: false` because no pixel transport is up.

### L9 [open] `checkin.ts` + `update-owner-profile.ts` return empty text
- `src/actions/checkin.ts:67-72, 148-153` — `text: ""` while examples promise
  rich human summaries.
- `src/actions/update-owner-profile.ts:90-98, 99-108` — same pattern.
- Callers reading `result.text` get nothing; only `data` is populated.

### L10 [open] `autofill.ts` `saveUserDomains` silent drop when cache missing
- `src/actions/autofill.ts:63-69`:
  `async function saveUserDomains(runtime, domains) { if (!hasRuntimeCache(runtime)) return; await runtime.setCache(...); }`
- When runtime lacks cache, the handler still returns
  `{ text: "Added ${normalized} to the autofill whitelist.", success: true, values: { added: true } }`
  — telling the owner the domain was added when it wasn't.

### L11 [open] `service-helpers-browser.ts:332` `summarize` step is string-concat, not an LLM call
- Callers configure `{ kind: "summarize", prompt: "In 2 bullets, what are the risks?" }`.
- `summarizeWorkflowValue(value, prompt)` prepends the prompt as a prefix
  and hand-codes `count of events / messages`. The prompt never reaches a
  model.
- Fix: rename to `describeWorkflowValue` (deterministic templating) + deprecate
  old name, or actually invoke `runtime.useModel(TEXT_LARGE, ...)` at the
  workflow step boundary.

### L12 [open] Scheduler LLM planner tick uses empty snapshot
- `src/lifeops/runtime.ts:168-181` — every tick:
  ```
  plannerContext = { jobKind: "meeting_reminder", subjectUserId, snapshot: { now, scheduler: "LIFEOPS_SCHEDULER" }, ... };
  planJob(runtime, plannerContext); // result not used by dispatch
  ```
- No occurrences, no calendar context, no overdue set — the LLM has
  nothing to plan with. `planJob` usually returns noop or hallucinates.
- Real dispatch is `processScheduledWork`. The LLM call is performative.
- Fix: either populate the snapshot with real state before calling planJob,
  or remove the performative call.

### L13 [open] `plugin.ts:150-166` fire-and-forget task-ensure violates REMEDIATION_LOG #8
- REMEDIATION #8 claims: "Scheduler task init failure after retries must
  abort init."
- Reality: `scheduleTaskEnsureAfterRuntimeInit` kicks a `void
  initPromise.then(...).catch(...)` after init() returns. The `.catch` just
  `logger.error`s; init() already resolved successful.
- Fix: surface failure via runtime cache flag + error log, and update the
  comment so the contract isn't misrepresented.

---

## MEDIUM — silent catches, fake status

### L14 [open] Connector status methods claim "connected" based only on env presence
- `service-mixin-whatsapp.ts:20-29`, `service-mixin-notifications.ts:60-69`,
  `service-mixin-travel.ts:197-214`, `service-mixin-x.ts:58-69`.
- `connected: true` is returned the moment env credentials exist — no API
  probe verifies the token is live. `inbound: true` is hardcoded for
  WhatsApp regardless of webhook registration.
- Fix: at minimum add JSDoc clarifying the semantic on the shared contract;
  ideally add a cached liveness probe.

### L15 [open] `notifications-push.ts:140` fabricates messageId
- `const messageId = data.id ?? \`ntfy-${Date.now()}\`;`
- Any caller storing messageId for lookup will hit a mismatch because the
  fabricated id doesn't round-trip through ntfy.
- Fix: return `string | null`, let caller decide.

### L16 [open] `calendly-client.ts` fabricates `expiresAt = +7d` locally
- `createCalendlySingleUseLink` L345 ignores whatever Calendly returns and
  hardcodes a 7-day expiry.
- Fix: read the actual `expires_at` from `response.resource`, or return
  `null` if Calendly didn't send one.

### L17 [open] `calendly-client.ts` assumes all slots are 30 min
- `getCalendlyAvailability` L301: `const end = new Date(start.getTime() + 30 * 60 * 1000);`
- Event-type durations are ignored — a 60-min meeting type gets truncated to
  30 min in the returned slot.
- Fix: fetch the event type via GET /event_types/:uri and use its `duration`.

### L18 [open] `service-mixin-signal.ts` `stopSignalPairing` returns hardcoded empty shape
- L315-327 returns `{ sessionId: "", state: "idle", qrDataUrl: null, error: null }`
  regardless of whether `stopSignalPairingFlow` succeeded.
- Fix: propagate the real flow result.

### L19 [open] `app-state.ts` silent swallow of setCache failures
- `saveLifeOpsAppState` L43-60 `catch { logger.debug(...) }`.
- UI toggling LifeOps on/off doesn't detect persistence failures.

### L20 [open] `life-recent-context.ts` swallows `getMemories` errors with no log
- L88-107 `catch { return stateTexts; }`.
- Every action relying on recent conversation silently loses memory context.

### L21 [open] `x-read.ts` validate swallows connector-status errors
- L237-245 `catch { return false; }`.
- Owner cannot tell why X read is greyed out.

### L22 [open] `checkin/checkin-service.ts:95,132,173` collectors silently return `[]` on SQL error
- Three collectors (`collectOverdueTodos`, `collectTodaysMeetings`,
  `collectYesterdaysWins`) log-once per process then return `[]`.
- Morning/night check-ins claim "0 overdue, 0 meetings, 0 wins" as if
  those truly were zero. Callers cannot distinguish "no data" from "SQL
  threw".

### L23 [open] `runtime.ts:211-218` `shouldRun` on error returns `true`
- ```
  shouldRun: async (rt) => {
    try { ... } catch { return true; }
  }
  ```
- If cache is broken, scheduler keeps running even when LifeOps is disabled.

### L24 [open] `goal-semantic-evaluator.ts:196-198` blanket `catch { return null }`
- Any LLM call failure collapses to "no evaluation". Upstream goal-review UI
  sees this as "inconclusive" rather than "evaluator broken".

### L25 [open] `health-bridge.ts:696-701` vs L668-671 inconsistent error contract
- `healthKitDataPoints` returns `[]` when cliPath missing. `getDailySummary`
  throws for the same condition. Sibling methods should agree.

### L26 [open] `background-planner-dispatch.ts:155` unbounded dispatch log
- `log.push(result)` with no size cap, no drain outside test helpers.
- Long-lived agents leak memory at the rate of dispatch events.

### L27 [open] `intent-sync.ts:19-21` comment lies about cross-device replication
- Comment implies "other devices will see this via device-bus bridge".
- Reality: table is local-only; two agent processes on different machines
  never see each other's intents unless they share a DB.

### L28 [open] `unified-search.ts:27-33`, `background-planner.ts:367-373` "not yet" markers
- "WS3 dependency — types may not yet be exported when this file is first
  compiled."
- "For schedule/modify/cancel/book/call/spend the upstream caller has not
  yet wired structured payload extraction." — 6 of 9 sensitive action kinds
  return `null` payload; `background-planner-dispatch.ts:106-119` skips
  them with "sensitive action without usable payload". Planner effectively
  only enqueues `send_message` / `send_email` today.

---

## LOW — inconsistent result shape, cosmetic

### L29 [open] `success: true + values.success: false` pattern is inconsistent
- Seen in many action files (`twilio-call.ts`, `intent-sync.ts`,
  `remote-desktop.ts`, `app-blocker.ts`, `website-blocker.ts`, `health.ts`,
  `search-across-channels.ts`, `x-read.ts`, `scheduling.ts`, `inbox.ts`,
  `relationships.ts`, `life.ts`). Callers reading only one field get the
  wrong signal.

### L30 [open] `calendly.ts` switch has no fallthrough return
- Handler's `switch (subaction)` returns from each case; no default, no
  trailing return. If a new subaction slips past validation, function falls
  off end and returns `undefined` — not an `ActionResult`.

---

## TEST LARPS

### T1 [fixed:81ec268d4e] `lifeops-no-heuristics.contract.test.ts` is grep-over-source
- All 20 tests do `readFile + expect.not.toContain`. No behavior runs.
- Commit `81ec268d4e` added a file header and renamed the describe so
  future contributors don't mistake it for a behavioral contract.

### T2 [open] `lifeops-executive-assistant-prd-contract.test.ts` shape-only
- Loads 22 scenario files; asserts they have certain `type` strings and
  `assertTurn` functions. Nothing runs any scenario. Predicate dry-run at
  L206-209 is called with empty turns so any predicate passes.

### T3 [open] `lifeops-self-care-prd-contract.test.ts` shape-only
- Same pattern. Compares JSON PRD fixtures to TS scenarios — neither ever
  executes.

### T4 [open] `lifeops-connector-certification.contract.test.ts` shape-only + source-grep
- Asserts scenario tags and runs regex over shared contract TypeScript
  source for interface-name matches. No connector is actually certified.

### T5 [open] `gmail-plan-extractor.test.ts` mocks the thing under test
- All 5 tests mock `useModel` to return hardcoded JSON and then assert the
  extractor returns a transformation of that JSON. Since Gmail plan
  extraction IS the LLM call + parse + normalize, mocking `useModel` leaves
  only JSON passthrough being tested.

### T6 [open] `browser-portal.scenario.test.ts` fixture pre-wired with canned responses
- `helpers/browser-portal-scenario-fixture.ts:366-425` hardcodes action
  results by regex on input text. `useModel` is hard-banned. Scenario passes
  because the fixture always answers correctly.

### T7 [open] `subscriptions.scenario.test.ts` same fixture-fake-LLM pattern
- L16-37 `resolveSubscriptionParams` is a 20-line regex router that replaces
  the planner.

### T8 [open] `background-job-parity.contract.test.ts:319` swallows scheduler errors
- `try { await executeLifeOpsSchedulerTask(runtime); } catch { /* ignore */ }`
  at L329-334 and L378-389. If scheduler crashes, test still passes as long
  as the dispatch log has an entry.

### T9 [open] `approval.dispatch.integration.test.ts` mocks the dispatch being tested
- `vi.spyOn(LifeOpsService.prototype, "sendTelegramMessage").mockResolvedValue(...)`
  — the "dispatch integration" replaces the real dispatch. Asserting
  `sendSpy.toHaveBeenCalledWith(...)` is asserting on the mock.

### T10 [open] `google-drive.integration.test.ts` test that can't fail
- L38-45 — both branches assert `"" === ""`. If creds set, early return; if
  absent, trivial assertion. `GOOGLE_OAUTH_TEST_TOKEN` isn't set in any CI
  workflow, so the actual `itIf` tests always skip.

### T11 [open] Always-skipped live tests
- `notifications-push.integration.test.ts:178` skipIf !NTFY_BASE_URL
- `travel-duffel.integration.test.ts:409` skipIf !DUFFEL_API_KEY
- Neither env var appears in any `.github/workflows/*.yml`.

### T12 [open] "mocks-module-then-asserts-mock-was-called" pattern in many tests
- `remote-desktop-action.test.ts`, `dossier-action.test.ts`,
  `cross-channel-send.test.ts`, `computer-use.test.ts`, `x-read.test.ts`,
  `lifeops-plugin.test.ts`. Each mocks the target module and then asserts
  on the mocks — doesn't exercise the real path.

---

## False positives from the original audit

- `service-mixin-x-read.ts` — auditor reported that `syncXDms`/`syncXFeed`/
  `searchXPosts` "silently return cached rows when credentials are missing".
  Actually, all three call `fail(409, "X credentials are not configured.")`
  from `service-normalize.ts`, which throws. The LARP is NOT present.

- `scenarios/*.json` orphaned — auditor said these were unused. They ARE
  used by `lifeops-self-care-prd-contract.test.ts` (shape comparison to TS
  scenarios). The contract test itself is weak (T3 above), but the JSON
  files aren't orphaned.
