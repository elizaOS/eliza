# #11381 actionCalled-only paydown, scenario effect assertions

## Scope

- Added shared CALENDAR scenario assertions in `packages/test/scenarios/_helpers/calendar-assertions.ts`.
- Converted seven oldest `packages/test/scenarios/calendar/*.scenario.ts` files from `actionCalled`-only final checks to custom checks that inspect successful CALENDAR result data or post-action payload.
- Converted four deterministic scenario-runner fixtures from `actionCalled`-only final checks to custom checks that inspect action result payloads.
- Converted five cross-cutting/social/reminder scenarios from `actionCalled`-only final checks to custom checks that prove either no forbidden side effect occurred or the produced reply/result had the expected effect shape.
- Converted four self-control scenarios from `actionCalled`-only final checks to custom checks that prove either no block was created before confirmation/after refusal or the block payload carried the confirmed target and context.
- Converted the remaining direct scenario offenders in lifeops habits/hygiene, self-control, relationships, remote, and cloud-apps to custom checks that inspect structured CHECKIN/relationship/remote/cloud action data or prove no forbidden side effect occurred.
- Lowered `packages/scenario-runner/src/action-effect-ratchet.test.ts` baseline from the post-rebase upstream value of 25 to 0.

## Commands Run

```text
bun install
git fetch origin develop
git rebase origin/develop
bunx biome check --write packages/test/scenarios/_helpers/calendar-assertions.ts packages/test/scenarios/calendar/calendar.cancel.simple.scenario.ts packages/test/scenarios/calendar/calendar.create.with-prep-buffer.scenario.ts packages/test/scenarios/calendar/calendar.reminder.10min-before.scenario.ts packages/test/scenarios/calendar/calendar.reminder.1hr-before.scenario.ts packages/test/scenarios/calendar/calendar.reminder.on-the-dot.scenario.ts packages/test/scenarios/calendar/calendar.reschedule.conflict-detection.scenario.ts packages/test/scenarios/calendar/calendar.reschedule.simple.scenario.ts packages/scenario-runner/src/action-effect-ratchet.test.ts
bunx biome check --write packages/scenario-runner/src/action-effect-ratchet.test.ts packages/test/scenarios/cross-cutting/cross.ambiguity.agent-asks-clarifying-question.scenario.ts packages/test/scenarios/cross-cutting/cross.multi-turn.memory-across-turns.scenario.ts packages/test/scenarios/cross-cutting/cross.negative.question-calls-no-action.scenario.ts packages/test/scenarios/reminders/reminder.alarm.sets-macos-alarm.scenario.ts packages/test/scenarios/selfcontrol/selfcontrol.block-websites.followup-after-detour.scenario.ts packages/test/scenarios/selfcontrol/selfcontrol.self-set-enforcement.ask-before.scenario.ts packages/test/scenarios/selfcontrol/selfcontrol.self-set-enforcement.enforces-yes.scenario.ts packages/test/scenarios/selfcontrol/selfcontrol.self-set-enforcement.respects-no.scenario.ts packages/test/scenarios/social.x/x.refuse-banworthy-action.scenario.ts
bunx biome check --write packages/scenario-runner/src/action-effect-ratchet.test.ts packages/scenario-runner/test/scenarios/cloud-apps-read-core.scenario.ts packages/test/scenarios/lifeops.habits/habits.week-spanning-behavior.scenario.ts packages/test/scenarios/selfcontrol/selfcontrol.integration-with-todos.auto-block.scenario.ts packages/test/scenarios/relationships/rolodex.update-notes.scenario.ts packages/test/scenarios/relationships/rolodex.search.scenario.ts packages/test/scenarios/relationships/relationships.status-goals.set.scenario.ts packages/test/scenarios/remote/remote.pair.local-no-code.scenario.ts packages/test/scenarios/remote/remote.sso-cloud.gmail-login.scenario.ts packages/test/scenarios/remote/remote.mobile-controls-mac.scenario.ts
bunx biome check --write packages/test/scenarios/lifeops.hygiene/hygiene.brush-teeth-streak-recovery.scenario.ts packages/test/scenarios/lifeops.habits/habits.week-spanning-behavior.scenario.ts packages/scenario-runner/test/scenarios/cloud-apps-read-core.scenario.ts packages/scenario-runner/src/action-effect-ratchet.test.ts
bunx @biomejs/biome check --config-path biome.json --vcs-enabled=false --files-ignore-unknown=true --no-errors-on-unmatched $(git diff --name-only origin/develop...HEAD | rg '\.ts$')
bun test packages/scenario-runner/src/action-effect-ratchet.test.ts
bun run generate:action-search-keywords
bun run --cwd packages/scenario-runner typecheck
bun run verify
SCENARIO_USE_LLM_PROXY=1 SCENARIO_LLM_PROXY_STRICT=1 bun --conditions eliza-source --tsconfig-override tsconfig.json packages/scenario-runner/src/cli.ts run packages/scenario-runner/test/scenarios --scenario deterministic-gitpathology-actions --report-dir .github/issue-evidence/11381-actioncalled-paydown-2/deterministic-runs --run-dir .github/issue-evidence/11381-actioncalled-paydown-2/deterministic-runs
SCENARIO_USE_LLM_PROXY=1 SCENARIO_LLM_PROXY_STRICT=1 bun --conditions eliza-source --tsconfig-override tsconfig.json packages/scenario-runner/src/cli.ts run packages/scenario-runner/test/scenarios --scenario deterministic-browser-computeruse-progress --report-dir .github/issue-evidence/11381-actioncalled-paydown-2/deterministic-runs-deterministic-browser-computeruse-progress --run-dir .github/issue-evidence/11381-actioncalled-paydown-2/deterministic-runs-deterministic-browser-computeruse-progress
SCENARIO_USE_LLM_PROXY=1 SCENARIO_LLM_PROXY_STRICT=1 bun --conditions eliza-source --tsconfig-override tsconfig.json packages/scenario-runner/src/cli.ts run packages/scenario-runner/test/scenarios --scenario deterministic-computeruse-progress-approvals --report-dir .github/issue-evidence/11381-actioncalled-paydown-2/deterministic-runs-deterministic-computeruse-progress-approvals --run-dir .github/issue-evidence/11381-actioncalled-paydown-2/deterministic-runs-deterministic-computeruse-progress-approvals
SCENARIO_USE_LLM_PROXY=1 SCENARIO_LLM_PROXY_STRICT=1 bun --conditions eliza-source --tsconfig-override tsconfig.json packages/scenario-runner/src/cli.ts run packages/scenario-runner/test/scenarios --scenario deterministic-computeruse-parity-verbs --report-dir .github/issue-evidence/11381-actioncalled-paydown-2/deterministic-runs-deterministic-computeruse-parity-verbs --run-dir .github/issue-evidence/11381-actioncalled-paydown-2/deterministic-runs-deterministic-computeruse-parity-verbs
```

## Results Reviewed

Post-rebase validation was run at branch head `0528306475277e589ee3c514bf0eddb8ec36c708`, rebased onto `origin/develop` `b17e23500c8491e3191abfb0d1cf8f000959de6e`.

```text
bun test packages/scenario-runner/src/action-effect-ratchet.test.ts

2 pass
0 fail
does not grow actionCalled-only scenarios beyond 0
```

After rebasing onto current `origin/develop`, the remaining direct scenario actionCalled-only count is 0. I manually reviewed the final focused ratchet failure at baseline 0 before the last conversion; it surfaced one additional literal-only offender, `packages/test/scenarios/lifeops.hygiene/hygiene.brush-teeth-streak-recovery.scenario.ts`, because the existing `judgeRubric(...)` helper is not statically visible to the ratchet. That scenario now also has a literal custom effect check.

`git diff --check` passed after the rebase and deterministic evidence refresh.

`bunx @biomejs/biome check --config-path biome.json --vcs-enabled=false --files-ignore-unknown=true --no-errors-on-unmatched $(git diff --name-only origin/develop...HEAD | rg '\.ts$')` checked all 32 changed TypeScript files and passed with no fixes applied.

Deterministic scenario reports were regenerated after the rebase and manually spot-reviewed:

- `deterministic-browser-computeruse-progress`: run `52c3d174-9ae6-4208-8f10-7d6816ce6566`, passed 1/1 from `2026-07-03T01:17:19.117Z` to `2026-07-03T01:17:26.972Z`; final check `browser-computeruse-progress-results`; report contains BROWSER screenshot result data, COMPUTER_USE_AGENT `reason: "finish"` trajectory, and COMPUTER_USE click result text.
- `deterministic-computeruse-progress-approvals`: run `1b48981e-2407-4b9a-93ba-65c4d9a4beef`, passed 1/1 from `2026-07-03T01:17:19.151Z` to `2026-07-03T01:17:26.840Z`; final check `computeruse-approval-flow-results`; report contains the approval prompt action result and approval resolution payload for `approval_123_abc`.
- `deterministic-computeruse-parity-verbs`: run `29392477-7ee9-48ef-b2da-0ee1da4766ff`, passed 1/1 from `2026-07-03T01:17:19.224Z` to `2026-07-03T01:17:27.144Z`; final check `computeruse-parity-result-shapes`; report contains set_value text, kill_app result data with `killed: true`, and WINDOW bounds `1216x808` at `(256, 102)`.
- `deterministic-gitpathology-actions`: run `c5edf5de-23bb-4c75-9ef2-cef395592f6d`, passed 1/1 from `2026-07-03T01:15:42.010Z` to `2026-07-03T01:15:50.875Z`; final check `gitpathology-list-empty-cache-result`; report contains `reports: []`, the empty-cache result text, and two finished trajectory JSON artifacts under `deterministic-runs/trajectories/`.

`bun run --cwd packages/scenario-runner typecheck` did not reach this change. After regenerating i18n keyword data, it failed on unrelated workspace package/export prerequisites missing from the disposable worktree, beginning with:

```text
src/executor.ts: Cannot find module '@elizaos/plugin-blocker/services/website-blocker/index'
src/final-checks/index.ts: Cannot find module '@elizaos/plugin-personal-assistant/lifeops/service'
src/runtime-factory.ts: Cannot find module '@elizaos/plugin-scheduling'
```

The post-rebase rerun also reported broader upstream/workspace export drift outside this change, including missing `@elizaos/shared/steward-session-client`, `@elizaos/shared/transcripts`, `@elizaos/shared/local-inference`, and `@elizaos/capacitor-bun-runtime` imports from `packages/ui` and `plugins/plugin-local-inference`.

`bun run verify` failed before typecheck/lint in the repo-wide type-safety ratchet:

```text
[type-safety-ratchet] as unknown as: 79 / 75
[type-safety-ratchet] unsafe cast baseline exceeded
```

## Evidence Matrix

- Real LLM trajectories: N/A in this environment for the live-only scenario conversions. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `CEREBRAS_API_KEY`, and `EVAL_MODEL_PROVIDER` were unset. Deterministic scenario-runner reports were captured for the four deterministic fixture conversions listed above.
- Backend logs: N/A, no runtime/server path changed.
- Frontend logs/screenshots/video: N/A, no UI changed.
- Domain artifacts: ratchet artifact is the scenario-corpus count dropping from the post-rebase upstream value of 25 to 0, verified by the focused ratchet test above, deterministic scenario reports, and manual review of the final zero-offender scan.
