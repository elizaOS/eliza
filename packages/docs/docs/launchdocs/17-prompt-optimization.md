# Launch Readiness 17: Prompt Optimization

## Second-Pass Status (2026-05-05)

- Current: prompt source drift remains real; source prompt files do not fully match generated core prompts, and planner/response scoring still mixes older XML/action-name expectations with TOON-era prompts.
- Still open: explicit TOON encapsulation, same-timestamp optimized-prompt tie-breaking, token efficiency budgets, planner `params` scoring, and dataset contamination checks need tests.
- Launch gate: training-focused tests cover pieces, but no held-out prompt-quality/effectiveness gate proves the optimized prompts are launch-ready.

## Current state

The prompt stack has meaningful launch hardening in place: the generated core prompts are TOON-oriented, planner outputs are schema-validated, malformed planner outputs have repair paths, and bounded prompt-optimization tests pass locally. The main runtime path also has several guardrails for action/provider name repair, missing parameter repair, metadata-action rescue, and prevention of speculative tool calls.

The optimization system is not yet aligned end-to-end. The source prompt files under `packages/prompts/prompts/` lag the generated `packages/core/src/prompts.ts`, the automated optimizer primarily targets `action_planner` while the hot single-turn planner resolves task `response`, and the available benchmark-derived planner dataset appears to be XML-era data rather than current TOON-style planner data. Token and prompt-efficiency metrics are also partial: the agent wrapper can enrich trajectory token usage, but core trajectory logging still does not consistently record prompt/completion tokens.

## Evidence reviewed with file refs

- `packages/core/src/prompts.ts:456` defines the generated `messageHandlerTemplate`. It includes launch-critical planner rules for provider usage, uploaded files, live status queries, durable future-condition tasks, workflow selection, avoiding adjacent tools, and TOON-only output.
- `packages/core/src/prompts.ts:519` defines `multiStepDecisionTemplate`. It tells the model to use runtime action/provider names and return TOON, but its example omits `params` even though the runtime schema accepts `params`.
- `packages/core/src/prompts.ts:1039` and `packages/core/src/prompts.ts:621` define TOON-oriented should-respond and post-action prompts.
- `packages/prompts/prompts/message_handler.txt:1` is stale versus the generated `messageHandlerTemplate`; it has fewer rules and lacks several launch-critical action-selection constraints.
- `packages/prompts/prompts/multi_step_decision.txt:1` is stale versus generated code and lacks newer runtime-surface constraints.
- `packages/core/src/services/message.ts:5600` runs the primary planner through `dynamicPromptExecFromState` using task `response`, `messageHandlerTemplate`, and `preferredEncapsulation: "xml"` despite the generated prompt saying TOON-only.
- `packages/core/src/services/message.ts:5701` parses planner actions/providers and repairs canonical names.
- `packages/core/src/services/message.ts:5890` adds rescue passes when a passive reply likely should have been a grounded action.
- `packages/core/src/services/message.ts:6202` validates required action params and asks a repair model for missing/invalid params.
- `packages/core/src/services/message.ts:6688` runs the multi-step planner with optimized task `action_planner` and `preferredEncapsulation: "toon"`.
- `packages/core/src/runtime.ts:5605` chooses the structured output format. It handles forced JSON/XML and `preferredEncapsulation: "xml"`, but does not explicitly honor `preferredEncapsulation: "toon"`.
- `packages/core/src/runtime.ts:5720` appends stable format instructions and schema examples to rendered prompts.
- `packages/core/src/runtime.ts:6150` records optimization trace metadata. `tokenEfficiency` is based on a fixed 500-token output reference rather than a task-specific budget.
- `packages/core/src/runtime.ts:4613` logs model calls with prompts/responses, but core trajectory LLM-call logging at `packages/core/src/runtime.ts:5069` and `packages/core/src/runtime.ts:5175` does not pass prompt/completion token counts.
- `packages/agent/src/runtime/prompt-optimization.ts:820` compacts large prompts, applies prompt budgets, and enriches trajectory token usage when provider events expose usage.
- `packages/agent/src/runtime/prompt-compaction.ts:94` performs keyword-based intent detection and action compaction. Comments around `packages/agent/src/runtime/prompt-compaction.ts:316` note possible non-English parameter stripping.
- `packages/core/src/utils.ts:612` and `packages/core/src/utils/toon.ts:1` provide TOON-first parsing/encoding support.
- `packages/core/src/utils/prompt-compression.ts:1` only collapses whitespace and truncates descriptions to 160 characters.
- `packages/core/src/action-docs.ts:19` stores compressed action/parameter descriptions.
- `packages/core/src/actions.ts:253` formats action surfaces using full descriptions and parameter descriptions in the reviewed path, not the compressed descriptions.
- `packages/core/src/services/optimized-prompt.ts:1` loads optimized prompt artifacts from `~/.eliza/optimized-prompts/<task>/`.
- `packages/core/src/services/optimized-prompt.ts:323` chooses the newest artifact by `generatedAt`; the file header documents an mtime tie-break, but the reviewed implementation does not implement that tie-break.
- `packages/core/src/services/optimized-prompt-resolver.ts:28` resolves optimized prompts and injects few-shot examples when present.
- `plugins/app-training/src/core/trajectory-task-datasets.ts:154` classifies planner examples from hints and output shape.
- `plugins/app-training/src/core/trajectory-task-datasets.ts:209` infers `action_planner` from broad hints including `action` and `runtime_use_model`, which may over-include non-planner model calls.
- `plugins/app-training/src/optimizers/scoring.ts:76` scores action-planner outputs by exact match on the first action name only.
- `plugins/app-training/src/core/training-orchestrator.ts:354` uses `multiStepDecisionTemplate` as the baseline for `action_planner`.
- `plugins/app-training/src/services/training-trigger.ts:503` auto-bootstraps only `should_respond` and `action_planner`.
- `scripts/benchmark-to-training-dataset.mjs:1` converts action benchmark trajectories to planner JSONL.
- `scripts/optimize-action-planner.mjs:1` runs native planner optimization over that benchmark dataset.
- The stale checked-in benchmark-derived planner JSONL was removed from
  `plugins/app-training/datasets/`; current training data should come from
  `eliza_native_v1` trajectory exports.
- `packages/app-core/action-benchmark-report.md:1` reports action-selection benchmark accuracy of 96.2% planner/selection accuracy and 70.5% execution accuracy.
- `test_output/terminal-bench-20260503_080436.md:1` contains a terminal-bench artifact with 2 tasks, 0 passed, 0 commands, and 0 tokens, so it is not useful evidence for prompt optimization quality.

## What I could validate

- Ran `bunx vitest run src/__tests__/prompt-compression.test.ts src/__tests__/optimized-prompt-service.test.ts src/__tests__/planner-preamble.test.ts` in `packages/core`: 3 files, 24 tests passed.
- Ran `bunx vitest run src/runtime/prompt-optimization.test.ts src/runtime/aosp-llama-adapter.test.ts` in `packages/agent`: 2 files, 30 tests passed.
- Ran `bunx vitest run test/training-trigger.test.ts` in `plugins/app-training`: 1 file, 17 tests passed.
- Verified that optimized prompt service behavior, prompt-budget preservation,
  token usage enrichment, and planner preamble tests have bounded coverage.
- Verified the checked-in benchmark report records planner/selection success separately from execution success.

## What I could not validate

- I did not run live LLM planner trajectories or replay production logs. That requires provider credentials, stable model routing, and potentially expensive model calls.
- I did not regenerate `packages/core/src/prompts.ts` from `packages/prompts/prompts/`, because this review owns only this report file.
- I did not run the full action-selection benchmark or native prompt optimizer. Those are broader, slower, and likely provider/environment dependent.
- I could not confirm whether all deployed runtimes install the agent prompt-optimization wrapper before trajectory logging. Core-only paths still lack complete token counts.
- I could not validate prompt quality from human trajectory review; the local artifacts show benchmark summaries and examples, but not enough sampled human labels for instruction quality, tool-call precision, or parameter usefulness.

## Bugs/risks P0-P3

### P0

- None found in bounded review.

### P1

- Generated prompt code and source prompt files are out of sync. `packages/core/src/prompts.ts:456` contains many launch-critical planner rules that are absent from `packages/prompts/prompts/message_handler.txt:1`; `packages/core/src/prompts.ts:519` similarly differs from `packages/prompts/prompts/multi_step_decision.txt:1`. A prompt regeneration could silently remove durable-task, provider, workflow, and action-selection rules.
- The optimizer target does not fully match the hot planner path. The primary single-turn planner uses optimized task `response` at `packages/core/src/services/message.ts:5613`, while automated training bootstraps `action_planner` at `plugins/app-training/src/services/training-trigger.ts:503` and uses `multiStepDecisionTemplate` as the `action_planner` baseline at `plugins/app-training/src/core/training-orchestrator.ts:354`. This can make "Optimize action planner" improve the multi-step loop while missing the main planner prompt used for normal messages.

### P2

- Planner optimization scoring is too shallow. `plugins/app-training/src/optimizers/scoring.ts:76` exact-matches the first action name but ignores provider selection, parameter validity, action ordering, `simple`, `text`, execution success, and whether the model used an invalid or stale action surface.
- Trajectory task inference may contaminate planner datasets. `plugins/app-training/src/core/trajectory-task-datasets.ts:209` treats broad hints like `action` and `runtime_use_model` as `action_planner`, which can include action-handler model calls that are not planner decisions.
- Token accounting is incomplete. Core trajectory logging records prompts and responses but not prompt/completion token counts, while agent-level enrichment depends on provider usage events or fallback estimation. This weakens prompt-efficiency optimization and regression detection.

### P3

- `tokenEfficiency` in `packages/core/src/runtime.ts:6176` is based on a fixed 500-token output reference, not task-specific budgets or prompt+completion totals. It is a weak metric for planner prompt efficiency.
- `packages/core/src/services/optimized-prompt.ts:323` does not implement the documented mtime tie-break when two artifacts share `generatedAt`.
- Reviewed action-surface formatting in `packages/core/src/actions.ts:253` uses full descriptions despite compressed descriptions being available through `packages/core/src/action-docs.ts:19`. If this is the active planner surface, TOON/caveman compression is not fully applied to action docs.
- Keyword-based prompt compaction can miss non-English or indirect intents and may strip relevant params, as acknowledged near `packages/agent/src/runtime/prompt-compaction.ts:316`.

## Codex-fixable work

- Synchronize `packages/prompts/prompts/message_handler.txt` and `packages/prompts/prompts/multi_step_decision.txt` with the generated prompt rules, then add a check that generated prompt output does not drift from source prompt files.
- Split prompt optimization tasks so the primary single-turn planner has its own task name, or make the training trigger optimize the actual task used by `messageHandlerTemplate`.
- Regenerate planner optimization data from current `eliza_native_v1`
  trajectories instead of checking benchmark-derived message JSONL into
  `plugins/app-training/datasets/`.
- Expand action-planner scoring to validate providers, params, action order, `simple`, `text`, parse success, and required-parameter validity.
- Tighten trajectory task inference so `runtime_use_model` and generic `action` hints do not classify non-planner calls as planner examples without output-shape confirmation.
- Add token fields to core trajectory LLM-call logging and make prompt-efficiency scoring use prompt+completion tokens with task-specific budgets.
- Add a regression test for optimized prompt artifact tie-breaking when `generatedAt` is equal.
- Verify whether compressed action/parameter descriptions are used in the actual planner action list; if not, route planner formatting through `descriptionCompressed`.

## Human trajectory review needed

- Sample recent failed and successful single-turn planner trajectories separately from multi-step planner trajectories. Confirm whether the selected action/provider was appropriate, whether `params` were complete, and whether the response text matched the user intent.
- Review examples where the model chose `REPLY` or `NONE` despite an available action, especially live-status, file lookup, scheduling, reminder, wallet, GitHub, browser, and terminal requests.
- Review examples where action rescue changed the planner result. Confirm whether rescue improves precision or masks prompt ambiguity.
- Review large action-surface prompts before and after compaction. Confirm that caveman compression does not remove required params, disambiguating similes, or provider-specific constraints.
- Review non-English and indirect-intent prompts, since keyword-based compaction can miss those cases.
- Review stale XML-era benchmark rows before using them for current prompt optimization.

## Recommended evals/metrics

- Planner parse success rate by prompt version and output format.
- Schema-valid planner output rate, including required parameter validity.
- First action accuracy, full ordered action-list accuracy, and provider accuracy.
- Execution-ready rate: selected action exists, required params are present, provider/action dependencies are available, and no repair pass is needed.
- Repair rate split by canonical-name repair, param repair, malformed-output repair, and action rescue.
- `REPLY`/`NONE` false positive and false negative rates for actionable requests.
- Prompt tokens, completion tokens, total tokens, latency, and cost by task (`response`, `action_planner`, `should_respond`, post-action).
- Token savings from TOON/caveman compaction measured against action accuracy and parameter validity.
- Regression slices for uploaded files, live status/current info, durable future-condition tasks, workflow creation, browser/terminal/GitHub/wallet flows, and non-English prompts.
- Dataset quality metrics: planner-label agreement, stale-format rate, duplicate trajectory rate, and contamination rate from non-planner model calls.

## Changed paths

- `launchdocs/17-prompt-optimization.md`
