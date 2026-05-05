# LifeOps Proof Taxonomy

Date: 2026-05-05
Owner: LifeOps planning
Status: Draft standard for new and updated LifeOps plans

Related standards:

- [LifeOps Connector API Mock Proof Standard](2026-05-05-lifeops-connector-proof-standard.md)
- [LifeOps Account And Credential Matrix](2026-05-05-lifeops-account-credential-matrix.md)
- [LifeOps E2E Proof Requirements](2026-05-05-lifeops-e2e-proof-requirements.md)
- [LifeOps Shared Dependency Ownership Map](2026-05-05-lifeops-shared-ownership-map.md)

## Goal

LifeOps plans need a shared vocabulary for proof. A passing unit test, a Mockoon run, a live credentialed E2E, and a UI E2E do not prove the same thing. This document defines the proof levels every LifeOps capability claim must map to before the claim is treated as release evidence.

Use this taxonomy when writing or updating plans under `docs/plans`, PRDs, scenario matrices, and implementation handoffs.

## Proof Levels

### 1. Unit

Purpose:
- Prove pure or tightly scoped behavior in one module without booting the LifeOps runtime.
- Keep parser, mapper, reducer, policy, repository helper, DTO, and UI utility regressions cheap to catch.

What it proves:
- A local function or component produces expected output for fixed inputs.
- Edge cases such as empty arrays, missing optional inputs, date boundaries, dedupe, sorting, and validation errors are handled.
- Source-level contracts and static invariants can be enforced when they are explicitly named as contract tests.

What it cannot prove:
- LLM planner behavior.
- Runtime wiring, providers, action registration, routes, or background scheduling.
- Connector behavior, credential flow, or real side effects.
- UI browser behavior unless the test actually renders and interacts with the UI in a browser-like environment.

Required evidence:
- Test file path and command.
- Exact behavior asserted.
- Fixture shape or seed data.
- For contract tests, the invariant being scanned or enforced and the files covered.

CI command / runner expectation:
- App LifeOps default: `bun run --cwd plugins/app-lifeops test`.
- Root default: `bun run test` or the relevant `turbo run test --filter=...` lane.
- `plugins/app-lifeops/vitest.config.ts` excludes `*.integration.test.*`, `*.e2e.test.*`, `*.live.*`, and `*.real.*`; do not claim higher proof from this lane.

Skip policy:
- Unit tests should not skip for credentials.
- A skipped unit test needs an explicit tracked reason in the plan because it otherwise signals the unit seam is not isolated enough.

Examples from current plans/tests:
- `plugins/app-lifeops/test/lifeops-no-heuristics.contract.test.ts` is useful as a source invariant, but it does not execute the agent.
- `plugins/app-lifeops/src/lifeops/google-fetch.test.ts` proves mock-base URL and write-guard logic, not Gmail API compatibility.
- The proactive multi-calendar handoff lists targeted service tests such as `service-mixin-calendar.test.ts`.

### 2. Integration

Purpose:
- Prove multiple LifeOps modules work together under a real runtime or service boundary while still using controlled test doubles for LLMs, connectors, clocks, or external APIs.
- Validate repository, route, service mixin, action, scheduler, and PGlite behavior without depending on third-party availability.

What it proves:
- Runtime/service wiring is correct.
- State changes persist through the intended repository or API path.
- Approval queues, ledgers, background workers, and route handlers can be asserted directly.
- Mock connectors are called with the right payloads.

What it cannot prove:
- Real LLM extraction quality unless a live model is used.
- Third-party provider compatibility unless the provider is actually called.
- Browser or desktop UI behavior unless the integration test drives that surface.

Required evidence:
- Test file path and command.
- Runtime/service entry point exercised.
- Database or state assertions, not just response text.
- Connector double or mock ledger assertions for external calls.

CI command / runner expectation:
- Focused LifeOps smoke: `bun run --cwd plugins/app-lifeops test:integration`.
- General integration config: `vitest run --config test/vitest/integration.config.ts <path>`.
- Integration files should use the `.integration.test.ts` suffix and stay out of the unit config.

Skip policy:
- Prefer deterministic doubles over skips.
- Credential-optional integration tests must have a stubbed path that still exercises core logic.
- Any deliberate skip in live/real-adjacent integration must use `SKIP_REASON` if the fail-on-silent-skip setup is active.

Examples from current plans/tests:
- `plugins/app-lifeops/test/life-smoke.integration.test.ts` boots a real AgentRuntime on PGlite.
- `plugins/app-lifeops/test/travel-duffel.integration.test.ts` is the planned place for refresh, hold, payment, and order retrieval coverage, but by itself it does not prove full travel booking through chat.
- `plugins/app-lifeops/test/notifications-push.integration.test.ts` is a transport gate, not a complete reminder ladder proof unless paired with clock and acknowledgement assertions.

### 3. Scenario

Purpose:
- Prove behavior-level LifeOps flows through the scenario runner with seeded context, expected action selection, side effects, and rubric checks.
- Capture executive-assistant and connector certification requirements in a readable, repeatable form.

What it proves:
- A capability can be described as a product scenario and evaluated against expected behavior.
- The planner selected expected actions and parameters when action assertions are present.
- Side effects happened when final checks assert runtime state, mock ledgers, queues, memory writes, or dispatches.
- LLM judge/rubric thresholds are met when the scenario uses judge checks.

What it cannot prove:
- Real connector compatibility unless the scenario lane calls real providers.
- UI rendering or human review ergonomics.
- Strict first-turn quality if the runner or test allows rescue prompts, retries, or shallow text-only checks.
- Durable background execution unless the scenario includes a tick/API primitive that actually fires the worker.

Required evidence:
- Scenario file path and runner command.
- Seeds used and how they bind to runtime state.
- Expected selected action and typed parameter assertions.
- Required side-effect assertions.
- Judge/rubric threshold where applicable.
- Confirmation of whether the scenario is strict, recovery, mock-backed, or live-backed.

CI command / runner expectation:
- App LifeOps script: `bun run --cwd plugins/app-lifeops test:scenarios`.
- Current command resolves through `bun run scenarios:lifeops` from repo root.
- Plans should not assume scenario proof is in required PR CI unless the owning workflow explicitly runs it.

Skip policy:
- `NotYetImplemented` is not proof.
- A scenario may be marked blocked only with the missing runtime or connector feature named.
- Text-only scenarios are allowed as transitional smoke, but release claims need action, side-effect, or judge evidence.

Examples from current plans/tests:
- Executive assistant scenarios such as `test/scenarios/executive-assistant/ea.inbox.daily-brief-cross-channel.scenario.ts`, `ea.travel.book-after-approval.scenario.ts`, and `ea.push.multi-device-meeting-ladder.scenario.ts`.
- Connector certification scenarios under `test/scenarios/connector-certification`, including degraded variants such as Gmail missing scope, Google Calendar rate limited, and browser portal blocked resume.
- The coverage closure plan requires `ea.followup.bump-unanswered-decision` to become the first advance-clock scenario for background execution.

### 4. Mockoon / Provider Mock

Purpose:
- Prove the app talks to a provider-shaped local mock with deterministic fixtures, request ledgers, and safe write behavior.
- Exercise destructive or rate/error cases without touching real accounts.

What it proves:
- Provider request shape, auth/scope handling, pagination, write guards, body validation, and request ordering against the local emulation.
- Side effects are issued to loopback mocks and can be inspected through a ledger.
- Mock and real mode switching is wired through the same application code path.

What it cannot prove:
- Exact third-party behavior, undocumented validation, quota behavior, network edge cases, or provider UI changes.
- Real OAuth/token behavior beyond what the mock emulates.
- Deliverability or real external side effects.

Required evidence:
- Mock base URL and fixture source.
- Assertion that provider traffic used loopback mock, for example `ELIZA_MOCK_GOOGLE_BASE`.
- Request ledger assertions, including method, route, body, and write/non-write distinction.
- Description of mock fidelity limits.

CI command / runner expectation:
- Use the same scenario or integration command as the owning test, with mock env set.
- Gmail/Google mock mode requires `ELIZA_MOCK_GOOGLE_BASE` to point at loopback.
- Mocked writes should fail if the ledger has no matching request.

Skip policy:
- Mock-provider tests should not skip for real credentials.
- Destructive operations belong here first.
- Non-loopback mock bases must fail for tests that could write.

Examples from current plans/tests:
- The Gmail review documents a Mockoon-compatible Google mock whose JSON fixture is editable while the in-process runner supplies Gmail behavior.
- The mock records requests through `requestLedger()` and `GET /__mock/requests`.
- Gmail mock coverage includes labels, drafts, batch modify/delete, message trash/untrash/delete, threads, watch/history, filters, and send/list/get routes.

### 5. Live Credentialed E2E

Purpose:
- Prove the real agent, real LLM, real runtime, and real credentialed connector path work end to end.
- Validate strict product claims that depend on live provider behavior, OAuth grants, model planning, and real side effects.

What it proves:
- The user-facing request can flow through LLM planning, action execution, connector/API call, approval gate, state update, and final response.
- Credentials, scopes, provider availability, and cleanup/sweeper controls are sufficient.
- Strict suites can prove first-turn quality when rescue prompts and retries are forbidden.

What it cannot prove:
- Deterministic provider behavior across all accounts or future API changes.
- UI rendering unless a browser/desktop driver is included.
- Safety of production/personal accounts unless the test uses dedicated test accounts, allowlists, and cleanup.
- Recovery quality unless the test is explicitly a recovery suite.

Required evidence:
- Test path, command, and required environment variables/secrets.
- Credential source and account type; dedicated test accounts are required for writes.
- Seed data and cleanup/sweep strategy.
- Approval-state assertions for sensitive writes.
- Side-effect assertions against the provider or local authoritative state.
- Statement of strict versus recovery behavior.

CI command / runner expectation:
- Full live/real E2E config: `vitest run --config test/vitest/live-e2e.config.ts <path>`.
- Baseline E2E config excludes specialized LifeOps live suites such as `assistant-user-journeys.live.e2e.test.ts`, `lifeops-calendar-chat.live.e2e.test.ts`, `lifeops-chat.live.e2e.test.ts`, and `lifeops-gmail-chat.live.e2e.test.ts`.
- Required real/live lanes may use `vitest run --config test/vitest/real.config.ts <path>` for `.live.test.ts` or `.real.test.ts`.
- The root plan references `bun run test:e2e:all`; use it only where the workflow exists and actually includes the intended suite.

Skip policy:
- Credential-gated live tests must not silently pass.
- If a skip is deliberate, set `SKIP_REASON="<why>"`; `test/vitest/fail-on-silent-skip.setup.ts` is the repo pattern for failing silent skips.
- Production or personal accounts must not be used for destructive scenarios.
- Real writes require explicit allow flags, recipient/run allowlists, and sweep evidence.

Examples from current plans/tests:
- `plugins/app-lifeops/test/assistant-user-journeys.live.e2e.test.ts` is the planned strict executive-assistant lane for morning brief, travel, docs/browser, identity merge, missed-commitment repair, and push ladder stories.
- `plugins/app-lifeops/test/lifeops-gmail-chat.live.e2e.test.ts` currently needs strict-vs-recovery separation where retry loops exist.
- Gmail real send smoke requires `ELIZA_ALLOW_REAL_GMAIL_WRITES=1`, recipient allowlists, per-run IDs, and sweeper commands before destructive cleanup.

### 6. UI E2E

Purpose:
- Prove the LifeOps UI, desktop shell, browser surface, or mobile/narrow layout supports the capability a user must operate or inspect.
- Validate that agent work, access, approvals, inboxes, calendar, settings, and chat surfaces are visible and usable.

What it proves:
- The page boots and renders the expected state.
- User interactions such as approve/reject, select thread, toggle access, open calendar, acknowledge reminder, or resume browser task work through the UI.
- Layout is usable at required viewport sizes.
- Console/runtime failures are visible to the test.

What it cannot prove:
- Real provider compatibility unless paired with live credentials.
- Correct LLM planning unless the UI test drives the agent through a real backend.
- Background execution unless it triggers or observes the real worker.

Required evidence:
- UI route or app shell target.
- Driver and command.
- Viewports covered.
- Screenshot or artifact path for visual verification where layout matters.
- Assertions for visible state and user interaction, not just page load.

CI command / runner expectation:
- Root Playwright lane: `bun run test:ui:playwright`.
- Package app E2E lane: `bun run --cwd packages/app test:e2e`.
- Desktop-specific work may need Electrobun/Playwright or an equivalent dedicated lane; current LifeOps dashboard review evidence was local screenshot capture, not a required CI gate.

Skip policy:
- UI E2E should not skip because data is absent; seed or mock the data needed for the user flow.
- Visual review artifacts must be local or scrubbed if they contain real personal data.
- A capability requiring approval or access setup is not UI-proven until the relevant control is interacted with.

Examples from current plans/tests:
- The LifeOps dashboard UX review captured `/apps/lifeops` at desktop and narrow viewports, including overview, messages, mail, calendar, settings/access, and right chat.
- The proactive plan calls for an optional desktop/UI smoke proving a secondary cloud-managed calendar renders in the LifeOps month view.
- The coverage closure plan identifies desktop/UI E2E as absent for executive-assistant release proof.

### 7. Benchmark / Reporting

Purpose:
- Prove quality trends, regression risk, and scenario score movement over time.
- Publish comparable reports for executive-assistant scenarios, connector certification, and weekly capability baselines.

What it proves:
- The same task set can be run repeatedly with comparable outputs.
- Aggregate score, pass/fail thresholds, deltas, and artifacts are available for review.
- Release gates can track quality beyond individual tests.

What it cannot prove:
- Correctness of a single side effect unless benchmark tasks include executable assertions.
- Real connector compatibility unless benchmarks run the live credentialed path.
- User-facing UI quality unless UI evidence is part of the benchmark.
- Ground truth if scoring is heuristic-only.

Required evidence:
- Task list or scenario set.
- Runner command.
- Scoring method and threshold.
- Result artifact path.
- Baseline comparison and owner for regressions.

CI command / runner expectation:
- Existing app-eval runner: `bun run packages/benchmarks/app-eval/run-benchmarks.ts`.
- Existing app-eval evaluator: `python3 packages/benchmarks/app-eval/evaluate.py <results-dir> --format json`.
- `packages/benchmarks/app-eval/README.md` states current app-eval scores are deterministic heuristic proxies; plans must not overstate them as ground-truth correctness.
- The coverage closure plan calls for wiring the 22 executive-assistant scenarios and 15 connector certification scenarios into a weekly benchmark report with deltas; that is not yet equivalent to required PR CI unless wired.

Skip policy:
- Missing report artifacts mean no benchmark proof.
- Benchmarks may be allowed to run out of PR CI, but release notes must name the latest successful dated report.
- If the benchmark excludes a capability claim, the claim must point to another proof level.

Examples from current plans/tests:
- `packages/benchmarks/app-eval/` contains `run-benchmarks.ts`, `evaluate.py`, task JSON, and `evaluate.real.test.ts`.
- The executive-assistant capability closure plan calls for an agent-vs-scenario scoring gate and weekly benchmark baseline.

## Strict, Recovery, And Mock Labels

Every scenario, live E2E, and benchmark task must declare one of these behavioral labels:

- `strict`: one prompt or one scheduled trigger; no rescue prompt, retry loop, or best-of-N acceptance.
- `recovery`: tests repair, clarification, retry, reconnect, resume, or eventual success.
- `mock-backed`: provider calls are local mocks; destructive operations are allowed only with ledger proof.
- `live-read`: real provider read path, no writes.
- `live-write`: real provider write path with approval, allowlist, cleanup, and side-effect proof.
- `ui-only`: UI seeded/mocked proof without real backend side effects.
- `reporting`: benchmark/report evidence only.

Plans may combine labels, for example `strict + mock-backed` or `recovery + live-write`. Do not imply strict first-turn quality from a recovery lane.

## Required Capability Claim Checklist

Every LifeOps plan must include a table that maps each capability claim to one or more proof levels. Fill one row per claim; do not group unrelated claims into a single row.

| Capability claim | User-facing risk if false | Proof levels required | Current evidence | Missing proof | Command / runner | Data / credentials | Skip policy | Owner | Status |
|---|---|---|---|---|---|---|---|---|---|
| Example: Daily brief includes pending drafts and overdue follow-ups | User trusts an incomplete morning brief | Scenario, live credentialed E2E, benchmark/reporting | `ea.inbox.daily-brief-cross-channel.scenario.ts` exists; strict live workstream planned | strict seeded live E2E with no rescue turn; benchmark row | `bun run --cwd plugins/app-lifeops test:scenarios`; `vitest run --config test/vitest/live-e2e.config.ts plugins/app-lifeops/test/assistant-user-journeys.live.e2e.test.ts` | seeded Gmail/Calendar/Docs/follow-up data; live LLM/provider secrets for live lane | No silent skip; use `SKIP_REASON` only for documented credential outage | TBD | Planned |

Checklist questions for each row:

- Does the claim require LLM planning? If yes, unit or integration proof alone is insufficient.
- Does the claim require a third-party connector? If yes, include Mockoon/provider mock for deterministic cases and live credentialed E2E for release claims.
- Does the claim perform a write or irreversible action? If yes, include approval-state evidence, reject-path evidence, allowlists, and cleanup.
- Does the claim depend on a scheduled or background job? If yes, include a tick/API proof that executes the worker, not just schedule creation.
- Does the user need to see, approve, resume, or configure it in the app? If yes, include UI E2E.
- Does the claim need release quality trend tracking? If yes, include benchmark/reporting and a dated artifact.
- Is the test strict or recovery? Name it explicitly.
- Can the test skip? If yes, name the exact `SKIP_REASON` policy and why the skip is acceptable.

## Minimum Proof By Capability Type

| Capability type | Minimum proof before implementation is called done | Release-grade proof |
|---|---|---|
| Pure parser/mapper/DTO/reducer | Unit | Unit plus scenario if user-visible behavior depends on it |
| LifeOps service, route, repository, or approval queue | Unit + integration | Integration with side-effect assertions plus scenario |
| LLM action selection or multilingual planning | Scenario with action assertions | Strict live credentialed E2E for critical paths |
| Gmail/Google provider behavior | Mockoon/provider mock + integration | Live read or live write E2E with dedicated test account as appropriate |
| Destructive connector write | Mockoon/provider mock with ledger + approval reject path | Live-write E2E with allowlist, run id, cleanup, and no production account |
| Background job or cron | Integration with explicit clock/tick | Scenario tick/API proof plus live E2E where external dispatch matters |
| Browser portal or blocked/resume workflow | Scenario + provider/browser mock | Live credentialed E2E plus UI E2E for intervention/resume |
| Dashboard, settings, access, approvals, inbox UI | UI E2E | UI E2E across desktop and narrow viewports, paired with integration/live backend proof |
| Executive-assistant benchmark claim | Scenario proof | Weekly benchmark/reporting with thresholds and deltas |

## Planning Rule

A LifeOps capability is not release-proven until the plan identifies:

1. The highest proof level required by the user-facing claim.
2. The lower proof levels that make failures diagnosable.
3. The exact command or runner expected to produce the evidence.
4. The skip policy.
5. The current evidence path and the missing evidence path.

If any of those five items are unknown, the plan should say `Unknown` and add an owner/action to resolve it. Unknown is acceptable during discovery; silent implication is not.
