# LifeOps Shared Dependency Ownership Map

Date: 2026-05-05
Owner: Codex
Scope: resolve shared ownership and sequencing across the LifeOps plan review follow-ups. This document is only an ownership map; it does not replace the implementation plans it references.

Related standards:

- [LifeOps Proof Taxonomy](2026-05-05-lifeops-proof-taxonomy.md)
- [LifeOps Connector API Mock Proof Standard](2026-05-05-lifeops-connector-proof-standard.md)
- [LifeOps Account And Credential Matrix](2026-05-05-lifeops-account-credential-matrix.md)
- [LifeOps E2E Proof Requirements](2026-05-05-lifeops-e2e-proof-requirements.md)

## Source Plans

- `docs/plans/2026-04-19-lifeops-coverage-closure-implementation-plan.md`
- `docs/plans/2026-04-19-remaining-lifeops-workstreams.md`
- `docs/plans/2026-04-19-passive-schedule-inference-plan.md`
- `docs/plans/2026-04-22-gmail-lifeops-integration-review.md`
- `docs/plans/2026-04-23-proactive-life-agent-plan.md`
- `docs/plans/2026-04-23-lifeops-dashboard-ux-review-prd.md`
- `docs/plans/2026-05-04-on-device-agent-mobile-and-cloud-executor-assessment.md`

## Unblock Order

1. Mock/provider fidelity and real-account wiring, so every live lane has a trustworthy mock/live split.
2. Approval queue, because write flows, browser uploads, booking, Gmail send, and dashboard review all depend on one approval source of truth.
3. Canonical identity and cross-channel search, because morning brief, unified inbox, follow-up repair, and dashboard grouping should consume the same person graph.
4. Connector degradation, so every connector-dependent plan can certify missing auth, scope, rate limit, retry, idempotency, provenance, and reconnect states.
5. Background clock/tick runner, so proactive briefing, reminders, follow-up sweep, itinerary warnings, and push ladders run from deterministic logical time.
6. Dashboard agent activity DTO, so UI visibility consumes the same approval, background, connector, and dispatch records that tests assert.
7. Mobile `AgentTransport` and route kernel, after shared server contracts are stable enough to avoid two mobile-only client stacks.
8. Passive telemetry fixtures, after the clock runner exists and before reminder policy tests depend on inferred sleep, wake, meal, or activity state.
9. Live E2E CI lanes, once the preceding gates expose deterministic mock/live controls and write-safety guards.

## Shared Dependencies

### Approval Queue

- Owner plan/source docs: LifeOps Coverage Closure Workstreams 1, 2, 3, and 8; Remaining LifeOps Workstreams calendar, Gmail, BlueBubbles/iMessage, browser portal, and travel items.
- Dependent plans: strict travel booking and sync, strict docs/browser/portal, missed-commitment repair, Gmail send/draft review, dashboard agent work surface, connector certification, real-account write smoke.
- Owning module paths: `plugins/app-lifeops/src/lifeops/approval-queue.ts`, `plugins/app-lifeops/src/lifeops/approval-queue.types.ts`, `plugins/app-lifeops/src/actions/approval.ts`, `plugins/app-lifeops/src/routes/lifeops-routes.ts`, `packages/core/src/services/approval.ts`.
- Test gates: `plugins/app-lifeops/test/approval-queue.integration.test.ts`, `plugins/app-lifeops/test/approval-queue.validation.test.ts`, `plugins/app-lifeops/test/approval.dispatch.integration.test.ts`, `plugins/app-lifeops/test/book-travel.approval.integration.test.ts`, relevant executive-assistant scenarios that assert approve and reject paths.
- Unblock order: extend typed request payloads first, then register approve/reject executors, then expose queue state to dashboard/tests, then wire each write action to the shared queue.
- Do not reimplement: per-feature approval arrays, browser-task-only approval state, Gmail-only confirmation flags, or travel-specific approve/reject action plumbing.

### Canonical Identity

- Owner plan/source docs: LifeOps Coverage Closure Workstream 7 and Remaining LifeOps Workstreams messaging/iMessage/cross-platform items.
- Dependent plans: strict morning brief, unified inbox, cross-platform latest-context queries, missed-commitment repair, follow-up daily digest, dashboard inbox grouping, contact/Rolodex cleanup.
- Owning module paths: `plugins/app-lifeops/src/actions/search-across-channels.ts`, `plugins/app-lifeops/src/lifeops/unified-search.ts`, `plugins/app-lifeops/src/lifeops/schema.ts`, `plugins/app-lifeops/src/lifeops/repository.ts`, `packages/agent/src/providers/session-bridge.ts`.
- Test gates: `plugins/app-lifeops/test/assistant-user-journeys.live.e2e.test.ts`, `plugins/app-lifeops/test/relationships.real.test.ts`, `test/scenarios/messaging.cross-platform/cross-platform.same-person-multi-platform.scenario.ts`, `test/scenarios/messaging.cross-platform/cross-platform.unified-inbox.scenario.ts`.
- Unblock order: add deterministic identity fixture helper, prove graph merge directly, then make search and brief consumers read the graph, then decide whether Rolodex storage needs a schema bridge.
- Do not reimplement: connector-local contact merging, scenario-only alias maps, or a second identity layer outside `SEARCH_ENTITY`, `LINK_ENTITY`, unified search, and the relationship graph.

### Cross-Channel Search

- Owner plan/source docs: LifeOps Coverage Closure Workstreams 1, 7, 8, and Remaining LifeOps Workstreams messaging classification.
- Dependent plans: morning brief cross-channel unread, same-person latest context, follow-up repair, iMessage contact cross-reference, Gmail relationship context, dashboard inbox filters.
- Owning module paths: `plugins/app-lifeops/src/actions/search-across-channels.ts`, `plugins/app-lifeops/src/lifeops/unified-search.ts`, connector read services under `plugins/app-lifeops/src/lifeops`, and shared contracts in `packages/shared/src/contracts/lifeops.ts`.
- Test gates: cross-platform messaging scenarios, relationships real tests, assistant strict live journey, and connector certification scenarios for every source that participates in search.
- Unblock order: canonical identity first, then normalized search DTOs, then source-specific readers, then dashboard and brief aggregation.
- Do not reimplement: a separate dashboard search index, one-off Gmail-plus-Discord search helpers, or prose-only summaries without structured source, person, channel, timestamp, and provenance fields.

### Connector Degradation

- Owner plan/source docs: LifeOps Coverage Closure Workstream 5 and Gmail LifeOps Integration Review.
- Dependent plans: strict morning brief, travel booking, docs/browser portal, missed-commitment repair, push ladder, live E2E CI lanes, dashboard Access page.
- Owning module paths: `test/scenarios/connector-certification`, `plugins/app-lifeops/test/lifeops-connector-certification.contract.test.ts`, connector status/auth code under `plugins/app-lifeops/src`, provider mock fixtures under `test/mocks`.
- Test gates: connector certification contract tests, per-connector degraded scenario variants, mock request ledger assertions, missing scope/auth tests, retry/idempotency tests.
- Unblock order: define common degradation axes, extend scenario factory/fixtures, add DTO fields in use-case layer, then roll out Google, Telegram, Signal, Discord, Twilio, WhatsApp, X, iMessage, browser portal, notifications.
- Do not reimplement: connector-specific status vocabularies in UI, silent fallback states, or degradation checks hidden in prose judges.

### Background Clock And Tick Runner

- Owner plan/source docs: LifeOps Coverage Closure Workstream 6 and Proactive Life-Aware Agent Phases 3 and 4.
- Dependent plans: morning briefing, scheduled Discord briefing, overdue follow-up sweep, travel-day itinerary brief, cancellation-fee warning, reminder ladder, passive telemetry policy tests.
- Owning module paths: `packages/scenario-runner/src/scenario-schema.d.ts`, `test/scenarios/scenario-schema-shim.d.ts`, `packages/scenario-runner/src/executor.ts`, trigger/worker code under `plugins/app-lifeops/src`, `packages/agent/src/triggers/runtime.ts`.
- Test gates: `plugins/app-lifeops/test/background-job-parity.contract.test.ts`, `test/scenarios/lifeops.workflow-events`, advance-clock reminder scenarios, follow-up bump scenarios, trigger runtime tests.
- Unblock order: add logical `now` support, add `advanceClock`, `tick`, and `api` scenario primitives, thread `now` through proactive tasks and reminder/workflow processing, then convert background scenarios.
- Do not reimplement: wall-clock sleeps, per-test fake timers that bypass the scenario runner, or separate scheduler shims for reminders, follow-ups, and briefings.

### Dashboard Agent Activity DTO

- Owner plan/source docs: LifeOps Dashboard UX Review PRD plus LifeOps Coverage Closure approval/background/degradation workstreams.
- Dependent plans: Overview agent strip, Agent page, Access page, approval review UI, write audit, recent completed actions, failed work, queued work, browser intervention, connector health.
- Owning module paths: `packages/shared/src/contracts/lifeops.ts`, `plugins/app-lifeops/src/routes/lifeops-routes.ts`, `packages/app-core/src/api/client-lifeops.ts`, LifeOps dashboard components under `plugins/app-lifeops/src/components/chat/widgets/plugins`.
- Test gates: LifeOps route tests, client contract tests, dashboard UI smoke, approval queue integration, background job parity, connector degradation contract tests.
- Unblock order: define a required-field DTO for `now`, `next`, `done`, `failed`, and `needsApproval`, back it with existing queues/logs, expose route/client hooks, then render dashboard surfaces.
- Do not reimplement: UI-side derivation from raw approval arrays, connector-specific activity cards, debug counters, or optional DTO fields that require presentation fallback logic.

### Real-Account Wiring

- Owner plan/source docs: Gmail LifeOps Integration Review, Proactive Life-Aware Agent Phase 1, and LifeOps Coverage Closure live E2E workstreams.
- Dependent plans: live Gmail smoke, strict morning brief, travel/calendar sync, Gmail event/n8n workflows, dashboard Access page, connector degraded-path tests, live E2E CI lanes.
- Owning module paths: Google grant/calendar/Gmail clients under `plugins/app-lifeops/src/lifeops`, cloud-managed Google routes under `cloud/app/api/v1/eliza/google`, LifeOps API routes under `plugins/app-lifeops/src/routes/lifeops-routes.ts`, smoke/export scripts under `scripts`.
- Test gates: read-only real smoke, write-gated real smoke, Google multi-account tests, cloud calendar route tests, Gmail sweeper dry-run, no-real-write guard assertions.
- Unblock order: keep read-only smoke first, add dedicated test accounts, require explicit write env gates and recipient/run allowlists, then enable live CI lanes by category.
- Do not reimplement: production-mailbox test paths, account selection in UI only, write gates inside individual tests, or fixture exports that commit owner data.

### Mockoon And Provider Fidelity

- Owner plan/source docs: Gmail LifeOps Integration Review and LifeOps Coverage Closure connector degradation matrix.
- Dependent plans: Gmail scenarios, real-account wiring, connector degradation, live E2E CI lanes, background/event workflow tests.
- Owning module paths: `test/mocks`, `test/mocks/__tests__/google-mock-fidelity.test.ts`, `test/mocks/__tests__/google-calendar-mock.test.ts`, `test/mocks/__tests__/non-google-provider-mocks.test.ts`, scenario fixtures under `test/scenarios/connector-certification`.
- Test gates: provider mock fidelity tests, mock request ledger assertions, Gmail scenario final checks, provider retry/error fixture tests, no-real-write proofs.
- Unblock order: preserve Mockoon JSON as editable fixture source, keep stateful behavior in the in-process runner, add retry/error/idempotency cases, then teach scenarios to assert the ledger.
- Do not reimplement: ad hoc per-scenario mock servers, string-only Gmail fixtures, provider behavior in scenario judges, or mock paths that do not share the same client code as real mode.

### Live E2E CI Lanes

- Owner plan/source docs: LifeOps Coverage Closure Workstreams 1, 2, 3, 4, 5, 6, 7, 8, and 9 plus Gmail LifeOps Integration Review.
- Dependent plans: strict executive-assistant proof, Gmail release proof, connector certification, push ladder, background jobs, real account smoke.
- Owning module paths: `plugins/app-lifeops/test/assistant-user-journeys.live.e2e.test.ts`, `plugins/app-lifeops/test/lifeops-gmail-chat.live.e2e.test.ts`, `plugins/app-lifeops/test/helpers/lifeops-live-harness.ts`, `test/scenarios/executive-assistant`, CI workflow files.
- Test gates: strict first-turn lane, recovery lane, connector degraded lane, mock-live lane, real read-only smoke lane, explicit write smoke lane with allowlists.
- Unblock order: split strict versus recovery first, finish mock/live write gates, add deterministic clock runner, then promote read-only live lanes before any write lane.
- Do not reimplement: rescue reprompts in strict tests, best-of-N correctness, real writes without exact run ids, or CI lanes that mix production owner data with release gates.

### Mobile `AgentTransport` And Route Kernel

- Owner plan/source docs: On-device Mobile Agent and Cloud Executor Assessment.
- Dependent plans: Android loopback hardening, Android native bridge, iOS cloud-hybrid, future iOS local backend, LifeOps mobile push/reminder workflows, app-core clients.
- Owning module paths: `packages/app-core/src/api/client-base.ts`, `packages/app-core/src/api/transport.ts`, `packages/app-core/src/api/android-native-agent-transport.ts`, `packages/agent/src/api/server.ts`, `packages/app-core/src/api/server.ts`, `packages/agent/src/api/server-helpers-auth.ts`.
- Test gates: `packages/app-core/src/api/client-base.test.ts`, `packages/app-core/src/api/android-native-agent-transport.test.ts`, unauthenticated loopback rejection tests, route kernel parity tests once extracted.
- Unblock order: harden Android auth token path first, route app-core requests through `AgentTransport`, then extract Fetch-shaped route kernel, then add protected IPC/custom scheme transports.
- Do not reimplement: a mobile-only REST client, iOS-local backend promises before route-kernel proof, or connector/business logic inside native bridge code.

### Passive Telemetry Fixtures

- Owner plan/source docs: Passive Schedule Inference Plan and LifeOps Coverage Closure Workstream 6.
- Dependent plans: adaptive reminders, after-wake reminders, meal-linked reminders, sleep suppression, screen-time analytics, dashboard Sleep and Screen Time pages, activity context scenarios.
- Owning module paths: `plugins/app-lifeops/src/activity-profile`, `plugins/app-lifeops/src/lifeops/telemetry-mapping.ts`, `plugins/app-lifeops/src/lifeops/telemetry-retention.ts`, `plugins/app-lifeops/src/lifeops/service-mixin-screentime.ts`, `plugins/app-lifeops/src/hooks/useLifeOpsActivitySignals.ts`, `packages/native-plugins/activity-tracker`, `packages/native-plugins/mobile-signals`.
- Test gates: activity-profile tests, lifeops activity signal schema/client tests, screen-time service tests, future passive telemetry fixture tests, reminder scenario runner tests with logical clock.
- Unblock order: define canonical telemetry event fixtures, normalize timestamps/timezone, derive daily summaries/posteriors, then let reminder policy consume posterior state rather than raw event streams.
- Do not reimplement: disconnected screen-time/browser/activity stores, UI-side inference, raw telemetry in cloud release gates, or reminder rules that read capture streams directly.
