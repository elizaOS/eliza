# Test-suite de-larp — repo-wide audit report (#10718)

_Consolidates the interaction-QA audit (#10722) and the send/voice/new-chat
lifecycle audit (#10700), and extends the sweep to every test surface in the
monorepo. Findings below are **verified by reading the actual test bodies** — the
grep counts are leads, not proof (root `AGENTS.md`: "tooling is a lead, not
proof")._

Status: **living document.** Section 4 (per-surface findings) is populated from a
12-surface fan-out audit + adversarial verification pass. Sections 1–3 and 5–6
are hand-verified.

---

## 1. Headline metrics (verified, vendored code excluded)

All counts below **exclude** vendored / built / cached trees
(`node_modules`, `dist`, `.turbo`, `coverage`, `src-cache`,
`scripts/bun-riscv64`, `storybook-static`). This exclusion matters: a naive
grep reports **6,626** test files and **21** `.only` markers, but **every one of
those 21 `.only`s lives in a vendored copy of Bun's own test suite**
(`packages/app-core/scripts/bun-riscv64/dist/src-cache/bun/...`), not in
first-party code. Reporting the raw number would itself be larp.

| Metric | Raw (polluted) | **First-party (real)** |
| --- | ---: | ---: |
| Test files (`*.test.ts(x)` / `*.spec.ts(x)`) | 6,626 | **4,363** (3,962 git-tracked) |
| `it/describe/test.only` markers | 21 | **0** |
| Files with `.skip` / `.todo` / `xit` / `xdescribe` | 283 | **140** |
| Total skip/todo occurrences | — | **377** (238 untracked sites) |
| `*.real.test.ts` / `*.real.e2e.test.ts` (PR-lane-excluded) | — | **116** |
| Scenario files (`*.scenario.*`) | — | **922** |

**Meta-finding:** the single biggest source of "how much larp is there?"
confusion is vendored third-party test code polluting every grep. The CI gate
(§5) hard-excludes those trees so the number can't drift.

---

## 2. Systemic patterns (the larp that repeats)

### 2a. Conditional whole-suite skips that no-op green in CI — `packages/feed`
`packages/feed` (an embedded sub-monorepo under `packages/feed/packages/`) is the
single largest concentration of skips (**50 files**). The dominant pattern is a
suite gated on an external dependency being reachable:

```ts
const describeWaitlist = shouldSkip ? describe.skip : describe;                 // waitlist-service.test.ts:36
const dbLazyDescribe = shouldSkipDatabaseTests() ? describe.skip : describe;    // db-lazy-connection.integration.test.ts:15
test.skip(!serverAvailable, "Server not available");                            // cron-endpoints.e2e.test.ts (×9)
test.skip(!serverAvailable, "Server not available");                            // perp-market-trading.e2e.test.ts (×8)
test.skip();                                                                    // perp-market-trading.e2e.test.ts:76 — UNCONDITIONAL dead skip
```

In the PR lane there is no DB and no server, so **these entire suites register
and immediately skip — the run is green while nothing was exercised** (category 5,
"green-but-meaningless"). Remediation: either stand up an ephemeral
Postgres/server in the lane (the `plugin-sql` real tests already prove PGlite is
viable in-process) so the suite actually runs, or delete the suites and stop
claiming coverage. The bare `test.skip()` at `perp-market-trading.e2e.test.ts:76`
is a dead test and should be removed outright.

### 2b. 116 real-path test files the PR lane never runs
`run-all-tests.mjs` sets `VITEST_EXCLUDE_REAL=1` / `VITEST_EXCLUDE_REAL_E2E=1` in
the default `TEST_LANE=pr`, so `*.real.test.ts` and `*.real.e2e.test.ts` drop.
**116 such files exist** and only run in `TEST_LANE=post-merge` — which no PR ever
sees. Concentrations: `plugin-sql` (53), `app-core` (14), `plugin-computeruse`
(12), `plugin-personal-assistant` (8). This is category 3 ("excluded from CI"):
the real-path coverage exists but is invisible to the gate that's supposed to
protect `develop`. Remediation options, per surface: (a) provide the secret/dep
in a dedicated post-merge lane that actually blocks the merge queue, or (b) split
each file into a deterministic PR-safe half (mockable boundary) + a live half, so
the PR lane runs the logic and post-merge runs the wire.

### 2c. Mock-the-unit-under-test in the shell/interaction layer
The interaction surface (#10722) and the send/voice/new-chat lifecycle (#10700)
share a failure mode: the "fuzz"/"controller" tests mock the very thing they
claim to fuzz. `ContinuousChatOverlay.fuzz.test.tsx` fuzzes the detent state
machine against a **fully mocked controller** (`send: vi.fn()`,
`toggleRecording: vi.fn()`, `clearConversation: vi.fn()`);
`useShellController.test.tsx` mocks `sendChatText`. Neither drives the real send
queue, so the reported cross-conversation race (§6) is invisible to them. See §4
(ui-shell) and §6.

### 2d. Source-text greps masquerading as behavioral tests
`view-capability-audit.test.ts` greps for one `useAgentElement(` anywhere in a
view file and calls a 30-control view "covered"; `web-interactions.mjs` clicks
raw `querySelectorAll('button')` and asserts only "no pageerror". These pass
without rendering or correlating controls to agent-reachable elements — they
cannot catch the regression they advertise (category 1). See §4 (ui-spatial /
infra).

---

## 3. What "real" already looks like (so we don't regress it)
Not everything is larp — several surfaces are genuinely strong and set the bar:
- **XR controller path** (`plugins/plugin-xr/simulator/e2e/scene.spec.ts`): drives
  a real emulated Quest 3 via the IWER `navigator.xr` polyfill, ray→hit-test→real
  DOM click. CI-gated. (Gaps: hand/gaze/immersive-WebGL — see §4.)
- **ui-smoke Playwright base** (~109–140 real-Chromium specs in
  `packages/app/test/ui-smoke/`): real `page.mouse`/`page.keyboard`, real hover
  bucketing, real audio input via `--use-file-for-fake-audio-capture`.
- **Real-touch island**: `chat-clear-swipe.spec.ts`, `onboarding-to-home-mobile`
  use CDP `Input.dispatchTouchEvent` / `locator.tap()` in `hasTouch` contexts.
- **plugin-sql real adapter tests**: exercise a real PGlite database in-process.
- **story-gate**: renders ~1,400 stories headless with a determinism shim + axe.

The de-larp job is to raise the rest to this bar, not to tear these down.

---

## 4. Per-surface findings

_Populated from the 12-surface fan-out audit (core, agent, app-e2e, ui-shell,
ui-spatial, ui-components, scenarios, plugins-model, plugins-native, cloud,
lifeops, tui) with an adversarial verification pass over the highest-severity
findings._

### 4a. Per-surface summary

| Surface | Files reviewed | est. larp files | skip/only | excluded-from-lane | Findings |
| --- | ---: | ---: | ---: | ---: | ---: |
| **scenario-runner + scenarios** | 20 | 237 | 0 | 885 | 6 |
| **app e2e / ui-smoke** | 42 | 13 | 25 | 27 | 12 |
| **PA/lifeops/health/skills** | 19 | 8 | 34 | 252 | 9 |
| **cloud backend** | 16 | 3 | 16 | 38 | 20 |
| **tui + feed + app-core** | 16 | 4 | 68 | 79 | 14 |
| **ui spatial/XR + agent-surface** | 28 | 3 | 2 | 3 | 13 |
| **agent runtime+api** | 30 | 1 | 6 | 6 | 8 |
| **core** | 16 | 0 | 4 | 4 | 4 |
| **ui components + story-gate** | 186 | 2 | 14 | 3 | 6 |
| **native device plugins** | 40 | 2 | 19 | 4 | 5 |
| **model + connector plugins** | 15 | 0 | 5 | 16 | 8 |
| **ui shell+gestures** | 90 | 0 | 0 | 4 | 5 |

### 4b. High-severity findings (31) — adversarially verified where marked ✓

| Surface | File | Cat | Verified | Reason → Remediation |
| --- | --- | --- | :---: | --- |
| cloud | `packages/cloud/api/v1/agents/route.test.ts:1` | excluded-from-ci | ✓ | 14 strong regression tests (dup-token race 409, insufficient-credit 402, invalid-wallet 400, cleanup-on-grant-failure 500) but the file sits outside _ → Point the cloud-api unit walker + test-cloud-run.mjs at the colocated route.test.ts tree (or move these into __tests__). Add packa |
| scenarios | `.github/workflows/scenario-matrix.yml:56` | excluded-from-ci | ✓ | 885 of 922 scenarios are lane:live-only and run ONLY here (scenario-matrix, disabled by default: gated on inputs.enabled=='true' \|\| vars.ELIZA_SCENA → Author deterministic-proxy fixtures for the high-value flows and give them lane:pr-deterministic so they execute in test:corpus:pr |
| agent | `packages/agent/src/__tests__/plugin-view-llm-mock-coverage.test.ts:156` | larp | ✓ | The 'routes every mock journey through the deterministic planner contract' test calls mockLlmViewPlanner() defined at lines 76-104 in the SAME file, t → Delete this sub-test or replace it by driving the real view-planner/dispatch (registerPluginViews + the actual planner used by vie |
| agent | `packages/agent/src/runtime/trajectory-capture.real.test.ts:1` | excluded-from-ci | ✓ | Real PGLite end-to-end trajectory-capture round-trip (the bug this file documents: LLM calls captured only in-memory, viewer reads SQL). Named *.real. → Wire a real-DB lane that actually executes *.real.test.ts (or convert this to a non-.real integration test that runs the PGLite pa |
| app-e2e | `packages/app/test/ui-smoke/voice-workbench-cases.ts:138-157` | green-but-meaningless | ⚠ scope | The mock agent stream builds its respond/no-respond SSE body directly from turn.expectRespond, then the harness asserts turn.responded === expectRespo → Move the respond-decision assertion to a live lane that runs the real gate (voice-realaudio-style), or reframe these specs as expl |
| app-e2e | `packages/app/test/ui-smoke/voice-workbench-cases.ts:113-123` | green-but-meaningless | ⚠ scope | Mock /api/asr/local-inference returns each turn's own scenario text (turn.asrText ?? turn.text). The comment even says 'WER stays ~0 against the expec → Feed real audio through a real ASR endpoint in a nightly/live lane for WER claims; keep the keyless spec but drop any transcriptio |
| app-e2e | `packages/app/test/ui-smoke/voice-workbench-cases.ts:245-306` | green-but-meaningless | ⚠ scope | Harness hard-asserts report.diarization.status === 'skipped', evaluated=false, total=0, and per-turn data-predicted-speaker-label==='' in the keyless  → Route real diarization scenarios to the on-device/live acoustic lane (android acoustic specs) and stop advertising these keyless s |
| cloud | `packages/cloud/api/src/index.test.ts:1` | excluded-from-ci | ✓ | Worker-entrypoint redirect tests (308 www->apex path/query preservation, app.* no-redirect) live in src/, which no runner globs (__tests__ only). Neve → Include packages/cloud/api/src in the cloud-api unit walker / test-cloud-run.mjs roots. |
| cloud | `packages/cloud/api/cron/sweep-inference-charges/route.test.ts:1` | excluded-from-ci | ✓ | Cron-secret enforcement + optimistic-billing no-op regression tests for #9899; colocated outside __tests__ so no lane runs them. Billing-cron auth reg → Add cron/**/route.test.ts to the cloud-api unit roots. |
| cloud | `packages/cloud/api/webhooks/bluebubbles/route.test.ts:1` | excluded-from-ci | ✓ | Inbound webhook routing (phone-message dispatch, gateway-device registration) tested with real app.fetch but colocated outside __tests__; excluded fro → Add webhooks/**/route.test.ts to the cloud-api unit roots. |
| cloud | `packages/cloud/api/billing/checkout/verify/route.test.ts:1` | excluded-from-ci | ✓ | Stripe checkout-verify billing route test not under __tests__; unreached by test:cloud or run-unit-isolated. Payment-verify path unguarded in CI. → Include billing/**/route.test.ts in the cloud-api unit roots. |
| cloud | `packages/cloud/api/v1/credits/checkout/route.test.ts:1` | excluded-from-ci | ✓ | Credits-checkout route test colocated outside __tests__; not matched by any lane glob. → Include v1/**/route.test.ts in the cloud-api unit roots. |
| cloud | `packages/cloud/api/auth/create-anonymous-session/route.test.ts:1` | excluded-from-ci | ✓ | Anonymous-session auth route test colocated outside __tests__; the anon-auth surface is exercised nowhere in CI. → Include auth/**/route.test.ts in the cloud-api unit roots. |
| cloud | `packages/cloud/services/operator/capabilities/__tests__/redis-mock.test.ts:18` | larp | ✓ | Zero expect() calls: setServerState/setAgentServer/cleanupServer round-trip runs but never asserts keys were written/removed — comment says 'without t → Assert redis state after each op (get returns set value, cleanup removes tracked keys) and wire operator tests into a lane. |
| cloud | `packages/cloud/shared/src/lib/services/__tests__/direct-wallet-payments.integration.test.ts:35` | non-running | ✓ | `const d = SUPPORTS_VITEST_MOCK_API ? describe : describe.skip` where SUPPORTS_VITEST_MOCK_API = typeof vi.importActual==='function'. Every CI lane in → Rewrite mocks against bun:test's mock API (or port to a vitest lane that CI actually runs) so the on-chain payment state machine i |
| lifeops | `plugins/plugin-personal-assistant/package.json:51` | excluded-from-ci | ✓ | test:background-real runs 4 real/e2e files (scheduled-task-end-to-end.e2e, reminder-review-job.real.e2e, lifeops-scheduling.real, schedule-merged-stat → Either add test:background-real to EXTRA_SCRIPT_NAMES / a post-merge workflow, or fold the deterministic parts of these files into |
| lifeops | `plugins/plugin-personal-assistant/test/scenarios/bill-approval-and-payment.scenario.ts:4` | excluded-from-ci | ✓ | All 178 PA scenario files declare lane:"live-only" (grep: 178 live-only, 0 pr-deterministic). The only runner, .github/workflows/scenario-matrix.yml,  → Add pr-deterministic scenario variants (mock-model or fixture-judge harness like the orchestrator's orchestrator-scenario-logic.te |
| plugins-model | `plugins/plugin-discord/__tests__/connector-loop.harness.test.ts:1` | excluded-from-ci | ✓ | The plugin's highest-fidelity e2e (real MessageManager.handleMessage, inbound guards, buildMemoryFromMessage, outbound channel.send seam under mock-LL → Add test:harness to run-all-tests EXTRA_SCRIPT_NAMES (or a turbo/CI lane) so per-plugin harness suites run in post-merge at minimu |
| plugins-model | `plugins/plugin-openai/__tests__/keyless-harness.harness.test.ts:1` | excluded-from-ci | ✓ | Loads the REAL openaiPlugin under withMockLlmRuntime to prove keyless dispatch; never runs in CI because test:harness is not in EXTRA_SCRIPT_NAMES and → Wire the per-plugin *.harness.test.ts suites into a CI lane (test:harness via run-all-tests or the keyless-harness-e2e workflow in |
| scenarios | `.github/workflows/live-scenarios.yml:226` | green-but-meaningless | ✓ | The nightly run of the live-only corpus sets SCENARIO_ENFORCE_GATE to inputs.enforce_gate?'1':'0'; the cron trigger passes no input, so enforce=0 -> j → Default SCENARIO_ENFORCE_GATE to 1 for the scheduled run (or fail on judge-threshold breach) so nightly scenario failures are actu |
| tui | `packages/app-core/src/api/auth-bootstrap-routes.real.test.ts:271` | excluded-from-ci | ✓ | Real-HTTP P0 auth-bootstrap smoke (RS256/jose + real pglite, single-use jti replay, attacker-signed/wrong-issuer rejection) is dropped by vitest.confi → Add a real lane (e.g. a `test:auth-real` script + workflow) that includes src/api/**/*.real.test.ts, or fix vitest.config to re-in |
| tui | `packages/app-core/src/api/auth-session-routes.real.test.ts:188` | excluded-from-ci | ✓ | 46-assertion real-pglite P1 session-route suite (JSON body parse, cookie minting, audit emission) excluded by the same unconditional real.test drop; r → Wire into a real/nightly lane include glob for src/api real tests; otherwise this session-security path is untested in CI. |
| tui | `packages/app-core/src/api/auth/bootstrap-token.real.test.ts:170` | excluded-from-ci | ✓ | Adversarial verifyBootstrapToken suite (24 expects, real jose keys + pglite replay via recordJtiSeen) excluded by vitest.config real.test rule; no lan → Include under a dedicated real-auth lane; this is the core token verifier and must run somewhere in CI. |
| tui | `packages/scripts/run-all-tests.mjs:367` | excluded-from-ci | ✓ | Root workspace `!packages/feed` + run-all-tests honoring the negation over the whole subtree means the entire feed monorepo (~525 test files) never ru → Document is fine, but ensure feed-test.yml is a required check; non-feed PRs that regress shared code consumed by feed get no sign |
| tui | `.github/workflows/feed-test.yml:16` | excluded-from-ci | ✓ | feed CI runs only `test:unit` (scripts/test-unit-isolated.ts), which excludes all 64 *.integration.test.ts, 5 Playwright *.e2e.test.ts, and the perfor → Implement the promised integration/E2E lane (postgres+foundry+server) or delete the dead integration/e2e specs; do not leave 70 fi |
| ui-shell | `packages/ui/src/components/shell/__e2e__/run-chatux-gesture-e2e.mjs:1` | excluded-from-ci | ✓ | The gesture drag-detent e2e runner is invoked only by the bespoke package script test:chatux-gesture-e2e, which no .github/workflow and no run-all-tes → Rename the script to test:e2e (so run-all-tests picks it up) or add a dedicated workflow job that runs the ui test:*-e2e runners o |
| ui-shell | `packages/ui/vitest.e2e.config.ts:12` | excluded-from-ci | ✓ | The ui test:e2e→test:slow lane has include ['src/**/__e2e__/**/*.test.{ts,tsx}'] but __e2e__ contains only .mjs runners and .tsx fixtures (zero *.test → Either author actual __e2e__/*.test.tsx vitest specs, or wire the .mjs runners into CI; do not leave a green-but-empty e2e lane. |
| ui-spatial | `plugins/plugin-facewear/app-xr/e2e/all-views-crud.spec.ts:1` | excluded-from-ci | ✓ | Playwright spec (webServer node e2e/view-server.mjs). plugin-facewear package.json has no test:e2e and no playwright invocation; grep of .github/workf → Wire app-xr e2e into a CI job (like the xr-harness-e2e job that runs plugin-xr/simulator) or add a facewear test:e2e script invoke |
| ui-spatial | `plugins/plugin-facewear/app-xr/e2e/voice-forms.spec.ts:16` | excluded-from-ci | ✓ | Same orphaning as all-views-crud: not matched by facewear vitest include (src/**), no playwright script in package.json, no workflow runs it. Its asse → Add a CI lane that boots view-server.mjs and runs plugins/plugin-facewear/app-xr/playwright.config.ts, or remove. |
| ui-spatial | `plugins/plugin-facewear/app-xr/e2e/camera-pose.spec.ts:32` | non-running | ✓ | Both tests self-skip: test 1 does if(!connected) test.skip(...) when window.__xrEmulator is absent, test 2 asserts only typeof setPose then test.skip  → Provide the emulator fixture in a real lane and remove the skip-on-missing guards so absence fails; otherwise the 'panels follow c |
| ui-spatial | `plugins/plugin-xr/src/__tests__/xr-feature-parity.test.ts:502` | green-but-meaningless | ✓ | Meta-larp: cross-cut tests (502-521) assert that OTHER spec files (app-xr/e2e/all-views-crud.spec.ts, voice-forms.spec.ts, camera-pose.spec.ts) merely → Delete the cross-cut string-scrape tests; replace with actually running those specs in CI, or with a behavioral assertion on the v |

### 4c. Full findings appendix (all severities)

<details><summary><b>scenario-runner + scenarios</b> — 6 findings</summary>

_The scenario-runner's own vitest UNIT suite (23 files, ~6.8k lines) is genuinely high quality and is NOT larp: action-family matching, interceptor delivered-defaults, voice-turn (with a real regression/failure case), cerebras-judge (mocks only the HTTP boundary and tests real JSON/verdict parsing), runtime-factory, seeds, reporter, final-checks, and two strong meta-ratchets (echo-assertion-ratchet, corpus-assertion-guard) all assert real behavior with edge cases, correct collaborator-only mocking, and healthy expect ratios. Zero it.only/describe.only/.skip and zero toHaveBeenCalled-only tests _

Top remediation targets:
- Give a curated high-value subset of the 885 live-only scenarios a deterministic-proxy fixture + lane:pr-deterministic so they actually gate PRs (packages/test/scenarios, plugin-personal-assistant, plugin-health)
- Default SCENARIO_ENFORCE_GATE=1 on the nightly live-scenarios.yml cron so the one place the corpus runs is blocking
- Burn down the 237 echo-satisfiable scenarios (echo-assertion-ratchet BASELINE) to real effect-based assertions and lower the baseline
- Migrate the 62 dead acceptedActions/includesAny turn fields to real assertion fields and ratchet corpus-assertion-guard baseline to 0
- Add an executed-scenario-count guard for test:corpus:pr:e2e so a 687-file corpus lane cannot silently shrink to 3

- **[critical/excluded-from-ci]** `.github/workflows/scenario-matrix.yml:56` ✓verified — 885 of 922 scenarios are lane:live-only and run ONLY here (scenario-matrix, disabled by default: gated on inputs.enabled=='true' || vars.ELIZA_SCENARIO_MATRIX_ENABLED=='true') or in nightly live-scenarios.yml — never on any PR. The entire personal-assistant (178), health (8), and 684/687 packages/test/scenarios corpora gate nothing on merge. _Fix:_ Author deterministic-proxy fixtures for the high-value flows and give them lane:pr-deterministic so they execute in test:corpus:pr:e2e; or add a required PR job that runs a curated live-only subset against a cheap real model. Do not present a 900-file corpus as coverage while 96% never runs pre-merge.
- **[high/green-but-meaningless]** `.github/workflows/live-scenarios.yml:226` ✓verified — The nightly run of the live-only corpus sets SCENARIO_ENFORCE_GATE to inputs.enforce_gate?'1':'0'; the cron trigger passes no input, so enforce=0 -> judge failures do not fail the workflow. Even the one place the 885 live scenarios execute is non-blocking, so regressions surface as a green checkmark. _Fix:_ Default SCENARIO_ENFORCE_GATE to 1 for the scheduled run (or fail on judge-threshold breach) so nightly scenario failures are actually visible/blocking; keep a documented allow-list for known-flaky ids instead of a blanket non-enforce.
- **[medium/larp]** `plugins/plugin-personal-assistant/test/scenarios/water-french-casual.scenario.ts:25` — Concrete echo-larp instance: turn asserts responseIncludesAny:[...,eau,boire] against input '...boire de l'eau?' (line 24) — eau/boire are literally the input words, so the turn check is tautological. The definitionCountDelta finalCheck is the only load-bearing assertion, but it is live-only so nothing enforces it pre-merge. _Fix:_ Drop the echoed keywords from responseIncludesAny (keep only English target terms not in the French input, e.g. saved/reminder), and rely on the finalCheck; representative of the 237-file backlog.
- **[medium/larp]** `packages/scenario-runner/src/corpus-assertion-guard.test.ts:204` — DEAD_TURN_ASSERTION_BASELINE freezes 31 scenarios using turn-level acceptedActions: and 31 using includesAny: — both fields the executor IGNORES (correct names are expectedActions / responseIncludesAny). These 62 non-functional assertions are grandfathered as debt; a scenario relying on them for behavior coverage asserts nothing at the turn level. _Fix:_ Migrate the 62 dead fields to the real field names (expectedActions / responseIncludesAny) or real finalChecks and ratchet the baseline down to 0; the AST guard already lists offenders.
- **[medium/incomplete]** `packages/scenario-runner/package.json:69` ✓verified — test:corpus:pr:e2e runs ../test/scenarios (687 files) with --lane pr-deterministic, but only 3 files declare that lane (convo/greeting-dynamic, convo/echo-self-test, linear/search-issues). The step name implies a corpus gate; it actually executes 3 scenarios. The 684 live-only files are silently filtered out by loader.ts:422. _Fix:_ Either rename the step to reflect it runs 3 scenarios, or promote a meaningful deterministic subset to lane:pr-deterministic; add a guard that fails if the corpus lane resolves to fewer than N executed scenarios (mirrors the existing 'scans >500 files' guard but for EXECUTED count).
- **[low/green-but-meaningless]** `packages/scenario-runner/src/__tests__/lifeops-travel-scenarios.test.ts:66` — This suite (and its scheduling/executive-assistant siblings) asserts scenario FILE SHAPE only — ids match an expected list, domain/tags present, turns.length>0, finalChecks.length>0, some check type is custom/judgeRubric. It never runs the scenario or verifies agent behavior, so it stays green regardless of whether any travel flow works; a manifest guard mislabeled as scenario coverage. _Fix:_ Keep as a lightweight manifest ratchet but rename to make clear it validates structure, not behavior; the behavioral guarantee must come from actually executing these scenarios in an enforcing lane (see finding #1).

</details>

<details><summary><b>app e2e / ui-smoke</b> — 12 findings</summary>

_The app e2e surface is large (107 ui-smoke specs + android/electrobun/dev-smoke/hmr) and, for pure UI plumbing, mostly honest: specs mock /api (a legitimate collaborator) and assert real DOM/URL/visibility outcomes, the PR lane is directory-driven with a checked-in deny-list + coverage gate, and the android `.test.ts` files are genuine pure-logic unit tests. The worst offenders are the voice-workbench cluster (~10 specs on the PR gate) whose shared harness (voice-workbench-cases.ts) feeds the answer to itself: the mock ASR returns each turn's own reference text (WER~0 is tautological), the moc_

Top remediation targets:
- packages/app/test/ui-smoke/voice-workbench-cases.ts — the shared harness that makes ~10 PR-gate voice specs tautological (mock-fed respond decision, self-referential ASR transcript, diarization asserted-skipped, entity unasserted); split into an honest plumbing spec + move capability assertions to a live/on-device audio lane
- packages/app/test/android/*.android.spec.ts (7) — wire an emulator KVM PR/cron lane so on-device coverage is not workflow_dispatch-only
- packages/app/test/electrobun-packaged/*.e2e.spec.ts (5) — add a PR-lane packaged desktop smoke so packaging regressions are caught before merge (currently nightly-only)
- packages/app/test/ui-smoke/apps-personal-assistant-feed-interactions.spec.ts:424,499 — delete the two dead-view test.skip fixtures
- packages/app/test/ui-smoke/ai-qa-capture.spec.ts & settings-audit-capture.spec.ts — either assert on collected page issues or deny-list them as reporting tools so they stop counting as PR smoke coverage

- **[high/green-but-meaningless]** `packages/app/test/ui-smoke/voice-workbench-cases.ts:138-157` ⚠scope — The mock agent stream builds its respond/no-respond SSE body directly from turn.expectRespond, then the harness asserts turn.responded === expectRespond — the real should-respond gate never runs, so the assertion is tautological. Drives voice-workbench-respond-no-respond.spec.ts and 9 sibling specs on the PR gate. _Fix:_ Move the respond-decision assertion to a live lane that runs the real gate (voice-realaudio-style), or reframe these specs as explicitly 'workbench display plumbing' and stop naming them after the capability (respond/diarization) they do not exercise keyless.
- **[high/green-but-meaningless]** `packages/app/test/ui-smoke/voice-workbench-cases.ts:113-123` ⚠scope — Mock /api/asr/local-inference returns each turn's own scenario text (turn.asrText ?? turn.text). The comment even says 'WER stays ~0 against the expected reference' — transcription accuracy is asserted against the very string the mock was handed. No real ASR is tested. _Fix:_ Feed real audio through a real ASR endpoint in a nightly/live lane for WER claims; keep the keyless spec but drop any transcription-accuracy assertion, which is currently self-fulfilling.
- **[high/green-but-meaningless]** `packages/app/test/ui-smoke/voice-workbench-cases.ts:245-306` ⚠scope — Harness hard-asserts report.diarization.status === 'skipped', evaluated=false, total=0, and per-turn data-predicted-speaker-label==='' in the keyless lane. So voice-workbench-diarization/multi-speaker/multi-voice/multi-agent-room specs assert that speaker attribution did NOT happen — the diarizer capability they are named for is never run on PR. _Fix:_ Route real diarization scenarios to the on-device/live acoustic lane (android acoustic specs) and stop advertising these keyless specs as diarization/multi-speaker coverage; rename to '<class>-workbench-plumbing'.
- **[medium/incomplete]** `packages/app/test/ui-smoke/voice-workbench-cases.ts:28` ⚠scope — expectedEntity is declared on the turn type and set by voice-workbench-entity-extraction.spec.ts, but the harness's per-turn assertion loop (lines 273-306) never references it — the entity-extraction claim is set-up-but-never-asserted (only status/responded/speakerLabel are checked). _Fix:_ Add an assertion comparing the workbench's extracted entity against expectedEntity, or delete voice-workbench-entity-extraction.spec.ts as it verifies nothing entity-specific.
- **[medium/excluded-from-ci]** `packages/app/test/android/onboarding-to-home.android.spec.ts + 6 sibling .android.spec.ts` — playwright.android.config.ts is only invoked by test:e2e:android*, referenced solely in android-device-e2e.yml which triggers on workflow_dispatch ONLY — no PR or scheduled run ever executes these 7 on-device specs. _Fix:_ Wire the emulator-capable subset (route-coverage/onboarding) into a KVM CI lane on a cron or PR-label trigger; document the rest as manual device-only in a README so the exclusion is intentional and visible.
- **[medium/excluded-from-ci]** `packages/app/test/electrobun-packaged/desktop-launch-render.e2e.spec.ts + 4 sibling e2e.spec.ts` — test:desktop:packaged (playwright.electrobun.packaged.config.ts) runs only in app-live-e2e.yml's nightly 'desktop-packaged' job (and release-electrobun.yml) — never on PR. Packaged-app regressions cannot be caught before merge. _Fix:_ Add a PR-lane packaged smoke (build + boot + first-paint) under xvfb, or gate it behind a path filter on packages/app-core/platforms/electrobun so desktop-shell PRs at least run one packaged spec.
- **[medium/non-running]** `packages/app/test/ui-smoke/apps-personal-assistant-feed-interactions.spec.ts:424,499` — Two unconditional test.skip() blocks (lifeops reminders/alarms + chat-first prompts) whose target views were deleted ('LifeOps overview view was removed'). These are dead test fixtures kept as skipped bodies in a spec that otherwise runs on PR. _Fix:_ Delete both skipped test bodies and the now-unused installLifeOpsInteractionRoutes fixtures they reference — the comment already says they should be removed.
- **[low/non-running]** `packages/app/test/ui-smoke/multi-window-sync.spec.ts:38` — Unconditional test.skip('a synced preference toggled in window A propagates to window B') — asserts a BroadcastChannel/useTabSync layer the renderer 'does not yet ship'. A spec for an unbuilt feature; deny-listed as keyless-debt but never runs anywhere (not even live). _Fix:_ Convert to a tracked issue rather than a checked-in skipped spec, or implement the feature; a permanently-skipped spec for absent code is not coverage.
- **[low/non-running]** `packages/app/test/ui-smoke/multi-client-desync.spec.ts:59` — Unconditional test.skip('two clients on the same agent converge and do not desync') — self-skips because the keyless route layer has no shared message store. Deny-listed keyless-debt but never executes in any lane. _Fix:_ Wire a shared fixture backend so it can run keyless, or move it to the live-stack lane; otherwise delete and track as an issue.
- **[medium/green-but-meaningless]** `packages/app/test/ui-smoke/ai-qa-capture.spec.ts:346-380` — Page errors/console issues are collected into `issues` and written to a JSON report but never asserted; the test only rethrows if capture() itself throws. A route that renders with console errors or fails readiness still passes — it is a screenshot/inventory harness, not a gate. _Fix:_ Add expect(record.issues).toEqual([]) and expect(record.readyOk).toBe(true) per capture, or move this spec out of the ui-smoke test dir into scripts/ and mark it a reporting tool (deny-list it).
- **[low/non-running]** `packages/app/test/ui-smoke/settings-audit-capture.spec.ts:45` — Self-skips unless ELIZA_SETTINGS_AUDIT=1 and the comment states it 'only screenshots (no assertions)'. It is NOT in .pr-deny-list.json, so the coverage gate counts it as 'runnable on PR' while it always skips — a capture-only spec with zero assertions masquerading as a PR test. _Fix:_ Add it to .pr-deny-list.json under category dedicated-tool (like settings-spacing/theme-audit) so the gate reflects reality; it has no assertions and should not count as smoke coverage.
- **[medium/green-but-meaningless]** `packages/app/test/ui-smoke/voice-workbench-eot.spec.ts / voice-workbench-transcription-mode.spec.ts / voice-workbench-voice-recognition.spec.ts` — Same shared harness (voice-workbench-cases.ts): all turns route through the scripted mock ASR + scripted respond stream, so end-of-turn, transcription-mode and voice-recognition scenarios assert display plumbing over pre-scripted answers, not the named acoustic/EOT behavior. _Fix:_ Consolidate the keyless workbench specs into one 'workbench-plumbing' spec and push per-capability (EOT/transcription/recognition) assertions to the real-audio/live lane.

</details>

<details><summary><b>PA/lifeops/health/skills</b> — 9 findings</summary>

_The unit-test layer here is strong, not larp: I read the orchestrator goal-llm-verifier, health real-connector, skills resolver, PA runtime-service-delegates, and companion tests — they exercise real prompt builders/parsers/normalizers with genuine edge/error/empty cases and mock only true collaborators (the model, the OAuth service). There are zero `.only`, no `expect(true).toBe(true)`, no self-mocking of the unit under test, and no no-assert files across the whole surface. The real weakness is CI wiring and the scenario suite. The single worst offender is that PA's entire agent-behavior scen_

Top remediation targets:
- Un-orphan plugin-personal-assistant/package.json test:background-real (4 real/e2e scheduling files run nowhere) — add to run-all-tests EXTRA_SCRIPT_NAMES or a post-merge workflow
- Add pr-deterministic scenario coverage (fixture-judge harness, like orchestrator-scenario-logic.test.ts) for PA + health planner routings so the 186 live-only scenarios are not the only behavior verification
- Enable scenario-matrix.yml on a scheduled/post-merge lane so live-only scenarios actually run routinely instead of only via manual workflow_dispatch
- Replace question-echo responseIncludesAny matchers across PA scenarios with outcome-specific judgeRubric/verifier assertions
- Fix PA/health test:scenarios scripts to `run` (with a lane) rather than `list`-only

- **[high/excluded-from-ci]** `plugins/plugin-personal-assistant/package.json:51` ✓verified — test:background-real runs 4 real/e2e files (scheduled-task-end-to-end.e2e, reminder-review-job.real.e2e, lifeops-scheduling.real, schedule-merged-state.real) but this script name is NOT in run-all-tests EXTRA_SCRIPT_NAMES (only test/test:integration/test:e2e/test:playwright/test:ui/test:live) and appears in no .github workflow — verified via grep. These scheduling/reminder end-to-end tests never execute in any lane. _Fix:_ Either add test:background-real to EXTRA_SCRIPT_NAMES / a post-merge workflow, or fold the deterministic parts of these files into the default vitest include so scheduled-task behavior is actually exercised in CI.
- **[high/excluded-from-ci]** `plugins/plugin-personal-assistant/test/scenarios/bill-approval-and-payment.scenario.ts:4` ✓verified — All 178 PA scenario files declare lane:"live-only" (grep: 178 live-only, 0 pr-deterministic). The only runner, .github/workflows/scenario-matrix.yml, is disabled by default (requires ELIZA_SCENARIO_MATRIX_ENABLED=true or manual workflow_dispatch). So the entire PA agent-behavior/planner-routing surface has no coverage in the PR or develop-push lane. _Fix:_ Add pr-deterministic scenario variants (mock-model or fixture-judge harness like the orchestrator's orchestrator-scenario-logic.test.ts) for the core planner routings, or enable the scenario matrix on a scheduled/post-merge lane so live-only scenarios run routinely.
- **[medium/green-but-meaningless]** `plugins/plugin-personal-assistant/package.json:53` ✓verified — test:scenarios invokes the scenario CLI with `list`, not `run` — it only enumerates scenario files and never executes any assertion. A passing `bun run test:scenarios` proves nothing about scenario behavior. Same pattern in plugin-health and plugin-agent-orchestrator (orchestrator uses `run`, PA/health use `list`). _Fix:_ Change PA/health test:scenarios to `run ... --lane pr-deterministic` (after adding deterministic scenarios), or remove the misleading `list`-only script so it is not mistaken for coverage.
- **[medium/excluded-from-ci]** `plugins/plugin-health/test/scenarios/wake-up-routine.scenario.ts:4` — All 8 health scenarios are lane:"live-only" (grep: 8 live-only, 0 pr-deterministic), gated behind the same default-disabled scenario-matrix workflow. Sleep/wake/screen-time recap behavior is never verified in routine CI. _Fix:_ Add pr-deterministic coverage for the health planner routings or wire the scenarios into a scheduled live lane.
- **[medium/incomplete]** `plugins/plugin-personal-assistant/test/scenarios/bill-approval-and-payment.scenario.ts:29` ✓verified — responseIncludesAny:["bill","approval","risk"] against a prompt that literally contains 'bills need my approval' and 'riskiest' — the matcher passes purely on question-echo and asserts nothing about correct behavior. This echo-matcher pattern recurs across the 178 PA scenarios (partly mitigated by real plannerIncludesAll/plannerExcludes planner-trace assertions in the same turns). _Fix:_ Replace question-echo responseIncludesAny with judgeRubric/verifier assertions on outcome-specific tokens the model would not get for free (e.g. a specific amount, payee, or follow-up date), keeping the planner-trace matchers.
- **[low/excluded-from-ci]** `plugins/plugin-health/test/strava-connector.real.test.ts:26` — 4 health *.real.test.ts files are matched by the PR-lane include glob (health vitest.config excludes only *.live.test.ts and *.e2e.test.ts, not *.real.test.ts) but self-skip via describe.skipIf(!LIVE) where LIVE requires STRAVA_LIVE_TEST=1/post-merge + token, so they no-op in PR. Mitigated: each has a keyless *.contract.test.ts counterpart that does run, so the normalizer is covered. _Fix:_ Acceptable as-is given contract counterparts; optionally exclude *.real.test.ts from the health config for consistency with the other packages and ensure a post-merge lane sets the tokens.
- **[low/larp]** `plugins/plugin-companion/src/components/companion/companion-app.test.ts:26` — Second test mocks @elizaos/ui's registerOverlayApp and asserts only registerOverlayApp.toHaveBeenCalledWith(companionApp) — the collaborator is mocked and the wrapper does nothing else, so this verifies little beyond the one-line forward. The first test (descriptor shape) is meaningful. _Fix:_ Low priority; if kept, add an assertion that the descriptor's loader actually resolves the view, or drop the redundant wrapper-call test.
- **[low/non-running]** `plugins/plugin-agent-orchestrator/vendor/opencode/packages/opencode/test/session/instruction.test.ts:198` — test.todo("fetches remote instructions from config URLs via HttpClient") — an unimplemented placeholder. It is vendored third-party opencode code and is also not matched by the orchestrator vitest include glob (include is only __tests__/** and src/__tests__/**), so it never runs regardless. _Fix:_ No action needed for our surface (vendored); do not count vendor tests toward orchestrator coverage.
- **[low/excluded-from-ci]** `plugins/plugin-agent-orchestrator/vitest.config.ts:6` — The orchestrator vitest include is `["__tests__/**/*.test.ts","src/__tests__/**/*.test.ts"]`, so the 372 vendored opencode tests under vendor/opencode/**/test are never collected. This is expected for vendored code but means the 493 raw test-file count for this plugin overstates real coverage ~4x (only 114 are first-party). _Fix:_ None required; noting so the file count is not mistaken for owned coverage. Consider a top-level .gitattributes/linguist-vendored marker for clarity.

</details>

<details><summary><b>cloud backend</b> — 20 findings</summary>

_The cloud unit tests I read are, on the whole, genuinely good — real Hono `app.fetch` requests with edge cases (duplicate-token races, insufficient-credit 402s, invalid-wallet 400s, cleanup-on-grant-failure), a property-based/fuzz routing suite, and cron-secret enforcement. The dominant problem is NOT larp assertions; it is a CI-wiring hole. The cloud PR gate (`cloud-tests.yml` -> `test:cloud` -> `packages/scripts/test-cloud-run.mjs`) runs `bun test` on ONLY three roots: `packages/cloud/shared/src`, `packages/cloud/api/__tests__`, and `packages/scripts/cloud`. The `cloud/api` package's own `te_

Top remediation targets:
- Fix packages/scripts/test-cloud-run.mjs + packages/cloud/api/test/run-unit-isolated.mjs to run the 19 colocated route.test.ts files (api/{auth,billing,cron,v1,webhooks} + src) — they are the best tests in the surface and run in zero lanes
- Un-skip direct-wallet-payments.integration.test.ts by porting its vi.mock usage to bun:test (or a CI-run vitest lane) so the on-chain wallet-payment state machine is actually exercised
- Add cloud/routing, cloud/sdk, and cloud/services/{agent-server,operator,coding-remote-runner} unit steps to cloud-tests.yml so they gate PRs instead of only nightly
- Give operator/.../redis-mock.test.ts real post-op assertions (currently zero expect) and provision Postgres for the tenant-db + group-g2 MCP-write suites so revenue-split + provisioning logic stops living in describe.skip
- Harden e2e `if(!serverReachable) return` guards to fail loudly so a dead harness reddens the lane instead of passing green

- **[critical/excluded-from-ci]** `packages/cloud/api/v1/agents/route.test.ts:1` ✓verified — 14 strong regression tests (dup-token race 409, insufficient-credit 402, invalid-wallet 400, cleanup-on-grant-failure 500) but the file sits outside __tests__; test-cloud-run.mjs only runs api/__tests__ and run-unit-isolated.mjs walks only __tests__, so this runs in NO lane (incl. nightly). _Fix:_ Point the cloud-api unit walker + test-cloud-run.mjs at the colocated route.test.ts tree (or move these into __tests__). Add packages/cloud/api/{auth,billing,cron,v1,webhooks} to the test roots.
- **[high/excluded-from-ci]** `packages/cloud/api/src/index.test.ts:1` ✓verified — Worker-entrypoint redirect tests (308 www->apex path/query preservation, app.* no-redirect) live in src/, which no runner globs (__tests__ only). Never executed in CI. _Fix:_ Include packages/cloud/api/src in the cloud-api unit walker / test-cloud-run.mjs roots.
- **[high/excluded-from-ci]** `packages/cloud/api/cron/sweep-inference-charges/route.test.ts:1` ✓verified — Cron-secret enforcement + optimistic-billing no-op regression tests for #9899; colocated outside __tests__ so no lane runs them. Billing-cron auth regressions ship untested. _Fix:_ Add cron/**/route.test.ts to the cloud-api unit roots.
- **[high/excluded-from-ci]** `packages/cloud/api/webhooks/bluebubbles/route.test.ts:1` ✓verified — Inbound webhook routing (phone-message dispatch, gateway-device registration) tested with real app.fetch but colocated outside __tests__; excluded from every lane. _Fix:_ Add webhooks/**/route.test.ts to the cloud-api unit roots.
- **[high/excluded-from-ci]** `packages/cloud/api/billing/checkout/verify/route.test.ts:1` ✓verified — Stripe checkout-verify billing route test not under __tests__; unreached by test:cloud or run-unit-isolated. Payment-verify path unguarded in CI. _Fix:_ Include billing/**/route.test.ts in the cloud-api unit roots.
- **[high/excluded-from-ci]** `packages/cloud/api/v1/credits/checkout/route.test.ts:1` ✓verified — Credits-checkout route test colocated outside __tests__; not matched by any lane glob. _Fix:_ Include v1/**/route.test.ts in the cloud-api unit roots.
- **[medium/excluded-from-ci]** `packages/cloud/api/v1/containers/route.test.ts:1` ✓verified — Container-provisioning route test outside __tests__; unreached by CI. _Fix:_ Include v1/**/route.test.ts in the cloud-api unit roots.
- **[medium/excluded-from-ci]** `packages/cloud/api/v1/eliza/agents/[agentId]/pairing-token/route.test.ts:1` ✓verified — Agent pairing-token issuance route test outside __tests__; unreached by CI. _Fix:_ Include v1/**/route.test.ts in the cloud-api unit roots.
- **[high/excluded-from-ci]** `packages/cloud/api/auth/create-anonymous-session/route.test.ts:1` ✓verified — Anonymous-session auth route test colocated outside __tests__; the anon-auth surface is exercised nowhere in CI. _Fix:_ Include auth/**/route.test.ts in the cloud-api unit roots.
- **[high/larp]** `packages/cloud/services/operator/capabilities/__tests__/redis-mock.test.ts:18` ✓verified — Zero expect() calls: setServerState/setAgentServer/cleanupServer round-trip runs but never asserts keys were written/removed — comment says 'without throwing' and that is all it checks. Set-up-but-never-assert; also operator has no CI workflow so it only runs in nightly. _Fix:_ Assert redis state after each op (get returns set value, cleanup removes tracked keys) and wire operator tests into a lane.
- **[high/non-running]** `packages/cloud/shared/src/lib/services/__tests__/direct-wallet-payments.integration.test.ts:35` ✓verified — `const d = SUPPORTS_VITEST_MOCK_API ? describe : describe.skip` where SUPPORTS_VITEST_MOCK_API = typeof vi.importActual==='function'. Every CI lane invokes this via `bun test` (test:cloud, nightly cloud/shared#test), where vi.importActual is undefined -> the entire wallet-payment state-machine suite is skipped in CI. Only a dev running `vitest run` executes it. _Fix:_ Rewrite mocks against bun:test's mock API (or port to a vitest lane that CI actually runs) so the on-chain payment state machine is exercised in CI, not skipped by runner detection.
- **[medium/excluded-from-ci]** `packages/cloud/routing/src/resolve.test.ts:1` — Excellent fuzz/property suite (fc.assert numRuns:500 SSRF-escape checks, 12-fixture policy matrix). cloud-tests.yml paths/jobs never run cloud/routing; test:cloud omits it; only nightly's full `bun run test` runs it. Not in the PR gate. _Fix:_ Add a routing unit step to cloud-tests.yml (bun run --cwd packages/cloud/routing test) so this runs on PRs, not only nightly.
- **[medium/excluded-from-ci]** `packages/cloud/sdk/src/client.test.ts:1` — cloud/sdk unit tests (client/http/public-routes/policy/mock-service) run in no PR lane: cloud-tests unit job = test:cloud (excludes sdk); test.yml only runs sdk `test:e2e` (live, soft-failing). SDK unit coverage is nightly-only. _Fix:_ Add `bun run --cwd packages/cloud/sdk test` to cloud-tests.yml unit job.
- **[medium/non-running]** `packages/cloud/api/test/e2e/group-g2-mcp-registry.test.ts:194` — `describe.skip('Group G2 — user MCP registry CRUD writes')` disables all create/update/publish/delete tests incl. the revenue-split computation (creator_share 70.00 / platform_share 30.00). Documented (PGlite-over-TCP broken pipe) with TODO(mcp), but the MCP revenue-split business logic is asserted only inside this skipped block — untested in CI. _Fix:_ Run this group against a real Postgres in the e2e job (or unit-test the revenue-split computation directly) so the split math is not exclusively in a describe.skip.
- **[medium/green-but-meaningless]** `packages/cloud/api/test/e2e/group-g2-mcp-registry.test.ts:124` — Every e2e test opens with `if (!serverReachable) return;` / `if (!shouldRunAuthed()) return;` — if the harness fails to boot or auth, the test returns and passes green with zero assertions rather than failing. _Fix:_ Fail (or hard-skip with a non-passing status) when serverReachable is false so a dead harness reddens the lane instead of silently passing.
- **[medium/non-running]** `packages/cloud/shared/src/lib/services/tenant-db/tenant-db-provisioning.integration.test.ts:134` — `const d = RUN ? describe : describe.skip` where RUN depends on acquireEphemeralPostgres() returning non-null. The cloud unit lane sets SKIP_DB_DEPENDENT=1 and provides no ephemeral Postgres, so the whole real-Postgres tenant-provisioning suite skips (loud warn, still green). _Fix:_ Provision a Postgres service in the cloud unit/integration job so tenant-db provisioning is exercised, or move to the integration lane that has a DB.
- **[low/non-running]** `packages/cloud/api/__tests__/voice-kokoro-whisper-live.test.ts:23` — `const maybe = LIVE ? test : test.skip` — TTS/STT round-trip skips unless a LIVE env flag is set; in the standard PR unit lane it is skipped. _Fix:_ Confirm a lane sets LIVE (post-merge) or add a non-live assertion path; otherwise document as post-merge-only.
- **[low/excluded-from-ci]** `packages/cloud/sdk/src/live.e2e.test.ts:36` — Heavily env-gated (liveEnabled/apiKey/sessionToken/container/agent/relay each pick describe vs describe.skip). Runs only when ELIZA_CLOUD_SDK_LIVE=1 in test.yml's soft-failing 'Run Cloud tests' step, which swallows 429/5xx/network errors — so most of this suite is skip-by-default and non-blocking. _Fix:_ Keep as a live post-merge suite but ensure at least the OpenAPI-contract portion runs unconditionally in the PR lane.
- **[low/excluded-from-ci]** `packages/cloud/services/agent-server/__tests__/unit/redis-mock.test.ts:1` ✓verified — Real assertions (get==set, expire, null-after-expire) but agent-server has no CI workflow; only nightly's full `bun run test` runs it. Not in the cloud PR gate. _Fix:_ Add agent-server (and coding-remote-runner) unit steps to cloud-tests.yml.
- **[low/excluded-from-ci]** `packages/cloud/infra/tests/terraform-static.test.ts:1` — cloud/infra `test` (bun test tests) is not invoked by cloud-tests.yml (paths omit infra) nor any infra workflow's test step; nightly-only. _Fix:_ If these static IaC checks should gate PRs, add an infra unit step to cloud-tests.yml.

</details>

<details><summary><b>tui + feed + app-core</b> — 14 findings</summary>

_The in-lane tests I opened for tui (packages/tui/test/*) and app-core (packages/app-core/src/api/*.test.ts) are genuinely good: they exercise real units (Loader render, route dispatch, CORS) with collaborators mocked, and no self-mocking or tautologies were found. The rot is in the CI wiring, not the assertions. Three high-quality, security-critical app-core auth "real" tests (bootstrap-routes / session-routes / bootstrap-token, ~85 real assertions against real pglite + jose RS256, adversarial cases) are excluded from EVERY lane: vitest.config.ts:160 unconditionally drops `**/*.real.test.ts`, _

Top remediation targets:
- packages/app-core/src/api/auth-bootstrap-routes.real.test.ts + auth-session-routes.real.test.ts + auth/bootstrap-token.real.test.ts — wire src/api *.real.test.ts into a real CI lane (they are excluded by vitest.config.ts:160 and cite non-existent agent-review.yml/agent-release.yml gates)
- .github/workflows/feed-test.yml — implement the promised integration + E2E lane (postgres/foundry/server) so the 64 integration + 5 e2e feed specs actually run, or delete the dead specs
- packages/feed/packages/testing/e2e/*.e2e.test.ts — replace self-skip-on-no-server with a hard precondition under a lane that boots the server
- packages/feed/scripts/test-unit-isolated.ts:52 — relocate no-cheating.test.ts (security) to a lane that runs it
- packages/tui/test/autocomplete.test.ts:44 — install fd in tui CI so the describe.skip path is exercised

- **[high/excluded-from-ci]** `packages/app-core/src/api/auth-bootstrap-routes.real.test.ts:271` ✓verified — Real-HTTP P0 auth-bootstrap smoke (RS256/jose + real pglite, single-use jti replay, attacker-signed/wrong-issuer rejection) is dropped by vitest.config.ts:160 `**/*.real.test.ts` exclude; no config re-includes src/api real tests. Its header cites `agent-review.yml` P0 gate + `agent-release.yml` smoke-auth, both of which do not exist — the security gate it claims never runs. _Fix:_ Add a real lane (e.g. a `test:auth-real` script + workflow) that includes src/api/**/*.real.test.ts, or fix vitest.config to re-include under a TEST_LANE flag. Correct/remove the stale P0-gate header referencing non-existent workflows.
- **[high/excluded-from-ci]** `packages/app-core/src/api/auth-session-routes.real.test.ts:188` ✓verified — 46-assertion real-pglite P1 session-route suite (JSON body parse, cookie minting, audit emission) excluded by the same unconditional real.test drop; runs in no lane (test:app-real-e2e config only globs test/app/**/*.real.e2e.test.ts). _Fix:_ Wire into a real/nightly lane include glob for src/api real tests; otherwise this session-security path is untested in CI.
- **[high/excluded-from-ci]** `packages/app-core/src/api/auth/bootstrap-token.real.test.ts:170` ✓verified — Adversarial verifyBootstrapToken suite (24 expects, real jose keys + pglite replay via recordJtiSeen) excluded by vitest.config real.test rule; no lane executes it. _Fix:_ Include under a dedicated real-auth lane; this is the core token verifier and must run somewhere in CI.
- **[high/excluded-from-ci]** `packages/scripts/run-all-tests.mjs:367` ✓verified — Root workspace `!packages/feed` + run-all-tests honoring the negation over the whole subtree means the entire feed monorepo (~525 test files) never runs in the root PR/server/client lanes; only path-gated feed-test.yml covers it, and only when a PR touches packages/feed. _Fix:_ Document is fine, but ensure feed-test.yml is a required check; non-feed PRs that regress shared code consumed by feed get no signal — consider a lightweight cross-lane smoke.
- **[high/excluded-from-ci]** `.github/workflows/feed-test.yml:16` ✓verified — feed CI runs only `test:unit` (scripts/test-unit-isolated.ts), which excludes all 64 *.integration.test.ts, 5 Playwright *.e2e.test.ts, and the performance/ perf tests. The integration/e2e lane is an explicit TODO(#9943), so ~70 feed test files execute in zero CI. _Fix:_ Implement the promised integration/E2E lane (postgres+foundry+server) or delete the dead integration/e2e specs; do not leave 70 files as decorative.
- **[medium/green-but-meaningless]** `packages/feed/packages/testing/e2e/perp-market-trading.e2e.test.ts:131` — beforeAll probes /api/health; on failure sets serverAvailable=false and every test does `test.skip(!serverAvailable)`. Runs in no CI lane, and when run locally without a server the whole suite skips — passes while asserting nothing. _Fix:_ Run under a lane that boots the server (fail hard if unreachable), or convert the server-availability skip to a hard precondition failure.
- **[medium/non-running]** `packages/feed/packages/testing/e2e/external-agent-flow.e2e.test.ts:95` — 10+ `test.skip(!apiKey, 'registration did not succeed')` gates chained off an initial registration step; if registration fails all downstream assertions skip. Combined with e2e-in-no-lane, this validates nothing in CI. _Fix:_ Provision a CI apiKey/registration fixture and assert registration success as a hard gate, or drop the file.
- **[medium/excluded-from-ci]** `packages/feed/scripts/test-unit-isolated.ts:52` — `packages/engine/src/__tests__/security/no-cheating.test.ts` is hard-excluded from the unit runner (needs DB) yet is NOT under an integration/ dir nor *.integration.test.ts, so no suffix-based integration lane would pick it up either — a security test that runs nowhere. _Fix:_ Rename to *.integration.test.ts and wire the integration lane, or provide the DB in a lane that runs it.
- **[low/excluded-from-ci]** `packages/feed/scripts/test-unit-isolated.ts:56` — `packages/training/src/benchmark/__tests__/ScenarioLoader.test.ts` excluded from unit runner due to missing generated fixtures; nothing generates them in CI, so it runs in no lane (orphaned). _Fix:_ Generate the benchmark fixtures in the lane and un-exclude, or delete the test.
- **[low/non-running]** `packages/feed/packages/testing/integration/full-production-tick.test.ts:427` — `test.skipIf(!liveLlmTestConfig.enabled)` gates the production-tick assertions behind RUN_LIVE_LLM_TESTS, which no CI lane sets; also lives in integration/ so the unit lane skips the file entirely. _Fix:_ Add a live-LLM nightly lane or mark clearly as manual-only; currently invisible.
- **[low/non-running]** `packages/feed/packages/testing/integration/waitlist-service.test.ts:36` — Whole describe becomes describe.skip via `shouldSkip` env gate (same pattern in world-facts-service.test.ts:14 and parody-headline-generator.test.ts:26); no CI lane sets the enabling env, so these suites never assert. _Fix:_ Wire the required env in the integration lane, or delete the env gate and provide fixtures.
- **[low/non-running]** `packages/tui/test/autocomplete.test.ts:44` — `const describeFd = isFdInstalled ? describe : describe.skip` silently skips all fd-backed autocomplete tests when the `fd` CLI is absent; the tui test lane (`vitest run test/`) does not install fd, so this file-completion path is likely untested in CI. _Fix:_ Install `fd` in the tui CI job (fail if missing) or vendor a stub so the fd path is exercised deterministically.
- **[low/incomplete]** `packages/feed/packages/agents/src/plugins/feed/__tests__/plugin.test.ts:5` — Only asserts provider/evaluator NAMES are present in the plugin object (registration wiring); no action/provider behavior, no error/edge cases. Same shallow pattern in plugin-experience and plugin-autonomy plugin.test.ts. _Fix:_ Add behavioral tests invoking the providers/evaluator with fixture runtime state and asserting outputs, not just registration.
- **[low/excluded-from-ci]** `packages/feed/packages/testing/performance/concurrent-agents.perf.test.ts:1` — Lives in performance/ which test-unit-isolated EXCLUDED_DIRS drops; no perf lane exists in feed-test.yml, so this and game-tick-performance.test.ts never run. _Fix:_ Add a perf lane (even non-blocking) or delete if perf regressions aren't gated.

</details>

<details><summary><b>ui spatial/XR + agent-surface</b> — 13 findings</summary>

_This surface is, on the whole, genuinely well-tested — the core behavioral layers are real. packages/ui/src/spatial (engine/evaluate/escape/parity/gallery/tui-interaction/registered-view-parity/divider-label) and packages/ui/src/agent-surface (registry/integration/element-reporter) render real React trees, drive real keyboard/click/fill capabilities through the real registry, and assert on real DOM/IR/TUI output including negative and edge cases. plugin-xr's protocol/audio-pipeline/vision-pipeline/routes-e2e/xr-view-host-http tests are real unit/HTTP tests that mock only collaborators (useMode_

Top remediation targets:
- plugins/plugin-facewear/app-xr/e2e/*.spec.ts - wire into a real CI lane (view-server + playwright) or delete; today they are 100% dead coverage
- plugins/plugin-xr/src/__tests__/xr-feature-parity.test.ts - delete cross-cut meta-tests (502-521) and source-string scrapes (axis 2/3/4/8); keep only the real routeHandler + registerPluginViews dispatch tests
- plugins/plugin-facewear/app-xr/e2e/camera-pose.spec.ts - remove the two test.skip-on-missing-emulator guards so the emulator fixture is required, or the panel-follows-camera claim stays unproven
- plugins/plugin-xr/src/__tests__/xr-functional-parity.test.ts - replace source-text scraping (useState/capability strings) with real per-view render assertions using the registered-view-parity harness
- Replace vacuous-skip patterns (if(!fileExists)continue / if(!hasAppXr())return / if(!out)return) across the XR parity+framing suites with hard assertions so missing artifacts fail instead of silently passing

- **[high/excluded-from-ci]** `plugins/plugin-facewear/app-xr/e2e/all-views-crud.spec.ts:1` ✓verified — Playwright spec (webServer node e2e/view-server.mjs). plugin-facewear package.json has no test:e2e and no playwright invocation; grep of .github/workflows shows no reference to app-xr; the only runner is scripts/e2e-recordings/run-all.mjs (root test:e2e:record) which is invoked by NO CI workflow. So this real spec never runs in any lane. _Fix:_ Wire app-xr e2e into a CI job (like the xr-harness-e2e job that runs plugin-xr/simulator) or add a facewear test:e2e script invoked by test.yml; otherwise delete the specs so they stop implying coverage.
- **[high/excluded-from-ci]** `plugins/plugin-facewear/app-xr/e2e/voice-forms.spec.ts:16` ✓verified — Same orphaning as all-views-crud: not matched by facewear vitest include (src/**), no playwright script in package.json, no workflow runs it. Its assertions (xr:transcript fills focused input, focus-next, toast) never execute in CI. _Fix:_ Add a CI lane that boots view-server.mjs and runs plugins/plugin-facewear/app-xr/playwright.config.ts, or remove.
- **[high/non-running]** `plugins/plugin-facewear/app-xr/e2e/camera-pose.spec.ts:32` ✓verified — Both tests self-skip: test 1 does if(!connected) test.skip(...) when window.__xrEmulator is absent, test 2 asserts only typeof setPose then test.skip when not injected. With no emulator fixture wired the whole spec passes while asserting nothing about camera-space panel positioning, and the spec is also excluded from CI entirely. _Fix:_ Provide the emulator fixture in a real lane and remove the skip-on-missing guards so absence fails; otherwise the 'panels follow camera' claim is unverified.
- **[high/green-but-meaningless]** `plugins/plugin-xr/src/__tests__/xr-feature-parity.test.ts:502` ✓verified — Meta-larp: cross-cut tests (502-521) assert that OTHER spec files (app-xr/e2e/all-views-crud.spec.ts, voice-forms.spec.ts, camera-pose.spec.ts) merely EXIST and their text .includes('xr:transcript')/'setPose'/'/api/xr/views'. It tests that an un-run, excluded-from-CI test file contains a string, proving nothing about behavior. _Fix:_ Delete the cross-cut string-scrape tests; replace with actually running those specs in CI, or with a behavioral assertion on the view-host route.
- **[medium/green-but-meaningless]** `plugins/plugin-xr/src/__tests__/xr-feature-parity.test.ts:214` ✓verified — axis 2 'xrViewsRoute is registered as GET /xr/views' asserts the source file text .includes('"GET"'), '"/xr/views"', 'count' - a string scrape that passes even if the route is broken. axis 8 (486-498) similarly scrapes xr-connect/xr-status source for 'qr'/'code'/'/xr/'. Redundant with real dispatch tests elsewhere in the file but themselves meaningless. _Fix:_ Drop the source-string asserts; the real registerPluginViews+routeHandler dispatch test (axis 2 at 224) already proves the behavior.
- **[medium/incomplete]** `plugins/plugin-xr/src/__tests__/xr-feature-parity.test.ts:370` ✓verified — axis 4/6/7/8 and cross-cut tests early-exit with if(!hasAppXr()) return; (lines 371,380,388,422,433,449,457,470,481,503,510,517) - if plugins/plugin-facewear/app-xr/package.json is missing, ~11 tests become silent no-ops that still report green rather than failing on missing coverage. _Fix:_ Replace if(!hasAppXr()) return; with an explicit assertion that app-xr exists, so removal of the client fails CI instead of silently disabling the axis.
- **[medium/green-but-meaningless]** `plugins/plugin-xr/src/__tests__/xr-functional-parity.test.ts:391` — 'functional parity' is validated by scraping component source text: test B asserts the .tsx source .includes('useState')/component name/required term strings; test D asserts capability strings appear in *.interact.ts source. These pass if the identifier appears anywhere in the file regardless of whether the component actually renders or the capability works. Text presence, not behavior. _Fix:_ Convert to real render assertions (the registered-view-parity.test.tsx pattern already renders each view on IR/TUI/DOM - fold these plugins into that instead of grepping source).
- **[low/green-but-meaningless]** `plugins/plugin-xr/src/__tests__/xr-functional-parity.test.ts:440` — test C 'built bundle exports componentExport' does if(!fileExists(bundlePath)) continue; - when dist/views/bundle.js is absent the assertion silently vanishes and the test passes. Only real in the CI plugin-tests job (which runs build:views first); a local bun run --cwd plugins/plugin-xr test with no prior build passes vacuously. _Fix:_ Assert bundles exist (as xr-bundle-coverage.test.ts:196 already does) rather than continue, or make the plugin test script build views first.
- **[low/incomplete]** `plugins/plugin-xr/src/__tests__/xr-bundle-coverage.test.ts:181` — Every check is a build-artifact heuristic on source/dist text: bundle exists, size >1KB / >5KB, first char not '<' or '{', bundle string .includes(exportName), manifest regex bundlePath=='dist/views/bundle.js'. Proves a file was written and contains an identifier substring, not that the view mounts or the export is a valid React component. Real as a build gate but not functional coverage. _Fix:_ Keep as a cheap build gate but pair with an actual import()+render smoke of one bundle so a syntactically-valid-but-broken component is caught.
- **[low/green-but-meaningless]** `plugins/plugin-xr/src/__tests__/xr-feature-parity.test.ts:283` ✓verified — axis 3 'plugin-xr exports all 5 agent view actions' asserts xr-view-actions.ts source .includes('XR_OPEN_VIEW') etc., plus .not.toContain('runtime.plugins')/'plugin.views' negative scrapes. String presence, not that the actions are exported/registered/functional (the real handler test at 298 already covers open/list). _Fix:_ Remove the includes/not-includes source scrapes; assert on the imported action objects' .name and that index.ts registers them.
- **[low/non-running]** `packages/ui/src/spatial/__tests__/plugin-framing.test.ts:52` — Test 'exports all real views for visual review (TUI_REVIEW_OUT)' does const out = process.env.TUI_REVIEW_OUT; if(!out) return; - TUI_REVIEW_OUT is never set in CI so the body always returns before any expect(). It is a report-writer helper masquerading as a test case; contributes a green tick with zero assertions. _Fix:_ Move the review-dump behind a script (not an it()), or gate with it.skipIf so it reports skipped rather than passed.
- **[low/incomplete]** `packages/ui/src/agent-surface/__tests__/agentsurface-stories-smoke.test.tsx:5` — 5-line file: smokeStoryModules('agentsurface', modules, {minModules:1}) only renders each *.stories.tsx and requires >=1 module - a no-throw smoke with a trivial floor. No assertion on rendered content/roles; a story that renders an empty div passes. _Fix:_ Acceptable as a thin story-gate smoke, but the real coverage is integration.test.tsx; consider raising minModules to the actual story count so a dropped story is caught.
- **[low/incomplete]** `plugins/plugin-xr/src/__tests__/xr-view-host-http.test.ts:31` — Labeled 'Full HTTP integration' but the beforeAll hand-rolls its own createServer that manually regex-matches the URL and calls xrViewHostRoute.routeHandler directly - it does NOT go through the production dispatcher. Re-asserts the same HTML strings already covered by xr-view-host.test.ts (direct) and routes-e2e.test.ts (real buildHonoAppForRuntime dispatch), so it adds TCP-serialization coverage but overstates 'integration'. _Fix:_ Fold into routes-e2e.test.ts (which uses the real Hono dispatcher) to remove the hand-rolled router and the duplicated HTML assertions.

</details>

<details><summary><b>agent runtime+api</b> — 8 findings</summary>

_packages/agent is, on balance, one of the better-tested surfaces in the repo: the route/runtime/media/plugin-lifecycle suites boot real runtimes, spin up real HTTP servers, spawn the real TUI binary, and exercise real content-addressed media storage with genuine collaborator mocks (mock DB adapter, mock capability router) rather than mocking the unit under test. Larp density is LOW. The real problems are (1) a self-referential LLM-planner test that asserts against a mock planner defined inside the test file, verifying nothing about production behavior; and (2) a cluster of high-value integrati_

Top remediation targets:
- packages/agent/src/__tests__/plugin-view-llm-mock-coverage.test.ts:156 — replace the self-referential mockLlmViewPlanner assertion with real planner/dispatch execution
- packages/agent/src/runtime/trajectory-capture.real.test.ts — wire a real-DB lane so the PGLite SQL round-trip actually runs, and strengthen the mock trajectory-bridge.test.ts execute() assertion
- packages/agent/src/services/remote-plugin-adapter.test.ts:305,313 — enable ELIZA_REMOTE_PLUGIN_BUILD_SMOKE (and docker smoke where feasible) in CI so real remote-plugin source build + cross-process load is gated
- packages/agent/src/__tests__/view-llm-eval.test.ts — fix the false 'config-excluded' comment and add a deterministic mock-judge smoke or a post-merge keyed lane
- packages/agent/src/providers/media-provider.real.test.ts — add recorded-fixture provider cases so request/response shaping runs in PR CI instead of only under REAL_API_TEST

- **[high/larp]** `packages/agent/src/__tests__/plugin-view-llm-mock-coverage.test.ts:156` ✓verified — The 'routes every mock journey through the deterministic planner contract' test calls mockLlmViewPlanner() defined at lines 76-104 in the SAME file, then asserts it returns the expected case. Input (journey.userMessage) and expected both derive from PLUGIN_VIEW_LLM_MOCK_CASES, so it is tautological and exercises a mock planner that is not the production view-planning code path. _Fix:_ Delete this sub-test or replace it by driving the real view-planner/dispatch (registerPluginViews + the actual planner used by views-routes) so the assertion validates production routing, not a test-local string matcher.
- **[high/excluded-from-ci]** `packages/agent/src/runtime/trajectory-capture.real.test.ts:1` ✓verified — Real PGLite end-to-end trajectory-capture round-trip (the bug this file documents: LLM calls captured only in-memory, viewer reads SQL). Named *.real.test.ts so it is hard-excluded by vitest.config exclude in ALL lanes, and its own header admits it 'skips under bun isolated-install'. It never runs anywhere; only the mock-adapter trajectory-bridge.test.ts runs. _Fix:_ Wire a real-DB lane that actually executes *.real.test.ts (or convert this to a non-.real integration test that runs the PGLite path in CI), so the SQL persistence round-trip is verified rather than only the mock.
- **[medium/excluded-from-ci]** `packages/agent/src/__tests__/view-llm-eval.test.ts:409` — Entire LLM-judge view-eval suite is describe.skipIf(!hasAnyCredential); PR lane has no CEREBRAS/ANTHROPIC key so all 17 its skip => 0 tests run. Header comment (lines 17-19) falsely claims the file is excluded by the config's *.live/*.real patterns, but it is named view-llm-eval.test.ts and IS matched by the include glob; it just silently skips. _Fix:_ Fix the misleading comment, and either move these to a post-merge lane that provisions a judge key or add a deterministic mock-judge smoke variant so the eval harness itself is exercised in PR CI.
- **[medium/excluded-from-ci]** `packages/agent/src/providers/media-provider.real.test.ts:29` — Real vision/image-gen API tests, doubly gated: hard-excluded by *.real.test.ts config glob in every lane AND wrapped in describeIf(REAL_API_TEST==='1'). No PR or default lane ever runs them; the sibling media-provider.test.ts is the only coverage. _Fix:_ Move to an explicit post-merge live lane with keys, or add recorded-fixture (nock/undici mock) cases so provider request/response shaping is verified deterministically in CI.
- **[medium/excluded-from-ci]** `packages/agent/src/services/remote-plugin-adapter.test.ts:313` — esbuildSmoke (build-a-remote-plugin-from-source + load-built-plugin-in-separate-process) and dockerSmoke (line 305) are it.skip unless ELIZA_REMOTE_PLUGIN_BUILD_SMOKE / ELIZA_REMOTE_CAPABILITY_DOCKER_SMOKE=1. The default test lane never sets them, so the most meaningful remote-plugin integration (real source build + cross-process load) is skipped; only manifest-materialization against mock routers runs in CI. _Fix:_ Set ELIZA_REMOTE_PLUGIN_BUILD_SMOKE=1 in the standard agent CI (esbuild is available on Linux runners) or add these files to a source-build lane in run-all-tests.mjs so the build path is actually gated.
- **[low/excluded-from-ci]** `packages/agent/test/tui-e2e/tui-pty.test.ts:41` — describe.skipIf(!runReal) with runReal=RUN_TUI_PTY==='1'. The real-PTY TUI e2e only runs via the dedicated test:tui-pty script; the default lane skips it. The in-process VirtualTerminal harness (agent-tui-shell.test.ts) and real-binary smoke (tui-smoke-binary.test.ts) do run, so coverage is not zero. _Fix:_ Add RUN_TUI_PTY=1 to a CI job (or fold test:tui-pty into run-all-tests) so the real PTY path is exercised at least post-merge; otherwise document the gate as intentional.
- **[low/excluded-from-ci]** `packages/agent/src/services/remote-capability-cloud-sandbox.cloud-smoke.test.ts:26` — cloudLive selector = it.skip unless ELIZA_REMOTE_CAPABILITY_CLOUD_LIVE=1 AND ELIZAOS_CLOUD_API_KEY set. No PR lane provides these, so the single cloud-sandbox provisioning test never executes. Same pattern in remote-capability-url-endpoint-providers.provider-smoke.test.ts:80 (PROVIDER_LIVE). _Fix:_ Acceptable as a live-only smoke, but move to an explicit post-merge/live lane in the test lane matrix and confirm the non-live remote-capability router/endpoint tests (which DO run) cover the deterministic contract.
- **[low/incomplete]** `packages/agent/src/runtime/trajectory-bridge.test.ts:81` — The SQL-persistence assertion is only expect(execute).toHaveBeenCalled() with no check of the emitted SQL/params or that trajectory_steps received the right row. Given this is the ONLY trajectory-persistence test that runs in CI (the real round-trip is excluded), a call-count-only assertion under-verifies the exact bug it guards. _Fix:_ Assert on the execute() arguments (table/columns/values for trajectory_steps) so the test fails if the bridge writes malformed or wrong-table SQL, not merely that some execute happened.

</details>

<details><summary><b>core</b> — 4 findings</summary>

_packages/core is, by the standards of this audit, well-tested. Across ~200 test files I read a representative cross-section (actions, providers, policy resolvers, lint/audit guards, planner loop, provisioning, document search, sub-agent credentials) and found essentially no larp: tests exercise the real unit under test, mock only collaborators (runtime, services, adapters), and assert real behavior including error/edge/branch cases (e.g. reply.test.ts asserts planner fallback text + callback payload; generateMedia.test.ts covers missing-URL and availability branches; description-compressed-lin_

Top remediation targets:
- packages/core/e2e/runtime-live.e2e.spec.ts — make it fail-loud instead of registering zero tests when env unset, and wire an actual test:e2e lane
- The three *.live.test.ts files — establish a scheduled/post-merge live workflow that sets ELIZA_RUN_LIVE_TESTS=1, or port their deterministic assertions to recorded-fixture PR-lane tests so the logic is actually guarded
- No further larp remediation needed for the deterministic core suite — it is genuinely strong; effort is better spent elsewhere in the repo

- **[medium/non-running]** `packages/core/e2e/runtime-live.e2e.spec.ts:16` — Entire suite body is wrapped in `if (isPlaywrightE2E)` where isPlaywrightE2E = ELIZA_PLAYWRIGHT_E2E==='1'; no workflow sets that env, and vitest excludes e2e/**. When unset the file registers ZERO tests and passes vacuously — real chat/health/error e2e coverage never runs. _Fix:_ Wire a CI lane (test:e2e) that sets ELIZA_PLAYWRIGHT_E2E=1 with a provider or Ollama, or delete the dead conditional wrapper. A file that registers zero tests must fail loudly, not pass empty.
- **[medium/excluded-from-ci]** `packages/core/src/runtime/__tests__/field-registry-cerebras.live.test.ts:41` — *.live.test.* is statically excluded by vitest.config.ts exclude[] (not env-conditional, so no post-merge lane re-includes it) AND gated by describe.skip unless ELIZA_RUN_LIVE_TESTS=1 && CEREBRAS_API_KEY. grep of .github/workflows shows nothing sets ELIZA_RUN_LIVE_TESTS — this 405-line field-registry regression never executes in any lane. _Fix:_ Add a scheduled/post-merge workflow that sets ELIZA_RUN_LIVE_TESTS=1 + the provider key and runs live tests, or convert the deterministic parts to a recorded-fixture test (like planner-loop-cerebras-recorded.test.ts) that runs in the PR lane.
- **[medium/excluded-from-ci]** `packages/core/src/__tests__/should-respond.live.test.ts:13` — describe.skip unless ELIZA_RUN_LIVE_TESTS=1 (Ollama-backed), and *.live.test.* is unconditionally excluded by vitest.config.ts. No workflow sets ELIZA_RUN_LIVE_TESTS, so this should-respond classifier coverage runs nowhere in CI. _Fix:_ Route through a live post-merge lane with Ollama, or extract a recorded/mock-model variant of the classifier assertions into a *.test.ts that runs in the PR lane so the logic is guarded.
- **[low/excluded-from-ci]** `packages/core/src/__tests__/read-attachment-action.live.test.ts:1` — *.live.test.* — statically excluded by vitest.config.ts and requires live provider env that no workflow provides; never executed in any lane. _Fix:_ Either add it to a live post-merge workflow or downgrade the deterministic portions to a mocked-collaborator *.test.ts in the PR lane.

</details>

<details><summary><b>ui components + story-gate</b> — 6 findings</summary>

_This is one of the stronger-tested surfaces in the repo, not a larp field. The ~186 co-located component *.test.tsx files I sampled use real @testing-library render + user-event, drive DOM, and assert behavior — including exemplary adversarial coverage (ElizaOsAppsView.permission-gate.test.ts covers throwing checks, denied-after-request, no-request-capability) and genuine regression locks (chat-transcript.render-count.test.tsx counts per-row renders via the real renderMessageContent prop). No it.only/describe.only, no orphaned .skip, no .spec files hiding in components, no test that mocks its _

Top remediation targets:
- Wire the browser story gate (run-story-gate.mjs blank/broken detection) into the standard test lane or make ui-story-gate.yml a required check — it is the only layer that actually fails on blank renders and it is outside run-all-tests.mjs
- Strengthen portable-stories smoke to assert non-empty DOM for non-skip-listed stories so the 31 jsdom smoke files stop passing on empty renders
- Un-skip AppsView/AppDetailsView/ContinuousChatOverlay stories by supplying a mock AppProvider graph so the busiest views get PR-lane render coverage
- Ratchet down the 447-entry a11y baseline instead of leaving the catalog grandfathered

- **[medium/green-but-meaningless]** `packages/ui/test/portable-stories.tsx:111` — smokeStoryModules' per-story test asserts ONLY that render() does not throw; comment explicitly states there is intentionally no produced-DOM assertion and null/empty renders are valid. ~31 stories-smoke files (chat, pages, shell, settings, apps, ...) inherit this, so a story that mounts to nothing passes in the jsdom PR lane. _Fix:_ Add a minimal non-empty-DOM assertion for stories not on the skip list (e.g. expect(container.childElementCount).toBeGreaterThan(0)) OR make clear these are smoke-only and depend on the browser gate for blank detection; do not treat the jsdom smoke as the story coverage of record.
- **[medium/excluded-from-ci]** `packages/ui/test/story-gate/run-story-gate.mjs:1` — The strong story gate (sharp-based blank/one-color detection, broken-verdict hard-fail) is only invoked by the separate path-triggered .github/workflows/ui-story-gate.yml, not by run-all-tests.mjs / the vitest default `test` lane. The everyday `bun run test`/test:ui lane runs only the weak jsdom smoke, so if the story-gate workflow is skipped or its storybook-static build fails, blank-render coverage silently disappears. _Fix:_ Ensure ui-story-gate.yml is a required check on packages/ui changes, or wire the gate (or a jsdom blank-render assertion) into the standard test lane so blank detection cannot be bypassed.
- **[medium/non-running]** `packages/ui/src/components/pages/__tests__/pages-stories-smoke.test.tsx:14` — AppsView (Default/WalletEnabled/WithFavoritesAndRecents/GamesSubTab) and AppDetailsView (Default/WithActiveRuns/PluginViewer) — the highest-traffic app-catalog views — are it.skip'd in the jsdom smoke, so these views get ZERO fast-lane render coverage and rely entirely on the separately-triggered browser gate + live audit:app. _Fix:_ Provide a mock AppProvider/useAppSelectorShallow graph in the smoke wrap() so these stories mount in jsdom instead of being skipped, giving them PR-lane render coverage.
- **[low/non-running]** `packages/ui/src/components/shell/__tests__/shell-stories-smoke.test.tsx:14` — Seven ContinuousChatOverlay stories (Ambient/PromptSuggestions/Listening/Responding/Booting/SlashCommands) and StartupScreen/Pairing are it.skip'd in the jsdom smoke as needs-runtime; documented as covered by browser gate + chat-sheet __e2e__ but no PR-lane jsdom coverage. _Fix:_ Confirm each skipped story is actually exercised by the chat-sheet/home-screen __e2e__ runners; otherwise supply the transcript-sink/pairing-input mock so they run in the jsdom smoke.
- **[low/incomplete]** `packages/ui/test/story-gate/baseline/a11y-baseline.json:1` — 447 baselined a11y violations (button-name, color-contrast across most stories) are accepted, so the a11y portion of the gate only catches net-new violations — the existing catalog is effectively grandfathered as non-accessible. _Fix:_ Treat as burn-down debt: track a decreasing ratchet on baseline size so the count cannot grow, and file issues to eliminate button-name/color-contrast entries rather than leaving them permanently accepted.
- **[low/green-but-meaningless]** `packages/ui/test/story-gate/run-story-gate.mjs:258` — The console-error normalizer globally drops any message matching /^Error rendering story '...':/ (Storybook's generic wrapper) in addition to the useAppSelector-before-AppProvider message. A genuine console error emitted alongside a story-render wrapper could be swallowed, though the broken verdict still catches the DOM error display. _Fix:_ Narrow the drop to only the paired useAppSelector wrapper (match both lines together) rather than dropping every 'Error rendering story' wrapper regardless of the underlying cause.

</details>

<details><summary><b>native device plugins</b> — 5 findings</summary>

_This surface is, on the whole, strongly tested — one of the better-covered areas I have seen. The 21 `plugin-native-*/src/web.test.ts` suites test the REAL web-fallback units (CameraWeb, MobileSignalsWeb, NetworkPolicyWeb, ElizaTasksWeb, SystemWeb, etc.), mock only the browser collaborator (navigator/document/MediaDevices), and include genuine adversarial/edge cases (prototype-pollution `__proto__` targets, NaN/Infinity schedule options, clamped battery level 1.5→1, rejected battery API → null, hostile navigator shapes). plugin-local-inference has deep unit coverage (context-fit, gpu-autotune _

Top remediation targets:
- plugins/plugin-native-calendar/src/swift-bridge-contract.test.ts — convert source-grep to behavioral/device test or move to lint
- Native Swift/Kotlin/JNI implementations broadly — add device/nightly behavioral coverage (only web fallbacks are tested in JS lanes today)
- plugins/plugin-native-settings/src/components/DeviceSettingsVisualCopy.test.ts — render-and-assert instead of source not.toContain
- voice-live-e2e.yml real-FFI lane — enforce require-real (fail when models absent) so model-gated skips can't green-pass on boolean-only asserts
- plugins/plugin-local-inference/src/services/voice/__tests__/streaming-asr.test.ts:443 — delete the skipIf(true) empty placeholder

- **[medium/green-but-meaningless]** `plugins/plugin-native-calendar/src/swift-bridge-contract.test.ts:14` — readFileSync(CalendarPlugin.swift) + 15 expect(swiftSource).toContain('...literal...') — asserts the Swift source contains validation strings, never executes the bridge. Any refactor of the Swift breaks it; it proves nothing about runtime EventKit behavior and masquerades as a 'bridge contract' test. _Fix:_ Replace with a behavioral test of the Swift bridge on a macOS device/CI lane (or a JS-side contract test against the compiled/proxied interface). If kept as a guard, downgrade to a lint/grep rule out of the vitest lane so it isn't counted as behavioral coverage.
- **[low/green-but-meaningless]** `plugins/plugin-native-settings/src/components/DeviceSettingsVisualCopy.test.ts:13` — readFileSync(DeviceSettingsAppView.tsx) then expect(source).not.toContain('<p className=') / not.toContain('deviceSettings.subtitle') — a lint-rule masquerading as a test; it never renders the component and only checks absence of source substrings, so it green-passes regardless of actual rendered visual copy. _Fix:_ Render DeviceSettingsAppView (jsdom + testing-library, as the sibling device-settings-contract.test.ts already does) and assert on the rendered DOM (no paragraph helper copy present), or move this to a Biome/lint rule and drop from the test lane.
- **[low/non-running]** `plugins/plugin-local-inference/src/services/voice/__tests__/streaming-asr.test.ts:443` — it.skipIf(true)('SKIP — real Gemma ASR model...') with an empty body — a permanently-skipped placeholder with zero assertions. It is documented but adds a fake test entry that never runs and never asserts. _Fix:_ Delete the placeholder (the real-model path is already covered by asr-timed.real.test.ts in the nightly lane), or convert it into a real gated test keyed on an ELIZA_ASR_BUNDLE env like asr-timed.real.test.ts instead of skipIf(true).
- **[low/excluded-from-ci]** `plugins/plugin-local-inference/src/services/voice/speaker/diarizer-fused.real.test.ts:73` — *.real.test.ts is excluded from the default/PR vitest lane (vitest.config.ts drops **/*.real.test.ts unless TEST_LANE=post-merge). Its meaningful diarizeWindow assertion is additionally it.skipIf(!HAVE_MODEL) on ELIZA_TEST_DIARIZ_GGUF, so in any lane without the staged GGUF only the trivial `typeof isSupported === 'boolean'` runs. _Fix:_ Already wired into nightly voice-live-e2e.yml which stages ELIZA_TEST_DIARIZ_GGUF — acceptable. To harden, make voice-live-e2e run in require-real mode (fail if HAVE_MODEL is false) so a silent model-staging failure cannot green-pass on the boolean-only assertion.
- **[low/larp]** `plugins/plugin-local-inference/src/services/voice/ffi-bindings.test.ts:314` — The 'native VAD fake path' / 'ttsStreamSupported can be toggled off' cases assert fakeFfi(...) returns the scripted probabilities/flags they were configured with — testing the test double's own scripted behavior rather than production code. Mildly tautological (validates the mock contract, not the unit). _Fix:_ Keep only the fakeFfi cases that feed a real unit (bridge/transcriber) through the double; drop the ones that only assert the double echoes its own config, or move them into the fake-ffi helper's own self-test clearly labeled as such.

</details>

<details><summary><b>model + connector plugins</b> — 8 findings</summary>

_This surface is genuinely well-tested and largely free of true larp. The deterministic PR-lane tests I opened (openai/xai native-plumbing.shape, discord message-coalesce, whatsapp webhook-auth, groq native-plumbing.shape) mock only external collaborators (the `ai` SDK, `fetch`, discord.js objects) and assert real product behavior — message/tool normalization, usage mapping, cache-key stripping, SSE buffering, HMAC verification, debounce timing — with adversarial/hostile-input and edge cases. I found ZERO tests that mock the unit under test itself or assert only `toHaveBeenCalled`. The real pro_

Top remediation targets:
- Wire per-plugin *.harness.test.ts into a CI lane (7 files: discord connector-loop + 6 keyless-harness) — biggest real-coverage gap since these are the only end-to-end plugin tests and currently run in zero lanes
- Add deterministic (mocked-SDK) counterparts for the live-only suites that collapse to it.skip in PR lane: groq model-usage token mapping, google-genai trajectory wrapping
- Add a mocked twitter-api-v2 suite for plugin-x so ClientBase/PostService/MessageService get PR-lane coverage instead of an all-skipped e2e
- Confirm the *.live.test.ts files (openai/anthropic/openrouter/ollama/google-genai/xai) are actually executed by a nightly external-api workflow and not silently orphaned

- **[high/excluded-from-ci]** `plugins/plugin-discord/__tests__/connector-loop.harness.test.ts:1` ✓verified — The plugin's highest-fidelity e2e (real MessageManager.handleMessage, inbound guards, buildMemoryFromMessage, outbound channel.send seam under mock-LLM runtime) is a *.harness.test.ts, excluded by vitest.config.ts (exclude: **/*.harness.test.ts) and only runnable via test:harness, which run-all-tests.mjs never invokes and no workflow calls. _Fix:_ Add test:harness to run-all-tests EXTRA_SCRIPT_NAMES (or a turbo/CI lane) so per-plugin harness suites run in post-merge at minimum; or rename to a glob the default lane runs if PGLite aliases can be provided.
- **[high/excluded-from-ci]** `plugins/plugin-openai/__tests__/keyless-harness.harness.test.ts:1` ✓verified — Loads the REAL openaiPlugin under withMockLlmRuntime to prove keyless dispatch; never runs in CI because test:harness is not in EXTRA_SCRIPT_NAMES and keyless-harness-e2e.yml only runs test/mocks/__tests__/ (a different set). Same for the anthropic/groq/openrouter/telegram/google-genai keyless-harness copies (6 more). _Fix:_ Wire the per-plugin *.harness.test.ts suites into a CI lane (test:harness via run-all-tests or the keyless-harness-e2e workflow include glob).
- **[medium/non-running]** `plugins/plugin-groq/__tests__/model-usage.test.ts:29` — File is named plain .test.ts (matched by the default `test` glob) but self-skips to a single it.skip when GROQ_API_KEY is absent — the entire suite is a no-op in the PR lane. CLAUDE.md lists it as 'Token usage normalisation tests' but token-usage is only asserted live. _Fix:_ Keep the live assertion but add a deterministic sibling (mock the Groq fetch/SDK and assert estimateUsage fallback + MODEL_USED token mapping); native-plumbing.shape.test.ts already proves this is feasible.
- **[medium/non-running]** `plugins/plugin-google-genai/__tests__/trajectory.test.ts:44` — Only trajectory-wrapping test for the plugin; gated on GOOGLE_GENERATIVE_AI_API_KEY and collapses to it.skip in PR lane, so recordLlmCall/actionType/token plumbing has zero deterministic coverage. No mocked counterpart exists. _Fix:_ Add a deterministic test with a stubbed Google SDK client that asserts runWithTrajectoryContext captures stepId/actionType and non-zero tokens, mirroring the live assertions.
- **[medium/non-running]** `plugins/plugin-x/src/__tests__/e2e/twitter-integration.test.ts:28` — describe.skipIf(SKIP_E2E) with no TWITTER_* creds → entire 300+ line suite skipped in every automated lane; assertions are also weak (mostly .toBeDefined()). Provides no CI coverage of ClientBase/PostService/MessageService against real or mocked API. _Fix:_ Split: keep the live suite for nightly, and add a deterministic suite mocking twitter-api-v2 that exercises the same ClientBase/service methods with strong shape assertions.
- **[low/excluded-from-ci]** `plugins/plugin-openai/__tests__/openai.live.test.ts:1` — *.live.test.ts is excluded by the package `test` glob (vitest.config.ts exclude **/*.live.test.ts) and there is no test:live script for plugin-openai, so it runs in no run-all-tests lane. Same pattern for anthropic/openrouter/ollama/google-genai/xai live files (7 total). _Fix:_ Acceptable if a dedicated nightly workflow runs them; otherwise document/wire a live lane. Confirm each live file is actually executed by external-api-live workflows and not orphaned.
- **[low/incomplete]** `plugins/plugin-x/src/services/PostService.test.ts:22` — Only two happy-path delegation assertions (unlikePost→unlikeTweet, unrepost→unretweet) against a hand-rolled twitterClient mock; no error propagation, no createPost/getPosts/getMentions coverage. Real but thin for a service file. _Fix:_ Add error-path (client throws) and cover the primary create/get methods, or fold into a broader PostService suite.
- **[low/incomplete]** `plugins/plugin-imessage/__tests__/integration.test.ts:42` — Opening 'plugin exports' block is trivial existence smoke (expect(X).toBeDefined() / metadata shape). Low value, though the remaining ~900 lines are real parsing/utility behavior tests, so the file overall is fine. _Fix:_ Trim the export-existence block or replace with a single manifest-shape assertion; keep the substantive parsing tests.

</details>

<details><summary><b>ui shell+gestures</b> — 5 findings</summary>

_This surface is, at the unit level, one of the better-tested areas I have audited — very little larp. The pure-function gesture resolvers (resolvePull/resolveSwipe) and the usePullGesture rAF-coalescing hook are covered by real behavioral tests with meaningful assertions (toHaveBeenCalledWith exact offsets, axis-lock, pointercancel, stray-pointer-id, per-frame collapse), including adversarial/edge cases. The shell stores (shell-surface-store, shell-state) test real invariants (page clamping, edit-reset-on-leave, count-shrink re-clamp) not mocks. useShellController/useChatSend/useBarSurfaceWind_

Top remediation targets:
- Wire packages/ui __e2e__ gesture/chat-sheet/home-screen/chat-ambient .mjs runners into a CI workflow (or rename to test:e2e) so the behavioral layer jsdom can't reach actually runs
- Fix vitest.e2e.config.ts empty include (0 matching files) — either author __e2e__/*.test.tsx specs or point the lane at the runners so the e2e green is real
- Add a direct useHorizontalPager unit test covering flick-velocity, edge-resistance, rAF coalescing, and onEdgeSwipeRight (mirror use-pull-gesture.test.ts)

- **[high/excluded-from-ci]** `packages/ui/src/components/shell/__e2e__/run-chatux-gesture-e2e.mjs:1` ✓verified — The gesture drag-detent e2e runner is invoked only by the bespoke package script test:chatux-gesture-e2e, which no .github/workflow and no run-all-tests lane calls (run-all-tests only recognizes test/test:integration/test:e2e/test:playwright/test:ui/test:live). The behavioral gesture coverage the ui README calls the layer 'no jsdom can reach' never runs in CI. _Fix:_ Rename the script to test:e2e (so run-all-tests picks it up) or add a dedicated workflow job that runs the ui test:*-e2e runners on packages/ui changes; alternatively convert the fixtures into src/**/__e2e__/*.test.tsx so the existing test:slow lane actually matches them.
- **[high/excluded-from-ci]** `packages/ui/vitest.e2e.config.ts:12` ✓verified — The ui test:e2e→test:slow lane has include ['src/**/__e2e__/**/*.test.{ts,tsx}'] but __e2e__ contains only .mjs runners and .tsx fixtures (zero *.test.tsx). The lane therefore runs 0 files and passes trivially, giving a false 'e2e green' while the real chat-sheet/home-screen/gesture flows go unverified. _Fix:_ Either author actual __e2e__/*.test.tsx vitest specs, or wire the .mjs runners into CI; do not leave a green-but-empty e2e lane.
- **[medium/excluded-from-ci]** `packages/ui/src/components/shell/__e2e__/run-chat-sheet-e2e.mjs:1` — Chat-sheet pull-detent e2e (real Chromium layout/pointer, the class of behavior jsdom cannot cover) is orphaned: only test:chat-sheet-e2e invokes it and nothing invokes that script in CI. _Fix:_ Wire test:chat-sheet-e2e into a CI workflow gated on packages/ui, or fold it into the recognized test:e2e lane.
- **[medium/excluded-from-ci]** `packages/ui/src/components/shell/__e2e__/run-home-screen-e2e.mjs:1` — Home-screen e2e runner is CI-orphaned (only test:home-screen-e2e calls it; no workflow/lane calls that script). Same pattern as run-chat-ambient-e2e.mjs. _Fix:_ Add these runners to a packages/ui e2e CI job or rename to test:e2e so run-all-tests executes them.
- **[medium/incomplete]** `packages/ui/src/hooks/useHorizontalPager.ts:212` — The pager's flick-velocity branch (velocity>=FLICK_VELOCITY + axis-dominance), edge-resistance visual offset (visualDragOffset), rAF offset coalescing (scheduleOffset/flushOffset), and edge-swipe-right callback have no direct unit test. HomeLauncherSurface.test.tsx only exercises the distance-threshold path (jsdom clientWidth=0→1024 fallback, no perf-timed flick, transform never asserted). Unlike the sibling use-pull-gesture, there is no dedicated pure-function/rAF test. _Fix:_ Extract the pure decision (shouldAdvance/edge-swipe/axis-commit + visualDragOffset) like resolvePull/resolveSwipe and add a useHorizontalPager.test.ts covering the velocity flick, edge-resistance, rAF collapse, and onEdgeSwipeRight branches with stubbed requestAnimationFrame/performance.now.

</details>


---

## 5. CI de-larp gate (shipped)

`packages/scripts/test-larp-gate.mjs` (wired into `bun run verify` as
`audit:test-larp-gate`) enforces two invariants over all 3,962 first-party test
files, AST-based so a marker inside a string/comment is never miscounted:

1. **Zero `.only`** — hard fail, no baseline (the tree is at 0 and stays there).
2. **No new untracked skip** — every `it.skip`/`.todo`/`xit`/`xdescribe`/`skipIf`
   must carry a `#<issue>` ref or a `larp-gate-allow: <reason>` tag on the skip
   line or the line above. The 238 existing untracked-skip sites are grandfathered
   in `test-larp-gate-baseline.json`; the baseline ratchets **down only**.

Self-test: 11/11 classifier cases. Verified to fail a synthetic new `.only` +
untracked skip and pass the current tree.

**Residual (documented, not yet gated):** "every test file is claimed by exactly
one CI lane." This requires resolving each package's vitest include-globs and is
deferred to a follow-up; the 116-file real-exclusion (§2b) is the concrete
instance of the gap.

---

## 6. Confirmed live bug surfaced by the audit — send/voice/new-chat race (#10700)

Verified in source, not hypothetical:
- Shell `send()` (`useShellController.ts:598`) enqueues **without** a
  `conversationId` — both the text path (`:622` `sendChatText(trimmed)`) and the
  voice converse path (`:693` `send(turn, { channelType: "VOICE_DM" })`).
- `sendChatText` enqueues `conversationId: options?.conversationId` (undefined for
  the shell path) — `useChatSend.ts:1316`.
- At **drain** time, `runQueuedChatSend` binds the target late:
  `convId = turn.conversationId ?? activeConversationIdRef.current ?? ""`
  (`useChatSend.ts:826`). A `clearConversation()` (new chat) between enqueue and
  drain flips `activeConversationIdRef.current`, so the queued turn is delivered
  to the **new** conversation.
- The composer path `handleChatSend` is **not** exposed: it snapshots
  `conversationId: activeConversationIdRef.current` at enqueue (`:1357`).

Fix (per #10700): make the shell `send()` path deterministic by snapshotting the
target conversation at enqueue, mirroring `handleChatSend`. Pinned by a real
component-level fuzz harness that renders the **real** `useShellController` +
`useChatSend` queue (network mocked only at the client boundary) — see Phase 3.

---

## 7. Remediation plan (tracked)

1. **[shipped]** CI gate (§5).
2. Send/voice/new-chat real-queue fuzz harness + race fix (#10700, §6).
3. De-larp the named interaction tests (#10722): upgrade synthetic-`PointerEvent`
   runners to CDP touch; replace `view-capability-audit` grep with a render-based
   per-element gate; drive `emulator.setHandPose()`; land the real immersive-WebGL
   readback test or delete the "validated end-to-end" claim.
4. `packages/feed` conditional-skip suites (§2a): run against an ephemeral
   dep or delete.
5. 116 PR-excluded real tests (§2b): split PR-safe/live or add a blocking
   post-merge lane.
6. Per-surface fixes from §4, high-confidence first.
