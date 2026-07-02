# eliza-harness standard-suite 0.0 regression — root cause + fix (gemma-4-31b cutover)

Date: 2026-07-02. Context: `python -m benchmarks.orchestrator run --benchmarks mmlu
--provider cerebras --model gemma-4-31b --extra '{"sample":4}' --force` succeeded
mechanically but scored **0.0** — every reply was the runtime apology text
("I encountered an error while processing this"). Control on `gpt-oss-120b`
failed identically → model-independent harness/runtime regression.

## Root causes (five, compounding)

1. **`terminal_only_continuations` trip in the planner loop**
   (`packages/core/src/runtime/evaluator.ts`). On a terminal-only iteration the
   planner answers ("B"), the completion evaluator returns FINISH *without*
   `messageToUser`, and `repairFinishedToolTurnWithoutUserMessage` coerced that
   FINISH into CONTINUE. Three identical planner answers later the loop threw
   `Trajectory limit exceeded: terminal_only_continuations (3/2)` (observed in
   server stderr) and relayed a generic apology instead of the answer.
   **Fix:** a FINISH after a terminal-only step with a real terminal message is
   complete — do not coerce.

2. **Generic benchmark prompt composition routed exam questions into tools**
   (`packages/app-core/src/benchmark/server-utils.ts`). The standard suite
   (MMLU/GSM8K/HumanEval/MT-Bench) grades reply TEXT and declares `tools: []`,
   but its turns were composed with the generic "BENCHMARK CONTEXT
   (authoritative)" JSON + "Respond using normal Eliza action output…" trailer.
   Stage-1 then classified MCQs as tool-requiring (observed live:
   `candidateActions: ["VIEWS"]` on abstract-algebra questions).
   **Fix:** dedicated `composeStandardSuitePrompt` — system prompt + prior
   turns (MT-Bench) + question + "Answer directly in your reply text."

3. **Stage-1 tool vote could hard-force a non-terminal tool call on
   text-scored turns** (`packages/core/src/services/message.ts`).
   **Fix:** `isTextScoredBenchmarkTurn` (benchmark === "standard") vetoes
   `requireNonTerminalToolCall`; planning stays on "auto".

4. **BENCHMARK_ACTION was an attractive nuisance on the standard suite**
   (`packages/app-core/src/benchmark/plugin.ts`). Its ANSWER/GUESS similes
   lured the planner into detouring one-shot exam answers through the tool +
   completion-evaluator machinery. **Fix:** disable it when
   `currentBenchmarkName() === "standard"`.

5. **Bounded-smoke defaults truncated real answers and ignored `sample`**
   (`packages/benchmarks/orchestrator/adapters.py`, `runner.py`).
   `max_tokens: 256` silently truncated GSM8K chain-of-thought (and reasoning
   models' hidden tokens); `--extra '{"sample":N}'` was ignored by the standard
   CLIs (which only read `limit`), so runs silently fell back to `limit=2`.
   **Fix:** smoke `max_tokens` 256 → 2048; integer `sample` maps to `limit`
   when no explicit `limit` is given.

Additionally the bench server was being launched with `/usr/bin/node` v18 (no
global `crypto` — uuid v14 crashed every request with `crypto is not defined`);
fixed earlier in `eliza_adapter/server_manager.py::_resolve_node` (first PATH
node ≥ 20).

## Proof (live, gemma-4-31b via Cerebras)

| benchmark | before | after |
| --- | --- | --- |
| mmlu (`--extra '{"sample":8}'`) | 0.0 (all runtime-apology replies) | **0.75** (8 examples graded) |
| gsm8k (`--extra '{"sample":8}'`) | 0.0 | **1.0** |

Commands:

```
CEREBRAS_API_KEY=$CEREBRAS_API_KEY PYTHONPATH=packages \
  python3 -m benchmarks.orchestrator run --benchmarks mmlu  --provider cerebras --model gemma-4-31b --extra '{"sample":8}' --force
CEREBRAS_API_KEY=$CEREBRAS_API_KEY PYTHONPATH=packages \
  python3 -m benchmarks.orchestrator run --benchmarks gsm8k --provider cerebras --model gemma-4-31b --extra '{"sample":8}' --force
```

(10193 gpt-oss-120b baselines for scale: mmlu 0.925 / gsm8k 0.975 at limit 40 —
smoke-sized samples here; the full-registry review run produces the calibrated
numbers.)
