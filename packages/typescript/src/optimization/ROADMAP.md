# Roadmap (prompt optimization subsystem)

**Canonical operator doc (paths, traces, parsing WHYs):** [`docs/PROMPT_OPTIMIZATION.md`](../../docs/PROMPT_OPTIMIZATION.md)  
**Package-level core roadmap:** [`ROADMAP.md`](../../ROADMAP.md)

This file focuses on **optimizer stages**, signals, and long-term product questions inside `src/optimization/`.

---

## Current State (Phase 1–3 Complete)

The foundation is in place: trace collection, multi-signal scoring, on-disk
persistence, A/B testing with statistical analysis, and a three-stage optimizer
pipeline with the first stage (few-shot demo selection) fully functional.

GEPA (instruction evolution) and ACE (playbook refinement) adapters are
**stubbed** — they collect traces and select demos but don't yet run LLM-based
optimization. This is by design: the trace infrastructure needed to be correct
and battle-tested before adding expensive AI-in-the-loop optimization.

## Phase 4 — AI-Powered Optimization Stages

### AxGEPA: Instruction Evolution
- Wire the GEPA adapter to use the agent's own LLM to evolve instructions
- Given high-scoring traces and the current prompt, generate improved
  instruction variants
- Score candidates against held-out traces
- Requires: runtime AI access passed through adapter config

### AxACE: Playbook Refinement
- Use LLM to analyze failure patterns in low-scoring traces
- Generate targeted playbook rules that address common failure modes
- Requires: same runtime AI access as GEPA

### Why stub first, wire later?
Optimization stages that call LLMs are expensive and slow. Getting the
scoring, A/B testing, and trace infrastructure right first means we can
validate that optimization *works* (via few-shot demos) before adding
cost. It also means we can develop and test the pipeline without needing
live API keys.

## Phase 5 — Auto-Trigger & Background Optimization (partially shipped)

### Implemented in core
- **`maybeRunAutoPromptOptimization`** (from `plugin-neuro` RUN_ENDED, after `recordTrace`) calls `OptimizationRunner` when `isPromptOptimizationEnabled()` and slot profile + registry allow it.
- **Policy:** First run after `MIN_TRACES_FIRST_ARTIFACT` traces; re-runs use cooldown + `MIN_NEW_TRACES_REOPT` + score regression (see `SlotProfileManager.shouldReoptimize`).
- **Why still “partial”:** No shipped CLI/`POST /api/optimize` in core; operators rely on normal traffic or a custom script calling `OptimizationRunner.run()`.

### Remaining
- **CLI:** `eliza optimize --model <id> --slot <slot> --prompt <name>`
- **API:** `POST /api/optimize` (host responsibility unless added to a server package)
- **Model-change triggers:** explicit detection when `modelId` changes for a slot (today a new folder naturally separates traces; optional migration tooling TBD)

### Why gated thresholds and cooldowns?
Auto-triggering on every trace would spike cost and churn prompts. Thresholds + cooldown keep background work predictable; disabling `PROMPT_OPTIMIZATION_ENABLED` stops the whole pipeline without extra flags.

## Phase 6 — Cross-Project Sharing

### Artifact Portability
- The on-disk format (`~/.eliza/optimization/<model_id>/<slot>/`) is already
  designed for portability — same model + slot = same optimization
- Build CLI tooling: `eliza optimization export/import`
- Publish curated artifacts to a shared registry

### Community Optimization Packs
- Pre-optimized artifacts for common model/slot combinations
- Versioned, with provenance metadata (trace count, baseline score, etc.)

### Why file-based, not DB?
Database storage couples optimizations to a specific agent instance.
File-based storage makes artifacts inherently portable — copy a directory
to share optimizations between projects, backup with git, or distribute
as packages.

## Phase 7 — Advanced Feedback Signals

### Richer Neuro Signals
- **Task completion**: Did the agent achieve the user's stated goal?
- **Multi-turn coherence**: Does the agent maintain context over long conversations?
- **Tool use efficiency**: For agentic tasks, did it use the right tools?
- **Safety signals**: Content policy compliance, PII detection

### External Feedback Integration
- Webhook endpoint for human-in-the-loop scoring
- Thumbs up/down UI integration via `enrichTrace`
- Per-deployment custom signal plugins

### Why more signals?
The current signal set (schema validity, latency, length, continuation,
correction, reaction) captures structural and surface-level quality. Deeper
quality — "did the agent actually help?" — requires task-specific signals.
The `ScoreCard` architecture already supports arbitrary signal kinds with
custom weights.

## Phase 8 — Multi-Model Optimization

### Transfer Learning
- When switching models (e.g., GPT-4 → Claude), bootstrap new optimization
  from the old model's high-scoring traces
- Requires: cross-model trace compatibility (same schema, different model_id)

### Model-Aware Optimization
- Different models may need different optimization strategies
- Small models benefit most from few-shot demos
- Large models benefit most from refined instructions
- Route optimization stages based on model capabilities

## Open Design Questions

### Signal Weight Tuning
- Current default weights are hand-set. Should we auto-tune weights based on
  correlation with downstream outcomes (user retention, task completion)?
- Risk: weight tuning on top of prompt optimization adds a second optimization
  loop that may oscillate.

### Optimization Scope
- Currently scoped to `(model_id, slot, promptKey)`. Should we support
  per-agent or per-room optimization? This would enable personalization but
  increases data sparsity.

### Rollback Safety
- A/B rollback sets `trafficSplit = 0` but keeps the artifact. Should there
  be a mechanism to delete failed artifacts entirely? Or archive them for
  analysis?

### Trace Retention
- `history.jsonl` grows unboundedly. Should we add rotation (keep last N
  traces), compression, or archival? What's the impact on training data
  quality?

### Concurrent Optimization
- Multiple optimization runs for the same `(model, slot, prompt)` could
  conflict. The write-lock in `resolver.ts` prevents corrupt writes, but
  semantic conflicts (two different artifacts) need a merge strategy.
