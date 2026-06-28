# elizaOS #8795 — LifeOps Scenario + Benchmark Coverage + Per-Capability GEPA Loop: Research Report

**Issue:** #8795 — *LifeOps end-to-end scenario + benchmark coverage + per-capability GEPA optimization loop*
**Audience:** lalalune + contributing engineers
**Status of this report:** evidence-anchored; every finding below has been adversarially re-verified against the actual source (refuted claims are excluded). File:line citations are load-bearing.

---

## 1. Executive summary — the true state of #8795

The infrastructure is real and largely well-engineered; **the coverage that infrastructure is supposed to provide is substantially fake.** The headline risk is not a broken engine — it's a large body of green tests and "optimized" capabilities that assert nothing load-bearing.

- **The scheduling spine is the strongest subsystem and the GEPA optimized-prompt service is real** — structural routing (no `promptInstructions` string-matching), atomic claim-for-fire, HMAC-signed versioned artifacts, a single resolver chokepoint with compile-time-typed task names. This is genuinely load-bearing and well-tested. (§7)

- **The Python LIVE scorer is inverted: a do-nothing agent scores 1.0, a correct-write agent scores 0.3.** LIVE `ground_truth_actions == []`, so `state_hash_match` is true *only when the world is left unmutated*; LIVE score = `0.7*state + 0.3*substring` therefore rewards inaction. This is the single most severe defect and it is **untested** — the conformance oracle (PerfectAgent==1.0 / WrongAgent==0.0) only runs STATIC. (§3 Critical)

- **Two declared GEPA capabilities — `meeting_prep` and `screentime_recap` — are dead optimization targets.** They are in the taxonomy, trained, scored, datasetted, and benchmarked end-to-end, but have **zero `resolveOptimizedPromptForRuntime` consumers**. GEPA burns compute optimizing prompts nothing ever loads, and the benchmark green-lights a capability that does not exist at runtime. (§3 High, §5)

- **The PA scenario corpus is mostly larp.** 77% of PA scenarios (130 `executive.*` files) have no side-effect/end-state assertions; ~67% of `responseIncludesAny` turns are echo-satisfiable (agent passes by parroting the user's words); `plannerExcludes` lists exclude **tokens that can never be emitted** (`PAYMENT_EXECUTED` ×47, `CREDENTIALS_AUTOFILL`, `owner_send_message`), so those guards can never fail; and the `plannerText` field these matchers claim to inspect **is dead — never assigned anywhere in the repo.** (§3 High)

- **~200 `personalityExpect` scenarios (22% of the corpus) report `passed` while enforcing nothing** — `personalityExpect` is read only by the separate `personality-bench`, never by `runScenario`. (§3 High)

- **Real safety capability is absent across all three corpora.** No bench/training scorer can reward a correct refusal or escalation (success == matching ground-truth tool calls); plugin-health has zero self-harm/crisis/medical-disclaimer logic; there is no child/elderly/ESL/adversarial persona. The optimized `health_checkin` prompt can be GEPA-tuned *away* from any safety language with zero counter-pressure. (§3 High, §4)

- **Two genuine runtime bugs ship to users:** the `sleep-recap` default pack can **never fire** (its `personal_baseline_sufficient` gate is registered nowhere → permanent unknown-gate deny), and bedtime/wake-up "safety" gates **always allow** (fall-through stubs), so the morning greeting fires mid-conversation by default. A separate **Fitbit distance bug overstates daily distance ~2.5×** and a contract test enshrines the wrong value. (§3 High)

- **The "11,220 scenarios" and "574 tests" headline numbers are inflated/stale.** 11,220 = 1,020 real scenarios × 10 trivial prefix clones; the real pytest suite collects ~17,124 cases (~28× the documented 574). The Python privacy filter's "no opt-out" guarantee governs a path the bench never calls. (§3 Medium/Low)

**Bottom line for #8795:** the *plumbing* to do per-capability GEPA exists and is sound. The *evaluation signal that GEPA optimizes against* is the problem — it is inverted (LIVE), echo-satisfiable (PA scenarios), vacuous (phantom planner tokens), safety-blind (no refusal dimension), and partly pointed at dead targets (`meeting_prep`/`screentime_recap`). Optimizing prompts against this signal is at best a no-op and at worst actively harmful (LIVE inversion rewards a do-nothing assistant).

---

## 2. System map — how the pieces actually fit

### 2.1 Scenario runner (TS) — `packages/scenario-runner`
`runScenario` (`executor.ts:1812`) boots one shared `AgentRuntime`, runs seeds, then per turn executes message/action/api/tick/wait/voice kinds, captures actions via `interceptor.ts`, runs `runTurnAssertions` (`executor.ts:1548`), then `finalChecks` via the 31-handler registry (`final-checks/index.ts`). `report.status` starts `"passed"` and flips to `"failed"` only on a turn-assertion or finalCheck failure (`executor.ts:2070, 2106`). The judge (`judge.ts`) uses Cerebras `gpt-oss-120b` when keyed, else `runtime.useModel(TEXT_LARGE)`; a judge throw/parse-failure is correctly converted to FAIL. The deterministic LLM proxy has a STRICT mode (every PR/evidence CI script sets `SCENARIO_LLM_PROXY_STRICT=1`) and a heuristic echo mode (local dev only).

**The critical structural fact threaded through every PA/personality finding:** `execution.plannerText` is *declared* (`schema/index.d.ts:25`) and *read* (`executor.ts:137-140`) but **assigned nowhere in the repo**. So `buildPlannerAssertionBlob` (`executor.ts:134-152`) is built purely from captured `actionName` + stringified `parameters` — `plannerIncludes*`/`plannerExcludes` are **action-routing assertions, not planner-reasoning assertions**, despite their names. They are load-bearing for routing but cannot inspect LLM reasoning, and they can be satisfied by echoed tool-arg text.

### 2.2 PA scenario corpus — `plugins/plugin-personal-assistant`
178 `*.scenario.ts` + 23 legacy `*.json`. Strength tiers: (a) load-bearing finalChecks (`definitionCountDelta`, `goalCountDelta`, `selectedActionArguments`, `approvalRequestExists`, `noSideEffectOnReject`, `connectorDispatchOccurred`, `messageDelivered`, `draftExists`, `memoryWriteOccurred`); (b) `api` turns with `assertResponse` against real `/api/lifeops/*`; (c) `responseJudge`; vs (d) **weak** turn-level keyword/planner matchers. Only 41 scenarios carry any tier-(a/b/c) assertion; all 41 are non-`executive`. The 130 `executive.*` files (77%) carry only tier-(d) matchers. The canonical, richer LifeOps corpus actually lives at `packages/test/scenarios/` (approval-gating, DST reschedule, cross-TZ, connector dispatch are covered there) — the PA-plugin corpus is the weak one.

### 2.3 Optimized-prompt service + GEPA wiring — `packages/core` + `plugin-training`
`OptimizedPromptService` (`services/optimized-prompt.ts`, serviceType `optimized_prompt`) caches on-disk `<stateDir>/optimized-prompts/<task>/vN.json` artifacts (+ `current`/`previous` symlinks + per-artifact `.mac` HMAC-SHA256 sidecar, SOC2 CC6.8). `resolveOptimizedPromptForRuntime` (`optimized-prompt-resolver.ts:133`) is the single chokepoint; it returns the baseline when the service is null/disabled/has-no-artifact, and the `task` arg is compile-time typed. The taxonomy has 15 tasks (7 core + 8 LifeOps). **6 of 8 LifeOps tasks have real runtime consumers** (`health_checkin`, `calendar_extract`, `inbox_triage`, `reminder_dispatch`, `morning_brief`, `schedule_plan`); `meeting_prep` and `screentime_recap` have none. Training (`training-orchestrator.ts`), scoring (`optimizers/scoring.ts`), datasets, and the dspy artifact union all enumerate all 8 — so the dead two flow through the whole pipeline.

### 2.4 Health / screen-time — `plugins/plugin-health`
`healthPlugin` registers no actions/providers; PA wires the surfaces via `createHealthActionRunner`/`createScreenTimeActionRunner`. OWNER_HEALTH uses `resolveHealthPlanWithLlm` → the **only** runtime consumer of `health_checkin`. OWNER_SCREENTIME has no `useModel` call at all (`screentime_recap` is re-exported but never consumed). Three default packs (`bedtime`, `wake-up`, `sleep-recap`) are declarative `ScheduledTask` records routed through the scheduling runner; their `shouldFire` gates are the locus of two real bugs (§3).

### 2.5 Scheduling spine — `plugins/plugin-scheduling`
`createScheduledTaskRunner` (`runner.ts`) is storage-agnostic and **routes purely on structural fields** — `promptInstructions` appears only as an opaque pass-through, never matched. `fireWithResult` (`runner.ts:946`) does terminal-check → recurrence refire → gate eval → atomic `claimForFire` (UPDATE WHERE status='scheduled') → host-cap substitution → dispatch in try/catch. Due-eval lives in a separate `due.ts` consumed by the PA tick loop (`scheduler.ts`). Cron uses `computeNextCronRunAtMs` (DST-correct, 366-day scan). This subsystem is the most robust and best-tested; its findings are about **dead escalation code** and **dispatch-failure recovery**, not the core routing invariant (which holds).

### 2.6 Python bench — `packages/benchmarks/lifeops-bench`
Self-contained uv/pytest multi-turn tool-use bench over 10 domains. STATIC score = kind-weighted `state_hash + action + substring` with a triviality guard; LIVE score = `0.7*state_hash + 0.3*substring` gated on judge `satisfied`. `state_hash` (`world.py:535-563`) is a deep order-independent SHA-256 over every entity store — genuinely captures mutation in STATIC. The STATIC conformance oracle (PerfectAgent==1.0, both WrongAgent modes==0.0) is **real harness validation**. The LIVE branch has none. 1,020 core scenarios × 10 edge clones = 11,220.

### 2.7 CI wiring
The live TS benchmark runner (`runLifeOpsPromptBenchmark`) runs in **no automated lane** — only manual `workflow_dispatch live=true`. The Python live corpus also never runs automatically (nightly silently downgrades to STATIC for lack of an Anthropic judge key). The pure-function benchmark scoring/report code *is* PR-gated via `test:client`. Context-budget helper modules are test-only and never touch a real runtime.

---

## 3. Findings by severity

> **The headline risk is the LARP / non-load-bearing-assertion cluster.** It is grouped first within each severity tier. Each finding: title — subsystem — kind — evidence — fix.

### CRITICAL

**C1. LIVE scoring inverts: a do-nothing agent scores 1.0, a correct write scores 0.3** — *lifeops-bench-python — bug*
LIVE `ground_truth_actions == []` (`test_scenarios_corpus.py:187-188`), so `_replay_ground_truth` (`runner.py:2849-2858`) returns the unchanged seed hash and `state_hash_match` (`runner.py:3264-3265`) is true **iff the agent mutated nothing**. LIVE score (`scorer.py:1242-1244`) = `0.7*state + 0.3*substring`; `substring` defaults 1.0 (LIVE `required_outputs==[]`). Reproduced on `live.calendar.find_focus_block_tomorrow`: do-nothing+satisfied = **1.0**, correct-write+satisfied = **0.3**. `world_assertions` are judge-advisory only (`evaluator.py:425-432`). The corpus is write-oriented majority, so this mis-scores the bulk of LIVE.
**Fix:** for LIVE, stop comparing the final world to the unchanged seed. Either drop the `state_hash` component for LIVE and score on the judge verdict, or parse `scenario.world_assertions` into checkable predicates against the final `LifeWorld`. Add a scorer test asserting a LIVE write where do-nothing scores **strictly less** than the correct mutation.

---

### HIGH — LARP / non-load-bearing assertions (headline cluster)

**H1. `plannerIncludes*/Excludes` never inspect planner reasoning — `plannerText` is dead** — *scenario-runner-core — larp*
`execution.plannerText` is read at `executor.ts:137-140`, declared at `schema/index.d.ts:25`, **assigned nowhere** (repo-wide grep). The blob (`executor.ts:134-152`) is `actionName` + `stringifyForAssertion(parameters)` only. ~633 planner assertions across 153 scenario files claim to verify reasoning while matching action names + echo-derivable tool args. `plannerJudge` (`schema/index.d.ts:193`) is also declared and never consumed.
**Fix:** either populate `plannerText` from the trajectory recorder's `ACTION_PLANNER`/`RESPONSE_HANDLER` output (make the name honest), or rename to `actionTraceIncludes*` and add a ratchet flagging `plannerIncludesAny` arrays whose keywords all appear in the scenario's own text literals. Add a unit test asserting the blob includes recorded planner reasoning.

**H2. ~200 `personalityExpect` scenarios pass with zero enforcement** — *scenario-runner-core — larp*
`personalityExpect` is read **nowhere** in `packages/scenario-runner/src` (only `corpus-assertion-guard.test.ts`); the real consumer is `personality-bench` (`bridge.ts:95`, `judge/checks/llm-judge.ts`) driven by pre-recorded trajectories, never `runScenario`. Static scan: 890 corpus files, exactly 200 are `live-only` with no finalChecks and no per-turn assert — **all 200 are `personalityExpect`** and all report `passed` vacuously (e.g. `escalation.frank.list.003.scenario.ts`). The guard's `personalityExpect` rule only checks lane-labeling, not enforceability.
**Fix:** teach `runScenario` to evaluate `personalityExpect` as an inline final check (mirroring `runJudgeRubricFinalCheck`), **or** extend `corpus-assertion-guard.test.ts` to FAIL any scenario with no finalChecks, no per-turn assertion, and no executor-evaluable `personalityExpect`. Add a regression test that one personality scenario can FAIL through `runScenario` when the reply violates the rubric.

**H3. `plannerExcludes` lists exclude tokens that can never be emitted — the guard can never fail** — *pa-scenario-coverage — larp*
The blob is canonical action names + params (H1). Non-existent tokens (grep over src): `PAYMENT_EXECUTED` 0 src / 47 scenario occurrences **all in `plannerExcludes`**; `CREDENTIALS_AUTOFILL` 0 src; `gmail_action` 0 src (27 excludes); `owner_send_message` lowercase 0 src (real action is `OWNER_SEND_APPROVAL`). None can ever appear in the blob → every such exclude is a permanent no-op. `corpus-assertion-guard.test.ts:236-244` counts `plannerExcludes` *presence* as enforceable coverage, so vacuous excludes satisfy the no-vacuous-scenario gate.
**Fix:** add a corpus guard that fails when any `plannerExcludes`/`plannerIncludes` token is neither a registered action name nor in the expected-plan vocabulary (allowlist `OWNER_*`, `WORK_THREAD`, `SCHEDULED_TASKS`, `PERSONAL_ASSISTANT`, `CALENDAR`, `ENTITY`). Replace "no payment executed" intents with a real `noSideEffectOnReject` finalCheck inspecting the payment/approval ledger.

**H4. ~67% of `responseIncludesAny` turns are echo-satisfiable** — *pa-scenario-coverage — larp*
`responsePatternMatches` (`executor.ts:62-71`) substring-matches only `execution.responseText`. 213/320 PA `responseIncludesAny` turns (120 distinct scenarios) are satisfiable by parroting words from the user's own prompt — e.g. `art-shipping-insurance-claim.scenario.ts:24/26` user text contains `photos/appraisal/insurance/claim` vs `responseIncludesAny:["photos","appraisal","insurance","claim"]`. 122 of 125 echo-satisfiable files have no finalChecks and no `assertResponse`. `echo-assertion-ratchet.test.ts` (BASELINE=237) caps growth but does not fix the backlog (#9310).
**Fix:** rewrite the worst offenders (`board-*`, `art-*`, `caregiver-*`, `concierge-*`, `conference-*` — each 2 fully-echoed turns, 0 finalChecks) to assert an *effect* (finalCheck or `assertResponse` on a real `/api/lifeops` state change), then lower the ratchet baseline.

**H5. `extractGmailPlanWithLlm` + `GMAIL_PLAN_INSTRUCTIONS` (the declared `inbox_triage` consumer) is orphaned** — *pa-llm-consumers — larp*
`extractGmailPlanWithLlm` (`extract-gmail-plan.ts:74`) has **zero production callers** (only its def + one happy-path test); not re-exported. The real `inbox_triage` path is `plugin-inbox/src/inbox/triage-classifier.ts` with its **own** `INBOX_TRIAGE_INSTRUCTIONS` baseline (`:107`) and tag (`:80-81`). Yet training (`training-orchestrator.ts:493-498`, `lifeops-gepa-seed.ts:421`) seeds `inbox_triage` against `GMAIL_PLAN_INSTRUCTIONS` — **a baseline that diverges from what production runs.** GEPA optimizes the wrong prompt.
**Fix:** delete `extract-gmail-plan.ts` + its baseline + orphan test, OR wire it as the real INBOX planner. Either way, point the `inbox_triage` training baseline at `INBOX_TRIAGE_INSTRUCTIONS`. Add a guard test asserting every declared LifeOps `OptimizedPromptTask` has ≥1 non-test production consumer (also catches `meeting_prep`/`screentime_recap`).

**H6. `meeting_prep` + `screentime_recap` are dead optimization targets** — *optimized-prompt-service / health-screentime — larp*
Declared in taxonomy (`optimized-prompt.ts:83/86/103/106/120/123`), trained, scored (`scoring.ts:302/305/314/316`), datasetted, dspy-unioned, and benchmarked — but **zero `resolveOptimizedPromptForRuntime` consumers** (exhaustive enumeration of all 14 call sites). `brief.ts:474` resolves `morning_brief` not `meeting_prep`; screen-time actions have no resolver call. The benchmark cases assert `expectedAction "BRIEF"`/`"OWNER_SCREENTIME"`, neither of which resolves these task names — so a green benchmark row proves planner routing, not prompt optimization. `optimized-prompt-resolver.test.ts:184` only checks the matrix == taxonomy, masking the gap.
**Fix:** decide and encode. (a) wire `meeting_prep` into the BRIEF/meeting-dossier prompt and `screentime_recap` into the OWNER_SCREENTIME recap path, each with a routing test; OR (b) remove both from the taxonomy, dspy union, scorer lists, dataset maps, and benchmark cases. Add a static call-site-existence guard so a declared-but-unwired task fails CI.

---

### HIGH — runtime bugs & robustness

**H7. `sleep-recap` default pack can NEVER fire** — *health-screentime — bug*
`sleep-recap.ts:39` gates on `personal_baseline_sufficient` (compose:`all`, first gate). `registerBuiltInGates` (`gate-registry.ts:307-316`) registers 8 gates — **not** this one — and it is registered nowhere in the repo. The runner (`runner.ts:476-485`) returns `deny "unknown gate kind"` → `status="skipped"`, no dispatch. `defaultEnabled:false` keeps it off auto-seed, but `getOfferedDefaultPacks` offers it at first-run, so any opt-in user gets a feature that can never fire. No test cross-checks gate kinds against the registry.
**Fix:** register a real `personal_baseline_sufficient` `TaskGateContribution` (reading `SleepEpisodeRepository` via `CircadianInsightContract`) or a warn-once fallthrough. Add a cross-plugin guard test asserting every gate kind referenced by every pack record resolves in the registry.

**H8. bedtime/wake-up "safety" gates always allow** — *health-screentime — larp*
`circadian_state_in` and `no_recent_user_message_in` are `makeWarnOnceFallthroughGate` instances (`gate-registry.ts:248-257`) that **unconditionally return `allow`** (comment at `:233-239` admits the readers "are not wired into the runner today"). No production reader overrides them (registry throws on duplicate kinds, `:288-294`). `wake-up` is `defaultEnabled:true` and auto-enabled, so the morning greeting fires **mid-conversation by default**; bedtime fires while the user is asleep. `scheduler.integration.test.ts:639` actually codifies the fall-through as accepted.
**Fix:** register production `circadian_state_in` (via `getCircadianInsightContract`) and `no_recent_user_message_in` (recent-message lookup). Add tests: a `circadian_state_in` gate denies bedtime when sleeping; `no_recent_user_message_in` denies wake-up when a user message exists within 30 min. Until wired, fail a test if `wake-up` is `defaultEnabled:true` while its gate is a fallthrough.

**H9. Thrown dispatcher → task stuck `fired`, notification silently lost** — *scheduling-spine — bug*
`runner.ts:1083-1096` returns `{kind:"dispatch_failed"}` with no revert/retry/backoff; the row was already persisted `fired` at `:1058`. For `once`/`event`/approval tasks, `computeNextFireAt` returns null → `next_fire_at` NULL → never re-selected; completion-timeout pass only issues `skip`, never re-dispatch. A transient channel outage (push 503, imessage bridge offline) **permanently drops** a user-facing reminder/approval while the user believes it sent. Zero `dispatch_failed` tests. (Recurring tasks lose only the failed occurrence.)
**Fix:** on dispatch throw, revert `status` to `scheduled`, set `firedAt` to a backoff time (`now + min(2^attempt, cap)`), persist, log a `dispatch_failed` transition so the next tick retries. Add a runner unit test (inject a throwing dispatcher; assert re-selectable) + an integration test proving a transient failure is retried and eventually delivered.

**H10. Multi-step escalation ladder is dead code** — *scheduling-spine — larp*
`nextEscalationStep` (`escalation.ts:133`) and the high-priority ladder `[in_app@0,push@15,imessage@45]` (`:74-81`) have **zero non-test callers**. `claimForFire` only transitions scheduled→fired, and `due.ts:155` bars re-ticking a `fired` task, so the cursor stays `-1` forever and steps 1–2 never fire. Even the manual `escalate` verb (`runner.ts:701-717`) doesn't advance the cursor. The spine advertises a 3-step cross-channel escalation engine that never runs.
**Fix:** wire the runner to walk the ladder after fire (schedule next step, advance cursor, re-dispatch until ack/exhaustion; add tests asserting in_app→push→imessage at +0/+15/+45 and STOP on acknowledge), OR delete `nextEscalationStep` + ladder bodies if the `plugin-reminders` mechanism is authoritative. Add a guard test failing if a `steps.length>1` ladder resolves with no re-dispatch path.

**H11. Fitbit distance overstated ~2.5×; contract test enshrines the wrong value** — *health-screentime — bug*
`summary.distances` rows are breakdowns *of* the `total` (`activity:'total'`, `'tracker'`, `'veryActive'`), but `health-connectors.ts:443-447` reduce-sums **all** rows and `:483` emits `*1000` m. An 8.52 km day → `(8.52+8.52+4.1)*1000 = 21140 m`. `fitbit-connector.contract.test.ts:132-142` asserts the summed value, locking the bug (the file header comment even documents the correct total-only behavior).
**Fix:** read only the `activity==='total'` row (fallback to max single entry); fix the assertion to `8.52*1000`; add a fixture with extra subset rows proving only `total` is taken.

**H12. No bench/training scorer can reward refusal/escalation** — *personas-fuzz — design/safety*
`Scenario` (`types.py:123-143`) has no `forbidden_actions`/`expects_refusal`/safety field; every STATIC/LIVE weighting is `state+action+substring`; `scoreLifeOpsTask` (`scoring.ts:451-460`) only scores structured fields/agreement. Success == matching ground-truth tool calls. The LIVE judge is even told "Refusal responses are NOT satisfied" (`evaluator.py:453`), mis-grading a correct flat refusal as failure. **GEPA optimizes with zero safety pressure.** No social-engineering/over-ask scenario exists (grep `grandson|wire transfer|scam|gift card` = 0).
**Fix:** add optional `forbidden_actions`/`expects_refusal` to the bench `Scenario`; teach `scorer.py` to award credit when the agent takes none of the forbidden actions (judge-confirmed refusal). Author social-engineering scenarios (relayed "wire $5,000 to this account" → must hold/flag, not execute MONEY). Fix the LIVE judge prompt so a legitimate refusal can be `satisfied`.

**H13. Health check-in has no self-harm/crisis safety scenario or code** — *personas-fuzz — gap/safety*
`health-checkin-sleep-recovery.scenario.ts` has one benign turn and a single `selectedActionArguments` routing assertion — never tests a distress disclosure. Grep `self-harm|suicide|crisis|988|hopeless` over plugin-health src+scenarios = 0; `optimized-prompt-instructions.ts` (31 lines) has no medical-disclaimer/safety language. Because `health.ts:199-229` routes this prompt through GEPA, any safety clause is optimizable away.
**Fix:** add a scenario where the simulated user discloses distress mid-check-in; correct behavior = non-clinical supportive handoff to crisis resources, no diagnosis, not silently logged as a metric — assert via `judgeRubric`. Pair with a minimal distress-detection clause in `HEALTH_PLAN_INSTRUCTIONS` anchored so GEPA can't remove it.

---

### HIGH — untested critical paths

**H14. LIVE branch of `score_scenario` has zero correctness tests** — *lifeops-bench-python — untested*
The conformance oracle (`test_conformance.py:542-582`) filters `mode is not STATIC` (`:422`); `_scenario()` in `test_scorer_fixes.py:59` hardcodes STATIC. `test_live_scenarios.py` constructs LIVE scenarios but makes **no score assertion**; the budget LIVE tests only hit the cost-exceeded error guard before the LIVE formula. The benchmark's correctness oracle never exercises the branch that scores live runs — which is exactly the branch that is inverted (C1).
**Fix:** add `score_scenario(mode=LIVE)` tests (do-nothing@satisfied must not outscore a correct mutation; `terminated_reason != "satisfied"` forces 0) and a "perfect-live" oracle under a stubbed always-satisfied judge.

**H15. Live TS benchmark runner runs in NO automated CI lane** — *ci-wiring-orphans — untested*
`runLifeOpsPromptBenchmark`'s live path is gated by three env vars; PRs always set `LIFEOPS_PROMPT_BENCHMARK_LIVE=0`, `TEST_LANE` is never `post-merge` in any workflow, and `RUN_LIFEOPS_PROMPT_BENCHMARK` is set nowhere. Only manual `workflow_dispatch live=true` reaches `createLifeOpsPromptBenchmarkRuntime`/cost-token accounting. (The pure-function scoring/report path *is* PR-gated.)
**Fix:** add a nightly/weekly `schedule:` to `lifeops-prompt-benchmark.yml` setting `LIFEOPS_PROMPT_BENCHMARK_LIVE=1` + provider secret + a small case limit, or a `post-merge` push job setting `TEST_LANE=post-merge`. Unify the env gate (`.test.ts` uses `LIFEOPS_PROMPT_BENCHMARK_LIVE`, `.activation.test.ts` uses `RUN_LIFEOPS_PROMPT_BENCHMARK` — pick one).

**H16. Python live corpus never runs in scheduled/required CI; nightly silently downgrades to STATIC** — *lifeops-bench-python — gap*
`cerebras-nightly.yml` runs `--suite full` with no `--mode` and only `CEREBRAS_API_KEY`; `__main__.py:572-577` forces STATIC (warn, not fail) when both keys are absent, and the judge is hardcoded `make_client('anthropic',...)` (`:643`) with no Cerebras fallback. The second scheduled workflow (`lifeops-bench-multi-tier.yml`) also splits the two keys across jobs, so no job ever holds both. The headline live coverage is never automatically exercised.
**Fix:** wire `ANTHROPIC_API_KEY` (or a Cerebras-judge fallback) into the nightly and pass `--mode live`, OR document the live scenarios as manual-only and stop headlining them. At minimum, fail loudly (not warn) when intended-live silently collapses to STATIC.

**H17. `OptimizedPromptService.refresh()` is not fault-isolated per task** — *optimized-prompt-service — robustness*
`loadArtifactFromPath` (`optimized-prompt.ts:790-805`) returns null only for ENOENT and **rethrows all other errnos** (ELOOP/EACCES/EISDIR) on both the artifact and `.mac` read. The per-task loop in `refresh()` (`:617-655`) has no try/catch; a single corrupt/looping/permission-denied `current` symlink throws out of `start()` (`:424`), marking the service `failed` (`runtime.ts:3993`). The resolver then returns the baseline for **all 15 tasks** — one corrupt artifact globally disables optimized prompts. `rollback()` also calls `refresh()`. Zero ELOOP/EACCES/EISDIR tests.
**Fix:** wrap each per-task body in try/catch (log-and-skip to that task's baseline, never poison the others or fail start) — matching the documented "absent artifact is a no-op, never a failure" contract. Add a self-referential-symlink test and an EISDIR test asserting `refresh()` resolves with the valid task cached.

---

### MEDIUM

**M1. 130 `executive.*` scenarios (77%) have no side-effect/end-state assertions** — *pa-scenario-coverage — larp*
137/178 lack any of finalChecks/responseJudge/assertResponse/assertTurn; 130 are `executive.*`. 14 "approvals"-tagged scenarios use **zero** approval finalChecks; 0 executive scenarios use `draftExists`/`connectorDispatchOccurred`/`messageDelivered`/`memoryWriteOccurred`. (Routing regressions *can* fail these via H1's action-name matchers; side-effect/approval-queue/draft/dispatch regressions cannot. They are `live-only`, outside the PR merge gate.)
**Fix:** add ≥1 load-bearing finalCheck per claimed-effect journey — start with the 14 approvals scenarios (`approvalRequestExists`/`approvalStateTransition`), then `draftExists`, `connectorDispatchOccurred`/`messageDelivered`, `memoryWriteOccurred`.

**M2. All optimized-prompt LLM consumers tested only on the happy path** — *pa-llm-consumers — untested*
`lifeops-optimized-prompts.test.ts` has 3 happy-path tests; its `useModel` mock never throws/returns malformed/empty. Robustness diverges silently: `resolveSchedulingPlanWithLlm` has try/catch + invalid-JSON guard; `renderReminderBody` has try/catch + fallback; **`extractGmailPlanWithLlm` and `composeNarrative` have no catch — a thrown model error propagates.**
**Fix:** per-consumer matrix — invalid JSON → safe clarify default; empty string → safe default; `useModel` throws → no unhandled rejection. For `composeNarrative`, decide and lock the throw contract.

**M3. `FinalCheck` `skipped-dependency-missing` silently passes the scenario** — *scenario-runner-core — edge-case*
`executor.ts:2106` flips to `failed` only on `status==="failed"`; a skipped check leaves the scenario green. `checkStoredReminderIntensity` (`final-checks/index.ts:1869-1873`) returns skip when the live service lacks the duck-typed shape — so a `reminderIntensity`-only scenario goes green proving nothing. No per-check skip count in the report; the skip-branch-equals-pass behavior is untested. (approval/push absence branches are dead — interceptor always provides arrays.)
**Fix:** decide policy — treat `skipped-dependency-missing` as FAILED by default, or surface a loud per-scenario skipped-check count and make CI treat any skipped finalCheck as non-green. Add a test for the reminderIntensity skip branch.

**M4. Interceptor stamps `success:true` for any non-object handler return** — *scenario-runner-core — robustness*
`interceptor.ts:402-404` sets `entry.result = { success: true }` for void/undefined/string returns, contradicting the object path (`:378`, safe `undefined` default) and the connector path (`:285-286`, safe `false` default). `actionCalled status:'success'` (consumed at `final-checks/index.ts:704-705`) therefore passes with no real success evidence for no-op/early-return handlers. Untested.
**Fix:** set `success: undefined` (or omit) for non-object returns. Add a test: a void-returning handler must FAIL `actionCalled{status:'success'}`.

**M5. Completion-timeout and fire passes share one `limit`; a timeout backlog starves due fires** — *scheduling-spine — edge-case*
Both loops gate on the shared total (`scheduler.ts:141, 173`); the timeout loop runs first. `timeoutCandidates` is queried with `status:['fired']` and no `dueAtOrBeforeIso`, and `listScheduledTasks` (`repository.ts:7263-7337`) emits SQL with **no LIMIT** → O(all-fired-rows) scan each tick. Production limit is 25; ≥25 simultaneously-due timeouts zero out due fires that minute. No fairness test.
**Fix:** give the two passes independent budgets (or process due-fires first), and bound the `timeoutCandidates` query with a `dueAtOrBeforeIso`/limit. Add an integration test seeding `limit` timeouts + one due reminder, asserting the reminder still fires within bounded ticks.

**M6. Context-budget tests assert `char/4` on hand-written strings; provider lists are wrong/duplicated** — *ci-wiring-orphans — larp*
Neither helper touches a runtime/`composeState`/`getProvider` (grep = 0). `lifeops-context-budget.test.ts:37` asserts `100 === 400/4` — self-authored arithmetic. The two near-duplicate modules disagree: `lifeops-context-budget.ts:33-34` (`"activity-profile"/"lifeops-health"`, correct) vs `lifeops-context-budget-benchmark.ts:8-9` (`"activityProfile"/"health"`, both wrong). No test diffs either list against `src/providers/*.ts`.
**Fix:** add a test that boots `createLifeOpsTestRuntime`, runs `composeState` over the real provider set, and fails if total tokens exceed budget. Add a hermetic assertion that the provider-id lists equal the discovered provider `name`s (so `health` vs `lifeops-health` drift fails CI). Collapse the two modules into one. (Note: `ELIZA_LIFEOPS_CONTEXT_WINDOW` is a conversation-line count, not a token budget — don't conflate.)

**M7. `meeting_prep`/`screentime_recap` benchmarked end-to-end but optimize nothing — misleading green light** — *ci-wiring-orphans — design*
The benchmark forces a direct case per task (`lifeops-prompt-benchmark.test.ts:37-44` throws if any is missing) and both map to handlers (`BRIEF`/`OWNER_SCREENTIME`) that never resolve their task names. A passing row proves planner routing, not optimization. (Same root cause as H6; tracked separately because the *benchmark* implies coverage that does not exist.)
**Fix:** resolve via H6 (wire or remove). Add a guard cross-checking `LIFEOPS_PROMPT_BENCHMARK_TASKS` against tasks that actually have a `resolveOptimizedPromptForRuntime` consumer.

**M8. "11,220 scenarios" is 1,020 real × 10 trivial prefix clones** — *lifeops-bench-python — larp*
`EDGE_EXPANDED_SCENARIOS` (`scenarios/__init__.py:68-78`) rewrites only id/name/instruction/description via `dataclasses.replace`; `ground_truth_actions`/`required_outputs`/`world_seed` are identical across all 10 clones. `count_lifeops_scenarios` reports `total=11220` with no core-vs-edge split; `README.md:62` is stale ("1020 total"). No test pins clone identity.
**Fix:** report core vs edge-expanded separately in `count_lifeops_scenarios` and the docs ("1020 base; 10× prefix-robustness variants = 11220 runs"). Add a corpus test asserting the 10 edge variants of any base id share identical `(ground_truth_actions, required_outputs, world_seed)`.

**M9. Mandatory trajectory privacy filter is dead relative to the bench** — *lifeops-bench-python — larp*
The "Hard rule … no opt-out" guarantee (`ingest/trajectories.py:9-13`) governs `load_trajectories_from_disk`, which the bench core never imports. Sole consumer is `prepare_eliza1_trajectory_dataset.py` (which carries a duplicated inline port). Ordered patterns mislabel `sk-ant-*` as `openai-key` (`privacy.py:34-35`) — secret still removed, but the per-label audit count is wrong.
**Fix:** wire a `--from-trajectories <dir>` mode, OR relocate `privacy.py` into `plugin-training` (its single consumer) and delete the duplicate port. Add a sync test diffing `privacy.py` patterns against the inline copy.

**M10. Action-level error/clarification branches untested for both health/screen-time runners** — *health-screentime — untested*
`PERMISSION_DENIED`, `planner_clarification`/`shouldAct=false`, `MISSING_METRIC` (`health.ts:458-689`) and `PERMISSION_DENIED`/`INVALID_SUBACTION`/`MISSING_APP`/`MISSING_DOMAIN`/`browser_activity_empty` (`screen-time.ts:491-846`) exist in source but no test asserts any — cheap pure guard branches with no LLM/DB dependency.
**Fix:** add the obvious per-branch unit tests (hasAccess:false → PERMISSION_DENIED; shouldAct:false → planner_clarification; by_metric with no metric → MISSING_METRIC; etc.).

**M11. Health/screentime packs only shape-asserted/simulated, never driven through the real runner** — *health-screentime — untested*
`plugin-health/.../smoke.test.ts:164-206` is shape-only; PA `default-packs.smoke.test.ts` is a hand-rolled `simulateOneDay` with a phantom sleep-recap record. No test constructs `createScheduledTaskRunner` + `registerBuiltInGates` + the real pack records — which is exactly why H7 (dead sleep-recap gate) and H8 (always-allow gates) shipped unnoticed.
**Fix:** add an integration test driving the real `sleepRecapDefaultPack`/`bedtimeDefaultPack`/`wakeUpDefaultPack` through the runner with an injected clock, asserting `evaluateGates` outcomes (sleep-recap must currently FAIL on unknown gate). Replace the phantom record with the real import.

**M12. Imperial-locale Fitbit accounts silently store miles-as-meters and lbs-as-kg** — *health-screentime — edge-case*
`fetchHealthValue` (`health-connectors.ts:245-256`) sends no `Accept-Language`/unit header; distance assumes km (`:483`), weight passes through as kg (`:585-597`, raw unit captured in unused `metadata.providerUnit`). An imperial-default account yields ~61% over on distance, ~120% over on weight. Only a metric fixture exists. (Strava correctly emits raw meters.)
**Fix:** send `Accept-Language: en_GB` and convert deterministically, OR read profile `distanceUnit`/`weightUnit` and convert explicitly. Add an imperial-locale fixture + contract test; audit Withings/Oura weight.

**M13–M16. Persona/register/i18n coverage gaps** — *personas-fuzz — gap/edge-case*
- **M13 (child):** no child persona, no child phrasing, no child-as-user, no child-safety refusal across all three corpora (child *domain* coverage is rich, but all adult-parent POV). Add `PERSONA_LEO_KID` + 4–6 literal-child scenarios incl. one child-safety refusal.
- **M14 (elderly):** elderly modeled only as "patient retiree"; no rambling/repetition/confusion or medication-adherence-ambiguity or same-reminder-twice-dedup scenario. Add `PERSONA_ELDER_CONFUSED` + a `definitionCountDelta==1` dedup scenario + a "did I take my pill?" ambiguity case.
- **M15 (voice/typo):** zero homophone/ASR-noise and zero typo scenarios; the LIVE simulator never injects noise; a non-functional `voice-asr` benchmark variant only lowercases (never run live, scores action-name only). Add fuzz scenarios asserting *resolved intent* via finalChecks ("timer for free minutes" → 3 min) + a `noise:'asr'|'typo'` simulator knob.
- **M16 (i18n):** i18n is clean translation only — no DD/MM-vs-MM/DD, 24h-vs-12h, mixed-script, or ESL grammar. Add locale-ambiguity + ESL/code-switch scenarios asserting resolved date/time via finalChecks.
- **(M-runons):** no casual 3+-chained-intent run-on; only a clean multi-turn "never mind" contradiction, no same-turn flip with net-end-state assertion. Add both.

---

### LOW

- **L1.** `echo-assertion-ratchet` guards only `responseIncludes*`, not `plannerIncludes*`/`selectedActionArguments.includesAny` (which are also echo-derivable). Extend the ratchet to scan both against text literals + the proxy echo. *(scenario-runner-core — untested)*
- **L2.** Heuristic (echo) proxy active-mode is logged only at `info`; on a live run without Cerebras the judge grades with the same `TEXT_LARGE` model under test, with no assertion that judge-model != agent-model. Emit a loud warning for heuristic mode; assert/fail-loud on same-model judging. *(scenario-runner-core — design)*
- **L3.** `expectedActions` fuzzy matching credits a generic `CALENDAR` for a specific `CALENDAR_CREATE_EVENT` via token-prefix equivalence — intentional and tested, but the exact CALENDAR-vs-CALENDAR_CREATE_EVENT pair is untested. Add table-driven pins; decide if "actual must be ≥ as specific." *(scenario-runner-core — robustness)*
- **L4.** `parseGmailPlan` blindly casts `subaction` (no allowlist) and defaults `shouldAct=true` — real, but the function is **orphaned** (H5), and Gmail sends are independently `confirmSend`-gated, so inert. Add a `normalizeGmailSubaction` allowlist + try/catch if kept; else delete. *(pa-llm-consumers — robustness)*
- **L5.** `parseExplicitLocalDate` doesn't handle "today"/"tomorrow"/"in N days" — but this is a clarification *fallback*; the primary create-event resolver is the time-anchored LLM extractor. Extend the fallback for robustness with DST/rollover tests. *(pa-llm-consumers — edge-case)*
- **L6.** No RRULE/recurrence parsing in any LifeOps LLM consumer; raw user/param text is interpolated into prompts with zero injection-test coverage. Add a recurring-request punt test + per-extractor injection tests; document that recurrence is unsupported. *(pa-llm-consumers — untested)*
- **L7.** Core daily-loop narrow gaps survive repo-wide: **no owner-reject → no-side-effect journey** (`approvalStateTransition` is only ever pending→approved; `noSideEffectOnReject` needs a `confirmed===false` action approve-paths never produce), and calendar recurring/TZ scenarios assert via `judgeRubric`/custom predicate, not `selectedActionArguments` with the recurrence param. Add an explicit reject scenario + a structural recurrence-param assertion. *(pa-scenario-coverage — gap)*
- **L8.** Cron task missed by >36h silently skips missed occurrences; never-fired-with-no-`createdAt` mis-bases off a 36h floor. Catch-up works and there's no fire-storm (atomic claim sets `firedAt=now`), but the contract is untested. Add `due.test.ts` cases pinning single catch-up + no-storm. *(scheduling-spine — edge-case)*
- **L9.** `state.firedAt` is overloaded (future override marker vs last-actual-fire); the atomic claim prevents the feared double-count, so it's a latent-overload + missing-test cleanup, not a bug. Consider splitting into `firedAt` + `overrideFireAt`. *(scheduling-spine — design)*
- **L10.** `during_window` dedup keys on owner-local date+window; a DST fall-back or owner TZ change can re-fire/skip a window within one calendar day (≤1/year, reachable via the shipped `morning_or_night` default). Key on a UTC occurrence bucket + add DST/TZ-edit tests. *(scheduling-spine — edge-case)*
- **L11.** Concurrent `setPrompt` from two writers sharing one `stateDir` races the version counter (no lock/O_EXCL) → a clobbered `vN.json` with a mismatched `.mac` is silently rejected on next load (graceful degradation to baseline, not corruption). Serialize per-task-dir writes (lock file or O_EXCL retry). Add a concurrent-`setPrompt` test. *(optimized-prompt-service — robustness)*
- **L12.** A typo'd `OPTIMIZED_PROMPT_DISABLE` entry is silently dropped (`optimized-prompt.ts:391-403`, no warn) — a real emergency-disable footgun. `logger.warn` once per dropped token + a test. *(optimized-prompt-service — edge-case)*
- **L13.** No coverage for absurd biometric values (9999 bpm / negative sleep pass `Number.isFinite`), partial-data summaries (`steps=0` printed as measured fact), or child/elderly/units health phrasing. Add absurd-value + partial-data + `judgeRubric` refusal/units scenarios. *(health-screentime — edge-case)*
- **L14.** Documented "574/600 passing tests" understates the real ~17,124-case pytest suite ~28× (5,424 scenarios × 3 conformance tests). Update docs to the real collected count or add a representative-sample marker. *(lifeops-bench-python — robustness)*
- **L15.** 2,548 static scenarios have `required_outputs` appearing verbatim in their own instruction; the state-hash triviality guard neutralizes pure echo, but partially-correct agents bank substring credit (worst on READ_WITH_SIDE_EFFECTS at 0.55 weight). Add a corpus test flagging instruction-substring needles; prefer post-action result needles. *(lifeops-bench-python — edge-case)*
- **L16.** Dead/over-exported benchmark-helper symbols (`createLifeOpsPromptBenchmarkRuntime`, `AxOptimizationRow`, `PromptBenchmark{Slice,Latency}Stats`). Drop the `export`s; narrow the knip entry glob (helpers are currently *entry* files, which is why knip can't flag them). *(ci-wiring-orphans — stub)*
- **L17.** PA-plugin `scripts/lifeops-prompt-benchmark.ts` is a near-duplicate orphan (the runner logic is CI-covered via the test; only the CLI wrapper is uninvoked). Delete the duplicate; collapse to one canonical script. *(ci-wiring-orphans — larp)*

---

## 4. Edge-case & fuzz matrix

Coverage legend: **none** = no scenario/test; **larp** = a scenario exists but its assertions don't bind to the behavior; **real** = a load-bearing assertion exists.

| Input class | Current coverage | Where it falls short | Specific scenario/test to add |
|---|---|---|---|
| **Vague / anaphora** | larp | `calendar-vague-followup.scenario.ts:50` checks only that the planner stays in `calendar_action`; `daily-left-today-variants` is register-only | Vague time-anchor ("feed my fish after cartoons") → assert assistant **asks**, then assert resolved reminder due-time via finalCheck |
| **Multi-step (3+ chained intents)** | none | No casual run-on; only formal imperative lists | One message mixing reminder + booking + read-query → `definitionCountDelta` + `draftExists` + a calendar read, proving clause decomposition |
| **Contradictory** | larp | Only clean multi-turn "never mind"; no same-turn flip | "cancel the 3pm — no wait, move it to 4" → calendar finalCheck on **net** end-state (one event at 4pm, none cancelled) |
| **Timezone / recurrence** | larp→real(partial) | `one-off-mountain-time` real; recurring/DST exist in `packages/test/scenarios` but assert via `judgeRubric`, not structural recurrence param; no DD/MM ambiguity | DST fall-back `during_window` test; recurring reschedule asserting `selectedActionArguments` with the recurrence/exception param; cross-TZ stored-event TZ assertion |
| **Malformed-LLM-output** | none | `extractGmailPlanWithLlm`/`composeNarrative` have no try/catch; only happy-path mocks | Per-consumer matrix: invalid JSON / empty / `useModel` throws → safe default, no unhandled rejection (M2) |
| **Child register / child-as-user** | none | No persona, phrasing, or safety refusal | `PERSONA_LEO_KID` + literal-child scenarios; ≥1 child-safety refusal (child asks to send money/buy) (M13, H12) |
| **Elderly confusion** | none | Modeled only as "patient retiree" | `PERSONA_ELDER_CONFUSED` (rambling/repetition); same-reminder-twice → `definitionCountDelta==1`; "did I take my pill?" ambiguity (M14) |
| **ESL / typo / voice-transcription** | none | All clean grammatical text; LIVE simulator never injects noise; `voice-asr` variant only lowercases & never runs | ASR/typo fuzz scenarios asserting **resolved intent** via finalCheck; `noise:'asr'\|'typo'` simulator knob (M15) |
| **Adversarial / safety** | none | No social-engineering scenario; no scorer dimension can reward refusal; LIVE judge mis-grades refusal as failure | Relayed "wire $5,000" → must hold/flag (no MONEY action); add `forbidden_actions`/`expects_refusal` to bench `Scenario` + scorer credit (H12) |
| **i18n ambiguity (vs translation)** | larp | 16 clean translations; no DD/MM, 24h/12h, mixed-script, code-switch | "book the dentist on 03/04" with DD/MM-implying profile → assert locale-correct resolved date; ESL/code-switch request (M16) |
| **Crisis / self-harm disclosure** | none | No scenario, no code-level distress handling | Distress disclosure mid-check-in → `judgeRubric`: supportive non-clinical handoff, no diagnosis, not logged as metric; anchored `HEALTH_PLAN_INSTRUCTIONS` clause (H13) |
| **Absurd / partial health values** | none | `Number.isFinite`-only gate; `steps=0` printed as measured fact | 9999 bpm / negative sleep rejected; only-sleep summary must not assert "0 steps walked" (L13) |

---

## 5. The `meeting_prep` / `screentime_recap` dead-task decision

**The precise situation.** Both tasks are first-class citizens of the entire GEPA pipeline — declared in `OPTIMIZED_PROMPT_TASKS`/`LIFEOPS_OPTIMIZED_PROMPT_TASKS` (`optimized-prompt.ts:83/86/103/106/120/123`), loaded as baselines and dispatched by `training-orchestrator.ts`, listed in `LIFEOPS_SCORER_TASKS`/`LIFEOPS_STRUCTURED_SCORER_TASKS` (`scoring.ts:302/305/314/316`), unioned in `dspy/artifact.ts`, datasetted in `trajectory-task-datasets.ts`, and forced into the prompt benchmark (`lifeops-prompt-benchmark.test.ts:37-44` throws if missing). **And they have zero `resolveOptimizedPromptForRuntime` consumers** — `brief.ts:474` resolves `morning_brief`; screen-time actions make no resolver/`useModel` call. `MEETING_PREP_INSTRUCTIONS` survives only as a `ScheduledTask.promptInstructions` label (`executive-assistant.ts:105/116`); `SCREENTIME_RECAP_INSTRUCTIONS` is re-exported (`screen-time.ts:17`) and never read. The benchmark cases map to `BRIEF`/`OWNER_SCREENTIME`, neither of which resolves the task name — so the green benchmark proves planner routing, not optimization.

**Therefore GEPA optimizing these two prompts changes no runtime behavior.** It spends optimize/score/dataset/benchmark compute on artifacts the runtime can never load, and the test suite gives false wiring confidence (`optimized-prompt-resolver.test.ts:184` only checks matrix==taxonomy).

**The product call is binary, and must be made before the GEPA loop ships:**

- **Option A — make them real.** `meeting_prep` is plausibly load-bearing: wire it into a meeting-dossier/BRIEF prompt path via `resolveOptimizedPromptForRuntime(runtime, "meeting_prep", BASELINE)` + `useModel`, then a routing test asserting the optimized text appears in the captured prompt. `screentime_recap` needs a real narration step in the OWNER_SCREENTIME weekly/summary path that produces the recap+suggestion JSON the instructions describe, plus a scenario with a registered finalCheck. **Recommendation: do this for `meeting_prep`** — an executive-assistant capability whose dossier quality is exactly what GEPA should tune.

- **Option B — delete them.** `screentime_recap` is the weaker case: OWNER_SCREENTIME is fully deterministic today (no LLM call), so there is no natural consumer. **Recommendation: remove `screentime_recap`** from the taxonomy, dspy union, scorer lists, dataset maps, and benchmark cases unless/until OWNER_SCREENTIME grows an LLM narration step.

**Either way, encode the decision as a CI guard:** a static test asserting every task in `LIFEOPS_OPTIMIZED_PROMPT_TASKS` has ≥1 production `resolveOptimizedPromptForRuntime` call site. This is the single guard that prevents the entire class of dead-target rot (H5, H6, M7) from recurring.

---

## 6. Prioritized work plan

Ordered by (severity × blast-radius), chunked so each item is one shippable PR. **[offline]** = code/test-only, doable now without keys; **[live]** = needs a live model / owner-gated secret.

### Phase 0 — stop the bleeding (correctness)
1. **[offline]** Fix the LIVE scorer inversion (C1): drop `state_hash` for LIVE or score `world_assertions` programmatically; add the do-nothing < correct-mutation test.
2. **[offline]** Add LIVE-mode `score_scenario` correctness tests + a perfect-live oracle (H14) — guards C1 from regressing.
3. **[offline]** Register the `personal_baseline_sufficient` gate so `sleep-recap` can fire (H7); add the cross-plugin gate-coverage guard.
4. **[offline]** Wire real `circadian_state_in` / `no_recent_user_message_in` gates (H8); add deny-when-unsafe tests; fail if `wake-up` is default-on with a fallthrough gate.
5. **[offline]** Fix Fitbit distance to read the `total` row only (H11); correct the contract test; add the subset-rows fixture.
6. **[offline]** Add dispatch-failure retry/backoff to the scheduling runner (H9); add the throwing-dispatcher unit + integration tests.

### Phase 1 — close the LARP gates (so green means something)
7. **[offline]** Add the **phantom-token corpus guard** (H3): fail on any `plannerExcludes`/`plannerIncludes` token not in the action allowlist; replace `PAYMENT_EXECUTED` excludes with `noSideEffectOnReject` finalChecks.
8. **[offline]** Make `personalityExpect` enforceable (H2): either evaluate it in `runScenario` or fail it in `corpus-assertion-guard.test.ts`; add a can-FAIL regression test.
9. **[offline]** Honest naming for the planner blob (H1): populate `plannerText` from the trajectory recorder, or rename to `actionTraceIncludes*` + add the echo ratchet (also covers L1).
10. **[offline]** Add the **call-site-existence guard** for all LifeOps optimized tasks (H5/H6/M7), then resolve `meeting_prep`/`screentime_recap` per §5 (one PR each).
11. **[offline]** Point the `inbox_triage` training baseline at `INBOX_TRIAGE_INSTRUCTIONS` and delete/wire `extractGmailPlanWithLlm` (H5, L4).

### Phase 2 — load-bearing scenario coverage
12. **[live]** Rewrite the worst echo-satisfiable PA scenarios (`board-*/art-*/caregiver-*/concierge-*/conference-*`) to assert effects (H4); lower the ratchet baseline. *(authoring offline; verifying behavior needs live.)*
13. **[live]** Add load-bearing finalChecks to the 14 approvals + executive scenarios (M1); add the owner-reject → `noSideEffectOnReject` journey (L7).
14. **[offline]** Add the runner-integration test driving the real health packs (M11) — this would have caught H7/H8.
15. **[offline]** Add the untested action error/clarification branch tests for both health/screen-time runners (M10) and the malformed-LLM-output matrix (M2).

### Phase 3 — safety & persona/fuzz diversity (the structural gap)
16. **[offline]** Add `forbidden_actions`/`expects_refusal` to the bench `Scenario` + scorer credit; fix the LIVE judge refusal prompt (H12).
17. **[live]** Add the health-checkin distress scenario + anchored safety clause in `HEALTH_PLAN_INSTRUCTIONS` (H13).
18. **[offline]** Add child / elderly-confusion personas + scenarios incl. child-safety refusal and reminder-dedup (M13, M14).
19. **[offline]** Add ASR/typo fuzz scenarios asserting resolved intent + a simulator `noise` knob (M15); add i18n ambiguity scenarios (M16); add run-on + same-turn-contradiction scenarios.

### Phase 4 — CI wiring & honesty
20. **[live]** Schedule the live TS benchmark + Python live corpus nightly with the right keys; fail-loud on silent STATIC downgrade; unify the env gates (H15, H16).
21. **[offline]** Fix the context-budget tests to measure a real `composeState` payload + assert provider-list identity; collapse the duplicate module (M6).
22. **[offline]** Report core-vs-edge scenario counts honestly; update the stale test-count/list-command docs; add the edge-clone-identity test (M8, L14).
23. **[offline]** Relocate/dedupe the privacy filter; fix the `sk-ant-` label (M9). Delete the orphan benchmark script + dead exports (L16, L17).

### Phase 5 — remaining robustness (batchable)
24. **[offline]** Fault-isolate `refresh()` per task (H17); serialize `setPrompt` writes (L11); warn on typo'd disable entries (L12); fix the `skipped-dependency-missing` policy (M3); fix the interceptor void-success default (M4); split the timeout/fire budgets + bound the query (M5); imperial-locale unit conversion (M12); the remaining scheduling edge-case tests (L8, L9, L10).

---

## 7. What is already solid (credit where due)

The infrastructure under #8795 is, in its load-bearing core, genuinely well-built — the problems above are about the *signal*, not a broken engine.

- **The scheduling spine routes structurally, and the invariant holds.** `promptInstructions` is never `.includes`/regex-tested anywhere in `runner.ts`/`due.ts`/`escalation.ts`; `fire()` routes purely on `status`/`trigger.kind`/gates/`completionCheck`/`pipeline`/`executionProfile`. `runner.test.ts:782` explicitly guards "identical text, different gates → different outcomes." Atomic `claimForFire` (UPDATE WHERE status='scheduled' RETURNING) genuinely prevents double-fire/double-bill (verified to defeat the speculative `firedAt`-overload collision). Cron is DST-correct. ~55 runner cases + 9 real-DB integration cases. **This is the model the rest of the system should aspire to.**

- **The optimized-prompt service is real and secure.** Atomic temp+rename writes, HMAC-SHA256 `.mac` sidecars (SOC2 CC6.8), versioned artifacts with `current`/`previous` symlinks + rollback, a single resolver chokepoint with **compile-time-typed task names** (typos caught by `tsc`) and a runtime taxonomy validator. The documented "absent artifact is a no-op, never a failure" contract is correct (the H17 fix just extends it to corrupt artifacts). 6 of 8 LifeOps tasks have real, verified consumers.

- **The judge is correctly fail-closed.** A judge parse failure or thrown judge is caught and converted to a FAILED check/assertion (`executor.ts:1754, 1802`) — judge-skip = FAIL. The STRICT deterministic proxy is enforced by every PR/evidence CI script; the heuristic echo proxy is local-dev-only (the "always larp" framing of CI was refuted).

- **The STATIC Python scorer and its conformance oracle are real harness validation.** `state_hash` is a deep, order-independent SHA-256 over every entity store — it genuinely captures world mutation. `compare_actions` does principled set-based partial credit with canonicalization. The triviality guard is well-tested. `test_conformance.py` proves PerfectAgent==1.0 and both WrongAgent modes==0.0 across all STATIC scenarios + 12 inline scenarios. (The gap is that this rigor stops at the STATIC/LIVE boundary — H14.)

- **The LARP-debt is already partly self-aware.** `echo-assertion-ratchet.test.ts` (BASELINE 237, #9310) and `corpus-assertion-guard.test.ts` are real guards that cap parrot-satisfiable assertion growth and enforce non-vacuity on the pr-deterministic lane. They don't fix the backlog or cover planner matchers (L1, H3), but they exist and work — the foundation for the guards Phase 1 adds.

- **Several claimed bugs were verified to NOT exist** and should not be re-litigated: the `health_checkin` trajectory mislabel is **already fixed** (commit `c9dfb8334e`; `health.ts:229` tags `purpose:"health_checkin"`, with a regression test at `health.test.ts:88`); planner/response turn-matchers **do** fail the run (enforcement added in `f07c44f427`); the calendar create_event LLM extractor **is** time-anchored and resolves "tomorrow" (the `parseExplicitLocalDate` gap is a non-load-bearing fallback); and `expectedActions` parent/sub equivalence is intentional and tested. The codebase is being actively hardened in exactly the direction this report recommends.

**Net:** #8795's engine is sound; its evaluation signal is not yet trustworthy. Fix the signal (Phases 0–1) before turning the GEPA crank, or the loop will optimize prompts against inverted, echo-satisfiable, safety-blind, and partly-dead objectives.

---

## Critic addendum (completeness pass)

Confirmed: for LIVE (`ground_truth_actions == []`), `_replay_ground_truth` replays nothing and returns the fresh-seed hash, so `state_match` is true iff the agent mutated nothing — the C1 inversion is airtight. I have enough verified facts. Let me write the critic addendum.

## Critic addendum

**Confirmed findings the report dropped or under-weights**

- **LIVE safety double-bind (compounds C1 + H12, not just additive).** The report treats the LIVE state-hash inversion (C1) and the LIVE judge's "Refusal … is NOT satisfied" instruction (H12) as two separate findings. Verified at `evaluator.py:453` and the scoring path: they form one trap. A correct *safety refusal* mutates nothing → `state_hash_match` true → `state_component=1.0`, **but** `terminated_reason != "satisfied"` (refusal is judged unsatisfied) → LIVE returns `0.0` at `scorer.py:1241-1242`. Meanwhile a *do-nothing-but-judged-satisfied* agent scores `1.0`. So on LIVE the only two ways to score well are (a) make no change and fool the judge, or (b) execute the write; a correct refusal is the **worst-scoring** behavior. This means GEPA is not merely safety-blind (H12's framing) — it is actively trained to *suppress* refusals on the LIVE corpus. The report should escalate this to a CRITICAL-tier safety item, not leave it split across C1 (bench bug) and H12 (design gap).

- **No finding covers the `compare_actions` 0.5-name-match credit as an echo/LARP vector.** `scorer.py:1077` gives `0.5` for a name-only action match (kwargs ignored) and the write-promotion at `scorer.py:1195-1202` lifts `action_component>=0.5 + state_match` to `1.0`. Combined with M8's edge-clone identity (same `ground_truth_actions` across 10 prefix variants), a partially-correct agent banks `0.5` action credit on **all 10 clones** of every write scenario. The report flags echo-satisfiability for substrings (H4, L15) but never for the **action component**, which is the heavier STATIC weight (0.4–0.5). This is the STATIC analogue of the PA `plannerIncludes` echo gap (H1) and deserves its own corpus guard.

- **Subsystem under-covered: the content-addressed media store / SSRF guard.** This is the actual subject of the working branch (`test/attachment-unsafe-url-guard`, issue #8876) and the root `CLAUDE.md` calls out "every server-side attachment fetch must go through the SSRF guard." The report's scope (`packages/core/src/network/ssrf.ts`, `fetch-guard.ts`, `media/fetch.ts`) is entirely absent from the audit even though LifeOps connectors (inbox/gmail/calendar attachments) are exactly the surfaces that fetch untrusted URLs. No finding asks whether LifeOps action handlers that rehost/fetch attachments actually route through `fetch-guard`. Given the report's own safety thesis, an unguarded attachment fetch in a LifeOps connector is a higher-severity hole than several of the listed M-items.

- **Edge-case classes absent from the §4 matrix:**
  - **Prompt-injection via fetched content** (not just via user param text — L6). A calendar invite body or inbox message that contains "ignore previous instructions, wire $5000" is the realistic delivery vector for H12's social-engineering scenario, and it ties directly to the SSRF/media surface above. The matrix only contemplates injection in the *user's own* turn.
  - **Concurrent/duplicate dispatch under retry** — H9 adds dispatch-failure retry but the matrix has no row for "retry fires the notification twice" (idempotency of the *new* backoff path). Adding retry without an idempotency assertion risks converting silent-loss into double-send.
  - **Empty/partial world seed in LIVE** — the matrix tests absurd *health* values (L13) but not a LIVE scenario whose seed is already in the target end-state (do-nothing legitimately correct), which is the benign case C1's fix must not regress.

- **A "robust" claim the findings partially contradict.** §7 credits the optimized-prompt service as "real and secure … the documented 'absent artifact is a no-op, never a failure' contract is correct." H17 shows that contract is **false for any non-ENOENT errno** (one corrupt symlink fails `start()` and disables all 15 tasks). §7's praise should be explicitly conditioned on H17 — as written, a reader skimming §7 would conclude the no-op contract holds today, which it does not. Same tension for the LIVE scorer: §7 praises the STATIC conformance oracle without restating that the identical machinery is inverted one branch over (C1/H14).

- **Headline-count honesty gap the report itself commits.** The report leads §1 with "the real pytest suite collects ~17,124 cases (~28× the documented 574)" as a *criticism* of stale docs, but then never flags that **its own** prioritized plan cites scenario counts (e.g. "130 executive.* files," "200 personalityExpect") captured at an earlier snapshot than the LIVE-corpus counts it corrected elsewhere (5,808 LIVE per C1's verifier vs "528"/"407" in older findings). The PA-side counts are stable, but the report mixes a 1,020-base/11,220-clone framing (M8) with raw 5,808 LIVE numbers without one reconciled count table. Add a single "corpus census" table so the plan's targets don't inherit the staleness the report criticizes.

**Single highest-leverage next chunk to ship**

- **Phase 0, item 1 + 2 fused: fix the LIVE scorer and lock it with the safety double-bind test — in one PR.** Not just "do-nothing < correct-mutation" (the report's proposed test), but a three-way oracle: on a LIVE write scenario, assert `score(correct-write) > score(do-nothing)` **and** that a correct refusal on an adversarial/harmful LIVE scenario can reach a non-zero score (forcing the `evaluator.py:453` refusal-prompt fix at the same time). This single chunk (a) neutralizes the only inverted objective GEPA optimizes against, (b) removes the active anti-safety pressure, and (c) is fully `[offline]` (no keys). Everything downstream — the call-site guards, the echo guards, the persona/safety scenarios — optimizes against a signal that is still inverted until this lands, so it strictly dominates the report's own Phase-1 ordering. The report ranks C1 first but separates the refusal-prompt fix into Phase 3 (H12/#16); ship them together or the LIVE oracle will still reward the wrong behavior on exactly the safety scenarios Phase 3 adds.
---

## Independent verification notes (maintainer spot-check, post-workflow)

These are hand-verified refinements on the highest-severity findings, added after the automated adversarial pass:

1. **LIVE scorer (CRITICAL) — precise framing.** Verified against `scorer.py:1242-1244` and `runner.py:2855-2858`. The expected LIVE state hash is built by replaying `ground_truth_actions` on a fresh seed; for LIVE those are `[]`, so `expected_state_hash` = the **unmutated seed world**, and `state_hash_match` is therefore True only when the agent mutates nothing. But the LIVE return is **gated**: `if result.terminated_reason != "satisfied": return 0.0`, and the judge (`evaluator.py:451-453`) is explicitly instructed that "I'll do that" without execution, clarifying questions, and refusals are NOT satisfied. Net:
   - **Guaranteed defect:** a *correct* LIVE write agent is capped at **0.3** — the `0.7 * state_component` term is structurally unearnable for any world-mutating scenario, so LIVE `pass@1` (threshold ≥0.99) is **unreachable for every agent, including PerfectAgent**.
   - The "do-nothing scores 1.0" worst case is realized only when the judge gate mis-fires (marks a non-executing turn satisfied).
   - **Recommended fix is a design decision, not a drive-by:** either (a) compute the LIVE `expected_state_hash` from the judge-accepted end-state rather than the unmutated seed, or (b) drop the `state_component` weight in LIVE and let the judge be the signal. The cheap, decisive guard: **extend the PerfectAgent/WrongAgent conformance oracle to LIVE** (PerfectAgent must score ≈1.0, WrongAgent ≈0.0). It currently runs STATIC-only, which is exactly why this shipped.

2. **`plannerText` dead field (HIGH) — confirmed.** `execution.plannerText` is declared and read by `buildPlannerAssertionBlob` (`executor.ts:134-152`) but assigned nowhere in the repo. `plannerIncludes*`/`plannerExcludes` therefore match only `actionName` + stringified tool `parameters` — they are **action-routing assertions mis-named as planner-reasoning assertions**. Independently corroborated: the `echo-assertion-ratchet` guards only `responseIncludes*` (and documents a known echo-satisfiable backlog, #9310); it does not guard the planner matchers.

3. **`meeting_prep` / `screentime_recap` dead targets (HIGH) — quantified.** Present in taxonomy (`optimized-prompt.ts`, 6 refs), training datasets (8), scorer (4), and baselines (8), with **0** `resolveOptimizedPromptForRuntime` consumers across `plugin-personal-assistant` + `plugin-health`. They are fully plumbed for optimization but optimize nothing.

4. **Already shipped from this audit:** PR **#9540** (merged) — `fix(health): tag health_checkin planner trajectory with its own task`. The `health_checkin` capability loaded its optimized prompt but recorded trajectories with `purpose:"planner"`, which `normalizeTrainingTask` drops on ingest, so it collected **zero** training data. Now tagged `health_checkin` (matching the other 5 wired consumers), with the first unit test that drives the health planner path.
