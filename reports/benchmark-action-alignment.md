# Benchmark ↔ Eliza Action Alignment Audit

**Date:** 2026-05-14
**Scope:** All benchmarks under `packages/benchmarks/` cross-referenced against the canonical eliza `Action` model in `packages/core/src/types/components.ts` and every plugin under `plugins/`.

## Architecture refresher

- **Action shape:** `packages/core/src/types/components.ts:267` — fields: `name`, `description`, `descriptionCompressed`, `parameters[]`, `handler`, `validate`, `examples`, `similes[]`, `tags[]`, `routingHint`, `subActions[]`, `subPlanner`, `contexts[]`, `modelClass`, `cacheStable`.
- **Subactions:** `packages/core/src/actions/subaction-dispatch.ts` defines the canonical discriminator key `action` (legacy aliases: `subaction`, `op`, `operation`, `verb`, `subAction`, `__subaction`).
- **Promotion:** `packages/core/src/actions/promote-subactions.ts` — `promoteSubactionsToActions(parent)` reads the enum off the `action` parameter and returns `[parent, ...virtuals]` where each virtual is named `<PARENT>_<SUBACTION>` and delegates to the parent's handler with the discriminator injected.
- **Tool search / retrieval:** `packages/core/src/runtime/action-retrieval.d.ts` + `action-catalog.ts`. Multi-stage: exact → regex → keyword → BM25 → embedding. Action metadata (`description`, `descriptionCompressed`, `tags`, `similes`, `examples`) populates the index. Promoted virtuals are recorded on `parent.subActions` so retrieval indexes them under the parent rather than ranking each as an unrelated top-level action.

## Bench classification (51 benchmark dirs)

| Category | Examples |
| --- | --- |
| **Own** (Eliza-team-authored) | woobench, lifeops-bench, eliza-1, action-calling, app-eval, interrupt-bench, claw-eval, scambench, configbench, compactbench, voicebench, social-alpha, personality-bench, abliteration-robustness, openclaw-benchmark, qwen-claw-bench, qwen-web-bench, skillsbench |
| **Adapter** | eliza-adapter, hermes-adapter, openclaw-adapter |
| **External** | tau-bench, vending-bench, webshop, OSWorld, voiceagentbench, bfcl, terminal-bench, visualwebbench, evm, solana, HyperliquidBench, agentbench, adhdbench, rlm-bench, gaia, mind2web, mint, mmau/elizaos_mmau, swe-bench-*, etc. |

## Findings — own benchmarks

### woobench
**Status:** misalignment found and **fixed**.

The bench's PAYMENT-action recognizer keyed on `params.op` ("request"|"check"), but the canonical `paymentOpAction` in `plugins/plugin-mysticism/src/actions/payment-op.ts:62-68` declares the discriminator parameter as **`action`** (with legacy `op` accepted as a simile-only alias). Worse, `promoteSubactionsToActions(paymentOpAction)` in `plugins/plugin-mysticism/src/index.ts:55` already produces virtual top-level actions `PAYMENT_CHECK` and `PAYMENT_REQUEST`, but woobench's `CHECK_PAYMENT_COMMANDS` set was missing `PAYMENT_CHECK` (only `PAYMENT_REQUEST` happened to be in the create set).

**Edits applied:**
- `packages/benchmarks/woobench/payment_actions.py` — `detect_payment_check` and `_payment_action_payload` now read `params.action` first, falling back to legacy `op`. Added `PAYMENT_CHECK` to `CHECK_PAYMENT_COMMANDS`.
- Verified with all 5 forms: canonical `action`, promoted `PAYMENT_CHECK`, legacy `op`, legacy command names, text fallback. All 7 existing tests still pass.

### lifeops-bench
**Status:** **gold standard — already aligned.**

`packages/benchmarks/lifeops-bench/manifests/actions.manifest.json` is generated from the live plugin actions via `scripts/lifeops-bench/export-action-manifest.ts`, which calls `actionToTool()` from `@elizaos/core` (so promoted subactions are emitted as separate tool entries). The runner's `_ACTION_HANDLERS` registry includes both the umbrella names (`CALENDAR`, `MESSAGE`, `BLOCK`, `OWNER_FINANCES`) and their promoted children (`CALENDAR_CREATE_EVENT`, `MESSAGE_SEND`, etc.), all routing to the umbrella's handler via the injected discriminator.

**Recommended follow-ups (no edits made):**
1. Add CI step that re-runs the manifest exporter and fails the build if the result drifts.
2. Auto-generate `_ACTION_HANDLERS` from the manifest instead of the current 100-entry hardcoded dict in `runner.py`.
3. Manifest is timestamped 2026-05-12 — regenerate before the next run.

### eliza-1
**Status:** mostly synthetic action names; no immediate action items.

`src/fixtures/planner.json` mixes real core actions (`REPLY`, `MESSAGE`) with fictional ones (`SEND_EMAIL`, `CREATE_REMINDER`, `SCHEDULE_MEETING`, `PUBLISH_POST`, `DELETE_FILE`, `TRANSLATE`, `SET_STATUS`, `SEARCH_WEB`, `CREATE_TASK`, `CREATE_NOTE`). These are intentional probes for parameter extraction quality, not a claim that they exist in the runtime. `ActionFixture` in `src/types.ts:63` is name-agnostic.

**Recommendation:** keep synthetic names (they exercise the planner without coupling to a live plugin) but add a comment in `src/fixtures/planner.json` documenting the split between canonical and synthetic, and consider a parallel `planner.canonical.json` derived from the real `actions.manifest.json` patterns lifeops-bench uses.

### action-calling
**Status:** dataset-driven — no canonical name coupling.

Tool names come from `training/data/native/records/hermes-fc-v1.jsonl`. The benchmark validates a provider's native tool-calling format, not eliza's action catalog. No alignment required.

### app-eval, interrupt-bench
**Status:** task-driven, no action-name coupling.

`app-eval` evaluates app-CLI behavior on free-form prompts; `interrupt-bench` exercises the `ResponseHandlerFieldRegistry` Stage-1 schema fields (`shouldRespond`, `candidateActionNames`, `replyText`, …). Neither requires changes for action alignment.

## Findings — external benchmarks (adapter-side opportunities)

External benches must not have their tool names renamed (would break scoring). Alignment opportunities live entirely on the **eliza adapter side**: register canonical eliza Actions whose `similes` match the bench's tool vocabulary so retrieval and fine-tuning transfer.

| Bench | Adapter file | Current routing | Recommendation |
| --- | --- | --- | --- |
| **HyperliquidBench** | `eliza_agent.py` | Plan-step JSON mirrors Rust schema (perp_orders, cancel_last, cancel_oids, cancel_all, usd_class_transfer, set_leverage, sleep_ms) | **Done.** Added `HYPERLIQUID_PERP_ORDERS`, `HYPERLIQUID_CANCEL_LAST`, `HYPERLIQUID_CANCEL_OIDS`, `HYPERLIQUID_CANCEL_ALL`, `HYPERLIQUID_USD_CLASS_TRANSFER`, `HYPERLIQUID_SET_LEVERAGE` to `PERPETUAL_MARKET.similes` in `plugins/app-hyperliquid/src/actions/perpetual-market.ts:108`. |
| **terminal-bench** | `eliza-adapter/eliza_adapter/terminal_bench.py` | Already recognizes `SHELL`, `RUN_SHELL_COMMAND`, `EXEC` as nested tool names + raw `<command>` extraction. | Optional: capture `cwd`, `timeout`, `description` from SHELL params (matches `plugins/plugin-coding-tools/src/actions/bash.ts:131-175`). Currently dropped because `TerminalEnvironment.execute()` only accepts `command`. |
| **vending-bench** | `eliza-adapter/eliza_adapter/vending_bench.py` | Bench-side JSON parsing of 9 stable verbs (`VIEW_BUSINESS_STATE`, `PLACE_ORDER`, `RESTOCK_SLOT`, `SET_PRICE`, `COLLECT_CASH`, `UPDATE_NOTES`, `CHECK_DELIVERIES`, `ADVANCE_DAY`). | New plugin (`plugin-benchmarks` or fold into `plugin-mysticism` style): `VENDING_MACHINE` action with `subActions` enum matching the 9 verbs. `promoteSubactionsToActions()` then exposes `VENDING_MACHINE_VIEW_BUSINESS_STATE` etc. for retrieval. Adapter unchanged — fine-tune transfer via simile match. |
| **webshop** | `eliza-adapter/eliza_adapter/webshop.py` | Regex parses `search[…]`, `click[…]`, `select_option[…]`, `back`, `buy` from text/`BENCHMARK_ACTION` shapes. | Define `WEBSHOP` action with `subActions: ["search","click","select_option","back","buy"]` and similes `["WEBSHOP_SEARCH","WEBSHOP_CLICK", …]`. Adapter then accepts the canonical action shape in addition to current text patterns. |
| **OSWorld** | `eliza-adapter/eliza_adapter/osworld.py` | Extracts pyautogui code blocks and `CLICK(x,y)` markers. | Route through existing `plugins/plugin-computeruse` (`COMPUTER_USE`). Adapter translates eliza `COMPUTER_USE` action → pyautogui code. Higher-value but more work; defer. |
| **tau-bench** | `eliza-adapter/eliza_adapter/tau_bench.py` | Per-task tool dicts passed verbatim to eliza. | Domain-aware similes on a `TAU_BENCH_TOOL` wrapper (e.g. simile groups for `get_order_*`, `search_*`, `book_*`). Lower priority — bench tools are inherently per-task. |
| **voiceagentbench** | None (cascaded path) | Generic OpenAI / Anthropic tool-call extraction from response text. | Build a `voiceagentbench.py` adapter with a tool-name → eliza-action mapping table (`schedule` → `TODO`, `book_table` → commerce action when one exists, etc.) so voice fine-tuning data flows into canonical action vocabulary. |
| **bfcl** | `eliza-adapter/eliza_adapter/bfcl.py` | Recognizes `BENCHMARK_ACTION` wrapper but doesn't map function names → eliza actions. | Add `ElizaBFCLFunctionRegistry` that exposes the live action catalog as BFCL "live" track candidate functions and converts param schemas. |
| **visualwebbench** | `eliza-adapter/eliza_adapter/visualwebbench.py` | Treats responses as QA. `ACTION_PREDICTION`/`ACTION_GROUND` task types not routed through `BROWSER`/`COMPUTER_USE`. | For action-class tasks, recognize a `BROWSER` action with bbox-shaped params; wire `VISION` for screenshot processing. |
| **evm** | `skill_templates.py`, `exploration_strategy.py` | Per-contract selector exploration; no eliza action wrapper. | Optional `EVM_CONTRACT_INTERACTION` wrapper with similes `["token","transfer","approve","mint","burn","erc20","erc721","selector"]`. Real value is when fine-tuning, not now. |
| **solana** | `voyager/skill_runner/`, `instruction_catalog.py` | Per-program-id discriminator discovery. | `SOLANA_INSTRUCTION_DISCOVERY` wrapper with similes covering Memo, Compute Budget, System Program, Token Program, ATA, ALT. Same caveat as EVM. |
| **agentbench** | `benchmark_actions.py` (stub) | Mock returns deterministic responses; no eliza actions registered. | Intentional. Leave as benchmark-only. |
| **adhdbench** | `evaluator.py` | Tests action-selection accuracy, parameterized over the agent's catalog. | Meta-benchmark — distractor actions should *not* match canonical eliza names. No change. |
| **rlm-bench** | `types.py` | Long-context reasoning, no actions. | Orthogonal. No change. |

## Edits applied this pass

1. `packages/benchmarks/woobench/payment_actions.py`
   - `CHECK_PAYMENT_COMMANDS` now includes `PAYMENT_CHECK` (the promoted virtual name from `paymentOpAction`).
   - `detect_payment_check` and `_payment_action_payload` read `params.action` first, with `params.op` retained as a legacy alias.
   - Verified: 7/7 existing `tests/test_payment_mock.py` cases still pass; canonical/promoted/legacy/text paths all confirmed working via direct invocation.

2. `plugins/app-hyperliquid/src/actions/perpetual-market.ts:108`
   - `HYPERLIQUID_PLACE_ORDER_COMPAT_SIMILES` extends with `HYPERLIQUID_PERP_ORDERS`, `HYPERLIQUID_CANCEL_LAST`, `HYPERLIQUID_CANCEL_OIDS`, `HYPERLIQUID_CANCEL_ALL`, `HYPERLIQUID_USD_CLASS_TRANSFER`, `HYPERLIQUID_SET_LEVERAGE` so retrieval/fine-tune covers HyperliquidBench's plan-step vocabulary.
   - Type-checks clean against `tsconfig.build.json`.

## Larger structural follow-ups (not applied)

These are higher-impact but require new files / cross-package coordination — flagging for prioritization rather than landing in this audit pass:

1. **`plugin-benchmarks` (new):** Hold canonical eliza Action wrappers for vending-bench, webshop, voiceagentbench, bfcl, visualwebbench. Each action's `subActions` enum mirrors the bench tool set; `promoteSubactionsToActions()` exposes `<BENCH>_<TOOL>` virtuals; similes list the bench's literal tool names. Fine-tune corpus then uses canonical action vocabulary regardless of which bench it came from.

2. **lifeops-bench manifest CI gate:** Add a `verify-actions-manifest` job that re-runs `scripts/lifeops-bench/export-action-manifest.ts` and diffs against the committed JSON; fail the build on drift. Reduces the "manifest is 2 days old" risk noted in the audit.

3. **eliza-1 canonical fixtures:** Generate a `planner.canonical.json` from the same manifest pipeline lifeops-bench uses, alongside the existing synthetic `planner.json`. Keeps the synthetic probes for breadth while adding a real-runtime baseline.

4. **OSWorld → COMPUTER_USE bridge:** Translate `COMPUTER_USE` action emissions back to pyautogui code in the OSWorld adapter, so OSWorld trajectories transfer to other desktop benches via the canonical action.
