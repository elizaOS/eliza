# Plan: LifeOps Coverage Closure Implementation

Status: Research-backed draft complete
Date: 2026-04-19
Owner: Codex
Related:
- [PRD](../prd-lifeops-executive-assistant.md)
- [executive-assistant scenario matrix](../plan-lifeops-executive-assistant-scenario-matrix.md)
- [executive-assistant capability closure](2026-04-17-executive-assistant-capability-closure.md)
- [E2E action testing PRD](../prd-e2e-action-testing.md)

## Goal

Close the gap between LifeOps feature breadth and LifeOps proof. The target state is:

1. The full executive-assistant operating loop is covered by strict live E2E tests, not only scenario contracts.
2. Connector certification proves both happy and degraded paths.
3. Background jobs and cron-triggered flows are tested as real execution, not just schedule creation.
4. Existing scenario breadth is converted from `NotYetImplemented` scaffolding into executable, behavior-level coverage in priority order.

## Current Ground Truth

- Live and real app-lifeops tests: `80`
- LifeOps-related scenario files: `228`
- Scenario files still containing `NotYetImplemented`: `106`
- The new `executive-assistant/` and `connector-certification/` suites are executable and contract-enforced.
- The broader historical scenario corpus still contains major NYI debt across calendar, messaging, gateway, remote, reminders, browser, activity, goals, and todos.
- Several live E2Es currently use rescue reprompts or retry loops, which is useful resilience coverage but weaker than strict first-turn quality coverage.
- Some "real" tests still inject explicit action selection, which means they do not prove the full LLM planner -> action path.

## Implementation Principles

1. Prefer strict seeded live E2Es for critical executive-assistant loops.
2. Keep recovery and retry coverage, but move it into explicitly named recovery suites instead of mixing it into strict suites.
3. Every sensitive flow must assert approval creation, transition, and no-side-effect-on-reject.
4. Every connector certification family must gain degraded-state coverage.
5. Every new scenario should assert action shape, side effect, and judge rubric.
6. Burn down `NotYetImplemented` debt by value, not by directory completeness.

## Workstream Index

1. Strict live executive-assistant morning brief E2E
2. Strict live travel booking and sync E2E
3. Strict live docs/browser/portal E2E
4. Strict-vs-recovery live suite split
5. Connector degradation matrix
6. Cron and background execution suite
7. Canonical identity merge live suite
8. Missed-commitment repair live E2E
9. Push ladder with ack suppression live E2E
10. `NotYetImplemented` scenario debt burn-down

## Workstream 1: Strict Live Executive-Assistant Morning Brief E2E

### Outcome

One strict live E2E proves the assistant can assemble a real morning operational brief from seeded inbox, calendar, pending drafts, follow-ups, and docs state without rescue reprompts.

### Target Behavior

- User asks once for the morning brief.
- Assistant returns:
  - top actions first
  - urgent blockers
  - meetings and time-sensitive reminders
  - unsent drafts awaiting approval
  - doc or workflow blockers
  - unread cross-channel items grouped by canonical person where applicable
- Test fails on first-turn miss; no fallback coaching turn.

### Primary Files

- `eliza/apps/app-lifeops/test/assistant-user-journeys.live.e2e.test.ts`
- `test/scenarios/executive-assistant/ea.inbox.daily-brief-cross-channel.scenario.ts`
- `test/scenarios/executive-assistant/ea.inbox.daily-brief-includes-unsent-drafts.scenario.ts`
- `test/scenarios/relationships/followup.daily-digest.scenario.ts`
- inbox, calendar, dossier, cross-channel search, and approval code under `eliza/apps/app-lifeops/src`

### TODOs

- [ ] Add a new strict live E2E file or strict section in the existing assistant-user-journeys suite.
- [ ] Extend `seedGoogleConnector` in `eliza/apps/app-lifeops/test/assistant-user-journeys.live.e2e.test.ts` to grant Drive read scope in addition to Gmail/Calendar.
- [ ] Add `seedDocsData` in `assistant-user-journeys.live.e2e.test.ts` that either reads a real Google Doc through the Drive mixin or writes a deterministic doc summary into memory for the brief.
- [ ] Add `seedFollowupData` in `assistant-user-journeys.live.e2e.test.ts` that creates overdue relationships and runs the follow-up reconciler so overdue state exists before the brief turn.
- [ ] Add a pending-draft seed that matches the `latestPendingDraft()` lookup shape used by the inbox action.
- [ ] Add a Discord room plus a Telegram room in the harness and make one person appear in both so canonical merge behavior is exercised.
- [ ] Add assertions on structure order: actions -> blockers -> schedule/reminders -> drafts -> channel summaries.
- [ ] Add assertions on specific seeded facts so the test proves grounded retrieval rather than plausible prose.
- [ ] Assert no rescue turn occurs in the strict variant.
- [ ] Rewrite the strict morning-brief prompt to explicitly request actions, today’s schedule, unread-by-channel, pending drafts, overdue follow-ups, and docs/blockers in one answer with no follow-up questions.
- [ ] Tighten or replace `test/scenarios/executive-assistant/ea.inbox.daily-brief-cross-channel.scenario.ts` so it expects pending drafts, overdue follow-ups, and docs instead of only actions/reminders/unread.
- [ ] Expand accepted actions for the strict brief scenario to include the actual surfaces needed: `INBOX` or `OWNER_INBOX`, `GMAIL_ACTION`, `CALENDAR_ACTION`, `SEARCH_ACROSS_CHANNELS`, and the follow-up surface.
- [ ] If harness-only seeding is insufficient, extend the inbox digest path so it can include pending drafts and follow-up summaries instead of only triaged inbox entries.
- [ ] Keep a separate recovery variant if desired, but name it as recovery-only coverage.

### Acceptance Criteria

- First-turn response includes the seeded urgent item, a meeting/time item, a pending draft, and a follow-up/doc blocker.
- The answer is grouped and ordered, not a blob.
- The brief does not ask the user which channel or which inbox to check.

## Workstream 2: Strict Live Travel Booking And Sync E2E

### Outcome

A live flow proves search -> hold -> approval -> book -> calendar sync -> confirmation.

### Target Behavior

- User requests travel help.
- Assistant searches options and proposes a hold or candidate itinerary.
- Assistant creates an approval request before booking.
- After approval, the booking executes and the itinerary is reflected in calendar state.
- A final confirmation is delivered with concrete itinerary details.

### Primary Files

- `test/scenarios/executive-assistant/ea.travel.book-after-approval.scenario.ts`
- `test/scenarios/executive-assistant/ea.travel.flight-conflict-rebooking.scenario.ts`
- `eliza/apps/app-lifeops/test/travel-duffel.integration.test.ts`
- calendar, approval queue, and travel adapter code under `eliza/apps/app-lifeops/src`

### TODOs

- [ ] Choose the minimum viable live travel adapter path for strict E2E.
- [ ] Compose `withTravel` into `LifeOpsService` and upgrade the travel service mixin from search-only to refresh/hold/book/payment/order retrieval.
- [ ] Extend `travel-duffel.integration.test.ts` to cover refresh-before-booking, create order, hold order, create payment, and get order.
- [ ] Register `APPROVE_REQUEST` and `REJECT_REQUEST` in the app-lifeops plugin and teach the approval action to execute `book_travel` requests instead of only mutating queue state.
- [ ] Add a dedicated `BOOK_TRAVEL` action rather than overloading calendar search or generic external-call behavior.
- [ ] Extend `approval-queue.types.ts` and the background planner so `book_travel` payloads keep the booking identifiers and payment state the executor needs.
- [ ] Add seeded or stub-live offers that can be held and approved deterministically.
- [ ] Wire approval-state assertions into the live test.
- [ ] Assert itinerary lands in calendar or itinerary storage after booking.
- [ ] Reuse the calendar service path to persist confirmed travel artifacts into calendar state with booking metadata.
- [ ] Add a second strict case for conflict-before-flight if feasible.
- [ ] Add negative assertion: reject path does not book.
- [ ] Seed a Google write grant, not only read access, for the strict booking-sync lane.

### Acceptance Criteria

- Booking cannot occur before approval.
- Approval transition is visible.
- Calendar or itinerary state changes after booking.
- User-facing confirmation contains concrete booked details.

## Workstream 3: Strict Live Docs/Browser/Portal E2E

### Outcome

A live docs/browser flow proves artifact intake, approval-gated upload, blocked-state human intervention, resume, and provenance back to the user.

### Target Behavior

- User provides or references an artifact.
- Assistant queues a portal upload behind approval.
- Browser task begins.
- If blocked, the assistant requests intervention.
- After intervention, the task resumes and completes.
- Assistant returns where the upload landed and any provenance or completion handle.

### Primary Files

- `test/scenarios/executive-assistant/ea.docs.portal-upload-from-chat.scenario.ts`
- `test/scenarios/executive-assistant/ea.docs.collect-id-copy-for-workflow.scenario.ts`
- `test/scenarios/connector-certification/connector.browser-portal.certify-core.scenario.ts`
- browser/computer-use/autofill/approval code under `eliza/apps/app-lifeops/src`

### TODOs

- [ ] Pick one portal task path that is deterministic enough for repeated testing.
- [ ] Fix the scenario runner so seeded context survives execution and final checks can assert approval, connector, browser-session, and intervention streams directly.
- [ ] Add a first-class event model for `artifactReceived`, `approvalQueued`, `portalUploadStarted`, `blocked`, `humanIntervened`, `resumed`, and `provenanceReported`.
- [ ] Add seeded artifact support to the scenario schema and runner so uploads are deterministic and inspectable after normalization.
- [ ] Define artifact seed mechanics for deck/document upload.
- [ ] Add a blocked-state fixture or hook that forces human intervention once.
- [ ] Ensure browser-task creation enqueues approval before any upload executes.
- [ ] Add a durable blocked browser-task state with a resumable session token or browser-session id.
- [ ] Expose approval and intervention state through the live queue or scenario hooks so the runner can drive the human step.
- [ ] Add intervention artifact assertions and resume assertions.
- [ ] Add provenance assertion for upload destination or completion ID.
- [ ] Update the docs executive-assistant scenarios, browser-portal certification scenario, and existing login-required browser scenarios to use the same receive -> approve -> start -> block -> intervene -> resume -> report lifecycle.
- [ ] Keep browser extension hooks and computer-use hooks separate unless they truly converge at the same session state.
- [ ] Make provenance required DTO data, not optional metadata in the final response path.
- [ ] Add reject-path assertion for approval denial.

### Acceptance Criteria

- Upload is not silently claimed before it happens.
- Blocked browser state becomes an explicit intervention artifact.
- Resume path completes after intervention.
- Final assistant message includes actual completion details.

## Workstream 4: Strict-Vs-Recovery Live Suite Split

### Outcome

Live E2Es clearly separate first-turn quality from recovery quality.

### Target Behavior

- Strict suites fail on weak first turn.
- Recovery suites explicitly allow retry or repair behavior.
- Coverage dashboard distinguishes these categories.

### Primary Files

- `eliza/apps/app-lifeops/test/assistant-user-journeys.live.e2e.test.ts`
- `eliza/apps/app-lifeops/test/lifeops-gmail-chat.live.e2e.test.ts`
- any other live test using rescue reprompt or retry loops

### TODOs

- [ ] Inventory every live test that currently retries, reprompts, or uses stochastic best-of-N acceptance.
- [ ] Mark each as strict, recovery, or split into two tests.
- [ ] Split `postLiveConversationMessage()` in `eliza/apps/app-lifeops/test/helpers/lifeops-live-harness.ts` into a strict single-attempt path and a named recovery path.
- [ ] Remove rescue prompts from strict branches in `assistant-user-journeys.live.e2e.test.ts`.
- [ ] Remove the `for attempt = 1..3` retry loops from strict Gmail tests in `lifeops-gmail-chat.live.e2e.test.ts`.
- [ ] Keep any eventual-success Gmail retry coverage only in explicitly named recovery or stability tests.
- [ ] Split `lifeops-chat.live.e2e.test.ts` into strict first-turn tests versus multi-turn preview/clarify flows where needed.
- [ ] Replace or split `stochasticTest(...)` usage in `lifeops-calendar-chat.live.e2e.test.ts` so first-turn correctness is not hidden inside best-of-3 behavior.
- [ ] Treat the best-of-3 wrapper in `selfcontrol-chat.live.e2e.test.ts` as stability-only, not strict correctness.
- [ ] Add naming convention and comments so reviewers can see which lane is being exercised.
- [ ] Keep retry coverage only where resilience itself is the product expectation.

### Acceptance Criteria

- A reader can tell whether a passing test proves first-turn quality or recovery quality.
- Strict failures are not masked by a second prompt.

## Workstream 5: Connector Degradation Matrix

### Outcome

Connector certification covers degraded-path behavior, not just happy-path execution.

### Required Degraded Modes

- disconnected
- authenticated but missing required scope
- rate-limited
- retry budget exhausted
- duplicate or idempotent resend protection
- deep-link or provenance unavailable
- reconnect or bridge-health failure where applicable

### Primary Files

- `test/scenarios/connector-certification`
- `eliza/apps/app-lifeops/test/lifeops-connector-certification.contract.test.ts`
- connector status/auth code under `eliza/apps/app-lifeops/src`

### TODOs

- [ ] Add degraded certification scenarios or scenario variants per connector family.
- [ ] Extend `test/scenarios/connector-certification/_factory.ts` to accept `seed`, a degradation-axis label, and axis-specific checks.
- [ ] Add `test/scenarios/connector-certification/_fixtures/` with shared seed helpers for `connectorGrant`, `connectorAuthSession`, `transportFault`, `deliveryLedger`, and `provenanceTrail`.
- [ ] Split the connector catalog into core plus axis-specific variants instead of overloading one `certify-core` file per connector.
- [ ] Define the first degradation matrix across these axes: disconnected, missing scope, rate-limited, retry/idempotent resend, and deep-link/provenance.
- [ ] Upgrade the contract test so one happy-path core scenario is no longer sufficient.
- [ ] Add per-connector acceptance matrices aligned with the PRD and make the contract test fail if any family is missing a required degraded-path scenario.
- [ ] Prefer existing scenario checks where possible for degraded paths; only add new runner primitives if current checks cannot express the state.
- [ ] Add missing degraded-state fields to connector status DTOs in the use-case layer and thread them through routes and client hooks instead of inferring in UI code.
- [ ] Roll out matrix coverage in this order: Google, Telegram, Signal, Discord, Twilio SMS/Voice, WhatsApp, X, iMessage, browser portal, notifications.
- [ ] Add provenance/deep-link assertions where the connector should produce them.

### Acceptance Criteria

- Every connector family passes both happy and degraded release gates.
- Missing auth or missing scope surfaces as actionable assistant state, not silent failure.

## Workstream 6: Cron And Background Execution Suite

### Outcome

Recurring and background LifeOps work is tested as real execution with clock advancement.

### Target Background Jobs

- morning brief
- overdue follow-up sweep
- travel-day itinerary brief
- cancellation-fee warning
- reminder ladder

### Primary Files

- `docs/plan-lifeops-executive-assistant-scenario-matrix.md`
- `eliza/apps/app-lifeops/test/background-job-parity.contract.test.ts`
- `test/scenarios/lifeops.workflow-events`
- trigger/worker code under `eliza/apps/app-lifeops/src`

### TODOs

- [ ] Add or formalize a scenario runner tick primitive.
- [ ] Extend `eliza/packages/scenario-runner/src/scenario-schema.d.ts` and `test/scenarios/scenario-schema-shim.d.ts` to support `seed: { type: "advanceClock" }`, `kind: "tick"`, and `kind: "api"`.
- [ ] Add a logical scenario clock to `eliza/packages/scenario-runner/src/executor.ts` and thread it through executor context and interpolation.
- [ ] Teach the executor to process `advanceClock` seeds before runtime work begins.
- [ ] Add `kind: "tick"` execution that invokes background entry points with the shared logical `now`.
- [ ] Add `kind: "api"` execution so the existing `lifeops.workflow-events` scenarios can run without being rewritten into message turns.
- [ ] Make `executeProactiveTask(...)` accept explicit `now` instead of calling `new Date()` internally.
- [ ] Update the follow-up tracker worker registration path to forward tick time into reconciliation.
- [ ] Pass logical `now` through the lifeops scheduler/runtime seam into reminder and workflow processing.
- [ ] Update trigger runtime scheduling so execution records and next-run calculations can be driven by explicit `now` in tests.
- [ ] Seed background-job prerequisites without going through manual chat setup each time.
- [ ] Add strict assertions on produced brief/warning artifacts and dispatches.
- [ ] Assert background jobs use the same planner/extractor path as chat.
- [ ] Use `ea.followup.bump-unanswered-decision` as the first advance-clock scenario to activate, then expand to morning brief, itinerary brief, and cancellation-fee warning.

### Acceptance Criteria

- Creating a schedule is not enough; the triggered run must actually execute and produce the expected side effect.
- Worker parity is enforced for the PRD job list.

## Workstream 7: Canonical Identity Merge Live Suite

### Outcome

The assistant can merge one human across multiple connectors and reason about them as one person in briefs and follow-ups.

### Target Behavior

- Seed one contact across Gmail, Signal, Telegram, and WhatsApp.
- Ask for the latest or most important context about that person.
- Assistant merges the messages instead of reporting four separate identities.

### Primary Files

- `test/scenarios/messaging.cross-platform`
- `test/scenarios/relationships`
- `eliza/apps/app-lifeops/test/assistant-user-journeys.live.e2e.test.ts`
- identity/search/memory code under `eliza/apps/app-lifeops/src` and `eliza/packages/agent`

### TODOs

- [ ] Add a deterministic canonical-identity fixture helper under `eliza/apps/app-lifeops/test/helpers` with stable UUIDs and explicit Gmail, Signal, Telegram, and WhatsApp identities for one person.
- [ ] Seed same-person multi-channel data with custom seed logic, not only declarative `contact` or `memory` seeds, so the merge evidence is deterministic.
- [ ] Add one strict live merge case to `eliza/apps/app-lifeops/test/assistant-user-journeys.live.e2e.test.ts` that first surfaces the four identities, then asks the assistant to unify them, then asserts the graph resolves to one canonical person with four member identities.
- [ ] Convert `test/scenarios/messaging.cross-platform/cross-platform.same-person-multi-platform.scenario.ts` from placeholder coverage into the real four-platform canonical-merge scenario.
- [ ] Tighten `test/scenarios/messaging.cross-platform/cross-platform.unified-inbox.scenario.ts` so it proves unread routing is deduped by canonical person instead of only emitting a generic inbox summary.
- [ ] Add deterministic graph-level coverage in `eliza/apps/app-lifeops/test/relationships.real.test.ts` or a nearby real test so `getGraphSnapshot()` and `getPersonDetail()` are asserted directly.
- [ ] Ensure `SEARCH_ENTITY`, `LINK_ENTITY`, `search-across-channels`, and `lifeops/unified-search.ts` are reused as the canonical merge path instead of inventing a second identity layer in the test harness.
- [ ] Decide explicitly whether this workstream is graph-centric only or also requires a LifeOps Rolodex schema change.
- [ ] If the UI must collapse the Rolodex into one visible person row, add a canonical-identity bridge in `eliza/apps/app-lifeops/src/lifeops/schema.ts` and `repository.ts` because the current `(agentId, primaryChannel, primaryHandle)` uniqueness model cannot represent one merged four-platform contact cleanly.
- [ ] If one conversation thread must span multiple peer ids, evaluate whether `session.identityLinks` needs to be threaded through `eliza/packages/agent/src/providers/session-bridge.ts` and session config validation.
- [ ] Ensure the brief layer consumes the merged identity graph, not raw connector buckets, once canonical merge exists.

### Acceptance Criteria

- The answer treats the person as one person.
- The assistant can cite or summarize across channels without duplication.
- If this tranche is graph-only, the test suite must still prove one canonical person even if the Rolodex UI remains per-channel.

## Workstream 8: Missed-Commitment Repair Live E2E

### Outcome

The assistant can repair a missed call or meeting end to end.

### Target Behavior

- User admits missing a commitment.
- Assistant identifies the counterpart and context.
- Assistant drafts apology or repair copy.
- Assistant proposes alternate times or a next step.
- Send remains approval-gated.
- Final state confirms the loop was closed.

### Primary Files

- `test/scenarios/executive-assistant/ea.followup.repair-missed-call-and-reschedule.scenario.ts`
- follow-up tracker, relationships, Gmail, and cross-channel send code under `eliza/apps/app-lifeops/src`

### TODOs

- [ ] Add deterministic seed data for the missed event and counterpart context.
- [ ] Expand `test/scenarios/executive-assistant/ea.followup.repair-missed-call-and-reschedule.scenario.ts` from a one-turn draft check into a three-turn lifecycle: detect and draft, approve and send, then confirm loop closure.
- [ ] Add a Gmail seed for the Frontier Tower thread plus matching calendar or missed-call context and a stale relationships seed so the counterpart is overdue at scenario start.
- [ ] Add live draft assertion and approval queue assertion.
- [ ] Add alternate-time proposal assertion with concrete windows in the draft or proposal payload.
- [ ] Add final delivery assertion and follow-up state update assertion.
- [ ] Add reject-path coverage.
- [ ] Explicitly close the loop on the last turn via `MARK_FOLLOWUP_DONE` or equivalent overdue-state resolution.
- [ ] Convert the follow-up tracker scenarios from placeholders into live seeded checks where they overlap this story.
- [ ] Keep the inbox, Gmail, and cross-channel send payload shapes aligned so the scenario can assert the same repair metadata end to end.

### Acceptance Criteria

- The assistant does not just apologize in chat; it produces the repair artifact and closes the loop.

## Workstream 9: Push Ladder With Ack Suppression Live E2E

### Outcome

A live cross-device reminder ladder proves multi-rung dispatch and suppression after acknowledgement.

### Target Behavior

- Assistant schedules a three-rung ladder.
- Desktop and mobile receive the expected rungs.
- User acknowledges on one device.
- Remaining rungs are suppressed.

### Primary Files

- `test/scenarios/executive-assistant/ea.push.multi-device-meeting-ladder.scenario.ts`
- reminders and notifications scenarios
- `eliza/apps/app-lifeops/test/notifications-push.integration.test.ts`
- `eliza/apps/app-lifeops/test/intent-sync.real.test.ts`

### TODOs

- [ ] Convert `test/scenarios/executive-assistant/ea.push.multi-device-meeting-ladder.scenario.ts` into the transcript-level canonical case with an explicit acknowledgement turn instead of a single contract-style prompt.
- [ ] Convert `test/scenarios/reminders/reminder.cross-platform.fires-on-mac-and-phone.scenario.ts` into the positive-control ladder case with deterministic clock advancement and asserted Mac plus mobile dispatch order.
- [ ] Convert `test/scenarios/reminders/reminder.cross-platform.acknowledged-syncs.scenario.ts` into the negative-control case where acknowledgement after the first rung suppresses later rungs on both devices.
- [ ] Reuse the seed and timing pattern from `reminder-lifecycle-ack-complete.scenario.ts`, `reminder.escalation.silent-dismiss.scenario.ts`, and `reminder.escalation.intensity-up.scenario.ts` so the ladder is driven by definitions plus `POST /api/lifeops/reminders/process` and `POST /api/lifeops/reminders/acknowledge`.
- [ ] Add deterministic event timing and logical clock advancement for the three-rung ladder instead of wall-clock sleeps.
- [ ] Register stable desktop and mobile endpoints before the first rung and keep device ids fixed so the acknowledgement target is unambiguous.
- [ ] Extend `eliza/apps/app-lifeops/test/intent-sync.real.test.ts` with an explicit acknowledge subaction case and a stronger assertion that previously pending intents disappear after acknowledgement.
- [ ] Extend `eliza/apps/app-lifeops/test/device-bus.test.ts` with the real remote-delivery happy path, not only the local fallback path, and assert `deliveredTo` matches the desktop/mobile ladder routing.
- [ ] Keep `eliza/apps/app-lifeops/test/notifications-push.integration.test.ts` as the transport gate and run it against a real Ntfy backend or equivalent topic so the live ladder uses a real push transport.
- [ ] Add one negative variant for missed acknowledgement where all rungs continue to fire.
- [ ] Only touch `service-mixin-reminders.ts` if device-bus acknowledgement itself must auto-resolve reminder state; if the live suite uses the reminder acknowledge API, the existing suppression path is already the correct source of truth.
- [ ] Keep `service-mixin-notifications.ts` and `notifications-push.ts` unchanged unless deep-link or topic conventions become a hard requirement for ladder assertions.

### Acceptance Criteria

- The suite proves actual ladder behavior, not just creation of a reminder or device intent.

## Workstream 10: `NotYetImplemented` Scenario Debt Burn-Down

### Outcome

Reduce old scenario debt in a value-first order so the suite better reflects real product confidence.

### Priority Domains

1. `calendar`
2. `messaging.*`
3. `gateway`
4. `remote`
5. `reminders`
6. `browser.lifeops`

### TODOs

- [ ] Inventory NYI scenarios by domain and dependency blocker.
- [ ] Update `docs/plan-lifeops-executive-assistant-scenario-matrix.md` to remove the stale note that implies most of the executive-assistant suite is still `NotYetImplemented`.
- [ ] Split them into:
  - ready to implement now
  - blocked on connector/runtime feature work
  - obsolete and should be deleted
- [ ] Replace the highest-value NYI scenarios with executable action/side-effect/rubric checks.
- [ ] Delete obsolete or duplicate scenarios instead of carrying dead weight.
- [ ] Track remaining NYI count after each tranche.
- [ ] Burn down NYI in this order:
  - calendar: `calendar.scheduling-with-others.*`, `calendar.create.travel-time`, `calendar.dossier.prep-briefing`, `calendar.calendly.navigate`
  - messaging: `messaging.cross-platform/unified-inbox`, `triage-priority-ranking`, `same-person-multi-platform`, then Gmail send/draft/follow-up
  - gateway: `twilio.sms.*`, `twilio.call.*`, then Discord/Telegram/WhatsApp/BlueBubbles routing and billing
  - remote/browser: `remote.vnc.*`, `remote.mobile-controls-mac`, `remote.agent-calls-for-help`, plus `browser.computer-use.*` and `lifeops-extension.*`
  - reminders: `reminder.alarm.sets-*` and `reminder.cross-platform.*`
- [ ] Treat scenario-schema support as sufficient; prioritize runner/runtime and connector blockers over adding more check types.

### Acceptance Criteria

- The suite has materially fewer NYI placeholders.
- The first tranche removes the highest-value gaps that overlap with executive-assistant workflows.

## Dependency Map

- Workstream 5 unblocks meaningful degraded release gates for Workstreams 1, 2, 3, 8, and 9.
- Workstream 6 unblocks real background execution for Workstreams 1 and 9.
- Workstream 7 strengthens Workstream 1 and future unified inbox/briefing coverage.
- Workstream 10 should consume outputs from the other workstreams so it does not re-implement the same scaffolding twice.

## Recommended Sequence

### Phase A: Testing Architecture

- Workstream 4
- Workstream 5
- Workstream 6

### Phase B: Highest-Value Executive-Assistant Loops

- Workstream 1
- Workstream 8
- Workstream 9

### Phase C: External Ops Flows

- Workstream 2
- Workstream 3
- Workstream 7

### Phase D: Suite Cleanup

- Workstream 10

## Verification Strategy

- `bun run test:e2e:all` must include the new strict live suites.
- `bun run test:scenarios` must include upgraded scenario checks and degraded variants.
- Contract tests should be updated only where they enforce new minimum coverage, not where they hide product gaps.
- Every new strict suite must have seeded-state assertions and side-effect assertions.

## Subagent Dispatch

All ten workstreams were dispatched for research. All ten reports have been received and folded into this plan.

### Completed Research

- Workstream 1: `Dirac`
- Workstream 2: `Russell`
- Workstream 3: `James`
- Workstream 4: `Plato`
- Workstream 5: `Huygens`
- Workstream 6: `Fermat`
- Workstream 7: `Galileo`
- Workstream 8: `Banach`
- Workstream 9: `Rawls`
- Workstream 10: `Kuhn`

## Integration Notes

- Update this plan with concrete file-level TODOs from subagent research before implementation begins.
- Do not start broad code changes from this document alone where connector or runner architecture is still ambiguous.
- Favor adding strict live suites beside existing permissive suites first; then tighten or delete the permissive paths once strict coverage is stable.
