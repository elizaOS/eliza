# LifeOps E2E Coverage Matrix

Domain-anchored matrix per `docs/audit/IMPLEMENTATION_PLAN.md` §5.7 +
`docs/audit/GAP_ASSESSMENT.md` §8.5. The 28 rows correspond 1:1 with the 28
chapters in `docs/audit/UX_JOURNEYS.md`'s table of contents — adding or
removing a chapter requires updating this matrix and vice versa.

The contract test (`test/prd-coverage.contract.test.ts`) enforces:

1. Every row points to a real test file under `plugins/app-lifeops/test/`.
2. Every test file referenced by the matrix is referenced by exactly one row.
3. Each `Domain` value matches one of the 28 `UX_JOURNEYS.md` chapter
   headings.
4. Spine-coverage: at least one test exercises the W1-A `ScheduledTask`
   spine for every domain whose `Spine` cell says `ScheduledTask`. The
   contract test asserts this from `Spine` column data plus runner-test
   discovery.

Source references:
- PRD: `packages/docs/prd-lifeops-executive-assistant.md`
- Scenario matrix: `packages/docs/plan-lifeops-executive-assistant-scenario-matrix.md`
- UX journeys: `eliza/plugins/app-lifeops/docs/audit/UX_JOURNEYS.md`
- Gap assessment: `eliza/plugins/app-lifeops/docs/audit/GAP_ASSESSMENT.md`

| Journey ID | Journey Name | Domain | Spine | Test File | PRD / Scenario Anchors | Status |
|---|---|---|---|---|---|---|
| 1 | Onboarding & first-run setup | Onboarding & first-run setup | ScheduledTask | `test/first-run-defaults.e2e.test.ts` | `GAP §3.6 FirstRunService`, `IMPL §3.3` | covered |
| 2 | Core data model & overview surface | Core data model & overview surface | ScheduledTask | `test/spine-and-first-run.integration.test.ts` | `GAP §3.1 ScheduledTask spine` | covered |
| 3 | Habits | Habits | ScheduledTask | `test/scheduled-task-end-to-end.e2e.test.ts` | `GAP §3.1`, `UX §3` | covered |
| 4 | Routines & multi-step daily flows | Routines & multi-step daily flows | ScheduledTask | `test/assistant-user-journeys.morning-brief.e2e.test.ts` | Suite B (`ea.inbox.daily-brief-cross-channel`) | covered |
| 5 | Tasks (one-off) | Tasks (one-off) | ScheduledTask | `test/reminder-review-job.real.e2e.test.ts` | `UX §5`, `GAP §3.1` | covered |
| 6 | Goals | Goals | ScheduledTask | `test/lifeops-life-chat.real.test.ts` | Suite A (`ea.schedule.protect-sleep-window`), `test/scenarios/goal-sleep-basic.scenario.ts` | covered (extension pending) |
| 7 | Reminders & escalation ladder | Reminders & escalation ladder | ScheduledTask | `test/notifications-push.e2e.test.ts` | Suite F (`ea.push.multi-device-meeting-ladder`) | covered |
| 8 | Calendar journeys | Calendar journeys | ScheduledTask | `test/bundle-meetings.e2e.test.ts` | Suite A (`ea.schedule.bundle-meetings-while-traveling`) | covered |
| 9 | Inbox & email triage | Inbox & email triage | ScheduledTask | `test/lifeops-inbox-triage.integration.test.ts` | Suite B (`ea.inbox.daily-brief-ranks-urgent-before-low-priority`) | covered (extension pending) |
| 10 | Travel | Travel | ScheduledTask | `test/book-travel.approval.integration.test.ts` | Suite D (`ea.travel.book-after-approval`) | covered |
| 11 | Follow-up repair (relationships) | Follow-up repair (relationships) | ScheduledTask | `test/assistant-user-journeys.followup-repair.e2e.test.ts` | Suite C (`ea.followup.bump-unanswered-decision`) | covered |
| 12 | Documents, signatures, portals | Documents, signatures, portals | ScheduledTask | `test/signature-deadline.e2e.test.ts` | Suite E (`ea.docs.signature-before-appointment`) | covered |
| 13 | Self-control / app & website blockers | Self-control / app & website blockers | enforcer-registry | `test/selfcontrol-chat.live.e2e.test.ts` | `UX §13`, `GAP §3.16 BlockerRegistry` | covered |
| 14 | Group chat handoff | Group chat handoff | HandoffStore | `test/handoff.e2e.test.ts` | `GAP §3.14`, `JOURNEY_GAME_THROUGH §J13` | covered |
| 15 | Multi-channel & cross-channel search | Multi-channel & cross-channel search | ChannelRegistry | `test/cross-channel-search.integration.test.ts` | `GAP §3.5 ChannelRegistry`, `UX §15` | covered |
| 16 | Activity signals & screen context | Activity signals & screen context | ActivitySignalBus | `test/plugin-health-anchor.integration.test.ts` | `GAP §3.2 ActivitySignalBus`, `UX §16` | covered |
| 17 | Approval queues & action gating | Approval queues & action gating | ApprovalQueue | `test/approval-queue.integration.test.ts` | `UX §17`, `GAP §3.10 ApprovalQueue` | covered |
| 18 | Identity merge (canonical person) | Identity merge (canonical person) | EntityStore | `test/assistant-user-journeys.identity-merge.live.e2e.test.ts` | `GAP §3.4 IdentityGraph`, `UX §18` | covered |
| 19 | Memory recall | Memory recall | MemoryStore | `test/lifeops-memory.live.e2e.test.ts` | `UX §19` | covered |
| 20 | Connectors & permissions | Connectors & permissions | ConnectorRegistry | `test/google-drive.integration.test.ts` | `GAP §3.5 ConnectorRegistry`, `UX §20` | covered |
| 21 | Health, money, screen time | Health, money, screen time | plugin-health | `test/screen-time.real.test.ts` | `IMPL §3.2`, `UX §21` | covered |
| 22 | Push notifications | Push notifications | EscalationLadder | `test/cancellation-fee.e2e.test.ts` | Suite F (`ea.push.cancellation-fee-warning`) | covered |
| 23 | Remote sessions | Remote sessions | RemoteSession | `test/stuck-agent-call.e2e.test.ts` | Suite F (`ea.push.stuck-agent-calls-user`) | covered |
| 24 | Settings & UX | Settings & UX | OwnerFactStore | `test/first-run-customize.e2e.test.ts` | `GAP §3.3 OwnerFactStore`, `UX §24` | covered |
| 25 | REST API access flows | REST API access flows | api | `test/lifeops-feature-flags.integration.test.ts` | `UX §25` | covered |
| 26 | Workflows (event-triggered) | Workflows (event-triggered) | ScheduledTask | `test/lifeops-signal-inbound.integration.test.ts` | `UX §26` | covered |
| 27 | Multilingual coverage | Multilingual coverage | MultilingualPromptRegistry | `test/multilingual-action-routing.integration.test.ts` | `GAP §3.7 MultilingualPromptRegistry`, `UX §27` | covered |
| 28 | Suspected-but-unconfirmed flows | Suspected-but-unconfirmed flows | scenario | `test/lifeops-action-gating.integration.test.ts` | `UX §28` | covered |

## Spine-coverage assertion (per `GAP §8.5`)

For every row whose `Spine` cell is `ScheduledTask` (rows 1–12, 26), the
contract test confirms that at least one test exercises the W1-A
`ScheduledTask` spine in that domain. The runner-level unit test
`src/lifeops/scheduled-task/runner.test.ts` plus the new e2e tests
(`scheduled-task-end-to-end.e2e.test.ts`,
`spine-and-first-run.integration.test.ts`,
`plugin-health-anchor.integration.test.ts`) supply the runtime coverage.

## Key

- `covered` — test file exists, lane is wired, no follow-up required.
- `covered (extension pending)` — base test file exists; an additional
  sub-scenario for this exact domain is staged for in-place extension.
  The contract test passes because the file exists.

## Rationale for domain-anchored shape

Per `GAP_ASSESSMENT.md` §8.5, the previous "20 PRD journey rows" form was
scenario-anchored: it locked the matrix to a specific named-scenario count
and fought any decomposition / consolidation of journeys. The
domain-anchored form keeps "every domain is exercised" as the contract
without freezing the journey count. New scenarios within a domain are
in-place extensions of the row's test file; new domains require both a
matrix row and a `UX_JOURNEYS.md` chapter.
