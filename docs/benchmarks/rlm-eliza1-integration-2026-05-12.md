# RLM + eliza-1 Integration Plan

Date: 2026-05-12

## Sources Reviewed

- Paper: https://arxiv.org/abs/2512.24601
- Code: https://github.com/alexzhang13/rlm
- Seed trajectories: https://huggingface.co/datasets/HotCopyAI/rlm-trajectories-seed
- AlphaXiv split: https://huggingface.co/datasets/alphaXiv/rlm-data-split
- Local plugin: `plugins/plugin-rlm`
- Local bench: `packages/benchmarks/rlm-bench`

## What The Paper Actually Trains

RLM is not just another long-context summarizer. The root model is trained or prompted to operate a persistent execution context. It can inspect snippets, grep, split work, launch recursive subcalls, write code, and stitch evidence into a final answer. The important training signal is the root trajectory: which context operations were chosen, when recursive calls were made, what code or queries were generated, what was observed, and how the final answer cited those observations.

The public seed trajectory dataset is tiny: 12 training rows with fields like `task`, `context_chars`, per-iteration `generated_code`, `stdout`, `tokens_estimate`, `sub_call_count`, `final`, and cost/runtime totals. It is useful as a schema exemplar, not enough for eliza-1 fine-tuning alone.

The AlphaXiv split is a more useful supervised/eval source: 617 rows total, with 517 train and 100 validation. Each row carries `prompt`, `question`, `max_turns`, `env_class`, `reward_spec`, and `extra_info.context_text`. The sample shape is multi-paper evidence RLM, so the target behavior is evidence selection and synthesis over large text, not general chat.

## Local State

`plugins/plugin-rlm` should not be moved into `packages/core/src` wholesale:

- It registers handlers for every text model type, which can hijack normal runtime generation when RLM is installed.
- It falls back to stub responses on backend failure, which is acceptable for optional plugin smoke tests but dangerous inside core planning.
- `client.ts` spawns `python -m elizaos_plugin_rlm.server` with `cwd` at `plugins/plugin-rlm/python`, but no `python/` package exists locally.
- `server.ts` is a separate Node TCP wrapper that is not wired into `client.ts`.
- Types are useful, but the backend dependency and process lifecycle need a real core service boundary.

The current RLM benchmark now passes in Eliza mode after auth/server startup fixes, but that proves benchmark bridge wiring, not that eliza-1 has learned RLM-style planning.

## Core Architecture

Add RLM as a first-class runtime capability, not as a global model override.

1. Core contracts in `packages/core/src/rlm/`
   - `RLMRequest`: task, context handle or text, budget, allowed operations, max iterations/depth, benchmark/run metadata.
   - `RLMResult`: final answer, evidence spans, iterations, subcall count, token/cache/cost telemetry, trajectory ID.
   - `RLMService`: `infer(request)`, `status()`, `shutdown()`, `onTelemetry(callback)`.
   - `RLMPolicy`: gate by context size, task type, latency budget, and explicit runtime flag.

2. Runtime integration
   - Expose `runtime.rlm` as an optional service with a strict status object.
   - Add a planner hook that can choose `use_rlm_context` only when the policy says it is warranted.
   - Add a normal action, `USE_RLM_CONTEXT`, for agent-visible recursive research. It must return structured observations, not a hidden final answer that bypasses the action loop.
   - Record all RLM iterations into the existing trajectory recorder and benchmark telemetry tables.

3. Backend package
   - Keep the Python official implementation as a sidecar dependency or managed source checkout.
   - Replace plugin stub fallback with explicit unavailable status in core paths.
   - If unavailable, the planner must fall back to normal context compaction/search, never emit a fake RLM answer.

4. Bench compatibility
   - Default off for short-context benchmarks: action-calling, BFCL, TauBench, Mind2Web, WooBench, VendingBench, VoiceBench.
   - Default on only for RLM bench and long-context research/code/document tasks.
   - Budget caps: max 4 root iterations, max depth 1 for benchmark smoke; raise only for long-context evals.

## Fine-Tuning Plan

Fine-tune eliza-1 on root RLM trajectories, not on leaf subcall transcripts as ordinary chat.

1. Data schema
   - `messages`: system, user task, compact context manifest, tool/action observations.
   - `rlm_trace`: ordered iteration objects with operation, generated query/code, observation, tokens, latency, and subcall metadata.
   - `target`: next root operation or final answer.
   - `bench_metadata`: benchmark, scenario, scorer, expected evidence, reward.

2. Data generation
   - Use benchmark scenarios from RLM, Mind2Web, TerminalBench, WooBench, VendingBench, framework, and config-style tasks.
   - Inject an RLM instruction that forces explicit use of context operations and evidence selection.
   - Generate teacher traces with a stronger model such as Opus for root planning.
   - Validate with benchmark scorers before adding to SFT.
   - Reject traces that solve short tasks through RLM when direct action would be faster.

3. Training stages
   - SFT on root operation prediction and final synthesis.
   - DPO/ORPO on pairs: efficient RLM trace vs over-recursive trace, evidence-backed answer vs unsupported answer, direct action vs unnecessary recursive call.
   - Optional RL on RLM bench plus latency/token penalties.

4. Regression gates
   - RLM bench: accuracy, evidence coverage, subcall count, latency, token/cache metrics.
   - Action calling/BFCL: no regression in structured action emission.
   - WooBench/VendingBench: RLM remains off unless long external context exists.
   - Mind2Web/TerminalBench: RLM may assist planning but cannot bypass required UI/shell actions.

## Implementation Phases

Phase 1: Core service seam
- Add `packages/core/src/rlm/types.ts`, `service.ts`, and runtime registration.
- Add no model-handler override.
- Port only safe TypeScript types from `plugin-rlm`.

Phase 2: Action and planner hook
- Add `USE_RLM_CONTEXT` action with structured request/result.
- Add policy gating to planner/context construction.
- Wire telemetry into `recordLlmCall` and trajectory recorder.

Phase 3: Backend
- Add managed source checkout for `alexzhang13/rlm`.
- Add a tested Python IPC server package or wire the existing Node `server.ts` to the TypeScript client.
- Remove stub success behavior from benchmark-critical paths.

Phase 4: Data generation
- Build `packages/benchmarks/rlm-bench/training/generate_rlm_traces.py`.
- Export validated JSONL to app-training bundle format.
- Add teacher prompt templates and benchmark replay validation.

Phase 5: Fine-tune and rollout
- Train eliza-1 adapters with RLM root traces.
- Add eval matrix comparing RLM-on/off across all benchmark categories.
- Enable by default only when the runtime policy predicts net benefit.

## Immediate Recommendation

Do not make RLM a mandatory always-on dependency for every response. Make the core runtime aware of RLM and ship a required interface, but keep backend execution gated by policy and availability. That gets benchmark gains where RLM matters without slowing short action-calling, commerce, web-navigation, or voice workloads.
