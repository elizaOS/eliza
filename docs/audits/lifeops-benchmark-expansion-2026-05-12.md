# LifeOpsBench Expansion Audit — 2026-05-12

## Scope Reviewed

- PRD: `packages/docs/prd-lifeops-executive-assistant.md`
- Scenario plan: `packages/docs/plan-lifeops-executive-assistant-scenario-matrix.md`
- UX journeys: `plugins/app-lifeops/docs/audit/UX_JOURNEYS.md`
- App architecture: `plugins/app-lifeops/README.md`
- Health plugin architecture: `plugins/plugin-health/README.md`
- Coverage matrix: `plugins/app-lifeops/coverage-matrix.md`
- Benchmark authoring and executor gaps: `packages/benchmarks/lifeops-bench/SCENARIO_AUTHORING.md`, `LIFEOPS_BENCH_GAPS.md`

## 10 Expansion Areas Added

Each area now has 10 primary scenario families and two similar-but-different variants per family, for 30 scenarios per area and 300 total.

| Area | PRD / UX pressure | What the scenarios stress |
|---|---|---|
| Temporal triggers and heartbeat simulation | background jobs use same pipeline; default rhythm packs | `once`, `cron`, `interval`, `relative_to_anchor`, `during_window`, `event`, `manual`, `after_task`, time-zone/DST language |
| Cross-domain day/week orchestration | operating loop across inbox, calendar, reminders, travel, focus | 3-6 action plans spanning calendar, drafts, followups, reminders, blockers |
| Escalation, push, remote recovery | reliable escalation, cancellation-fee warnings, stuck-agent handoff | escalation metadata, fallback channels, high-priority outputs, remote-help approximations |
| Connector degradation | explicit failure/degraded states, connector capability boundaries | Gmail/Discord/Signal/Telegram/iMessage fallback, reconnect prompts, degraded drafts |
| Identity and follow-up repair | one operational memory, relationship follow-through | entity identity updates, cross-channel reads, relationship-subject watchers |
| Health, sleep, circadian | plugin-health anchors, sleep recaps, health signals | sleep/wake anchors, health metrics, habit softening, screen-time interventions |
| Focus blockers | self-control and app/website blocking | permission-before-block, release flows, focus calendar holds, block status/release language |
| Finance and subscriptions | money, recurring charges, subscription actions | recurring-charge audits, cancellation after confirmation, budget followups |
| Travel, docs, approvals | travel/event ops, portal/deadline/doc workflows | travel search, calendar holds, approval reminders, itinerary shares, doc-deadline approximations |
| Multilocale, settings, privacy | locale, owner facts, global pause, handoff, memory | mixed-language tasks, privacy revocation, global-pause metadata, memory-safe confirmations |

## Action / Capability Gaps Surfaced

- `SCHEDULED_TASK_CREATE` is folded into reminders in LifeWorld. This is enough for deterministic scoring but cannot validate escalation cursor, `pipeline`, `output`, `subject`, global-pause, or completion-check semantics as first-class state.
- There is no benchmark action for advancing a real ScheduledTaskRunner clock or invoking heartbeats over a simulated day/week.
- Connector auth/status, queued outbound, and reconnect flows are represented as `MESSAGE` plus follow-up tasks, not connector-state mutations.
- Push notifications and remote sessions are product services, not benchmark state entities.
- Relationship merge and cadence edges are approximated with `ENTITY` and scheduled-task `subject` metadata.
- Focus blocks are no-op `BLOCK_*` actions until a `FocusBlock` entity exists in LifeWorld.
- Docs, signatures, portal uploads, approvals, owner facts, global pause, handoff, memory, REST access, budgets, and account aggregates need first-class action/state entities for stronger end-to-end scoring.

## Validation

- Expanded pack shape: 300 scenarios, 10 areas, 30 per area.
- Static/live split: 180 static, 120 live.
- Static fallback coverage: 12 fallback-enabled static scenarios per area.
- Corpus validation and expanded contract tests passed.
- Full static conformance passed with the expanded registry.

## Post-Review Refinement

Four bounded subagent reviews flagged that the first generated pass was too
topical for focus blockers, finance, travel/docs/approvals, and
multilocale/settings/privacy. The pack was tightened so those static
families now use varied action shapes instead of one repeated template:

- focus uses `BLOCK_REQUEST_PERMISSION`, `BLOCK_BLOCK`, `BLOCK_STATUS`,
  `BLOCK_RELEASE`, `BLOCK_LIST_ACTIVE`, blocker schedules, harsh-mode
  metadata, release reasons, and focus-calendar holds.
- finance uses subscription status/cancel, dashboard, spending summary,
  transaction listing, recurring charges, and subscription audit instead of
  cancelling in every case.
- travel/docs uses `BOOK_TRAVEL`, calendar holds, airport-transfer
  reminders, signature/deadline metadata, portal-upload metadata, weather
  rebook proposals, and itinerary messages.
- multilocale/privacy uses bilingual prompts, locale/timezone metadata,
  global-pause exceptions, document privacy revocation, group-thread handoff
  metadata, no-store memory metadata, and REST-like overview metadata.

The benchmark still records missing first-class action semantics for these
areas rather than pretending the current LifeWorld can validate them as real
state.
