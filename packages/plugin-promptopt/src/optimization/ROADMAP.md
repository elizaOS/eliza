# Roadmap (prompt optimization subsystem)

**Canonical operator doc (paths, traces, parsing WHYs):** [`docs/PROMPT_OPTIMIZATION.md`](../../docs/PROMPT_OPTIMIZATION.md)  
**Package-level core roadmap:** [`ROADMAP.md`](../../ROADMAP.md)

This file focuses on **optimizer stages**, signals, and long-term product questions inside `src/optimization/`.

---

## Current state

### Phase 1–3 (complete)

Trace collection, multi-signal scoring, on-disk persistence, A/B testing, and a **three-stage pipeline** with **AxBootstrapFewShot** fully functional (demo selection from scored traces).

### Phase 4 (complete) — AI-powered GEPA / ACE

**Implemented:** When `@ax-llm/ax` is present and **`OPTIMIZATION_AI_PROVIDER`**, **`OPTIMIZATION_AI_API_KEY`**, **`OPTIMIZATION_AI_MODEL`** are set:

- **AxGEPA** evolves instructions via reflective optimization (student rollouts, teacher reflection) using real **`AxAIService`** instances.
- **AxACE** refines a structured playbook (generator → reflector → curator).

**WHY standalone `AxAI` instead of `runtime.useModel`:** Ax optimizers assume provider-native chat (roles, tools, streaming, embeddings). A thin Eliza bridge would be a second SDK surface and would break whenever Ax extends `AxAIService`.

**WHY optional / stub fallback:** Missing package or settings must not break deployments. Bootstrap few-shot still runs; GEPA/ACE return **`adopted: false`** and log a **warn** + **`stats.error`** on failure.

**WHY `instrumentation.jsonl`:** Captures exactly what GEPA/ACE send to the LLM (per verbosity level) for cost modeling and for a future **native** optimizer that does not depend on Ax.

**WHY thread `signalWeights` into `elizaMetricFn`:** The pipeline baseline uses merged weights (`DEFAULT_SIGNAL_WEIGHTS` + `PROMPT_OPT_SIGNAL_WEIGHTS`). If Ax stages used only defaults, operators would optimize a **different objective** than the one used for promotion and A/B.

**WHY `adopted: false` when instructions/playbook are empty:** Avoids advancing **`finalScore`** when Ax returns no usable text (e.g. extraction failed), which would confuse dashboards and stage history.

**Known limitations (intentional v1):**

- **`contextText`** in training examples is still **`templateHash`**, not the rendered prompt. **Why:** Traces do not currently carry full prompt text by default (size/PII); improving this belongs to trajectory/registry work.
- **Ax field naming:** Some generic output names (e.g. `text`) may be rejected by Ax signature validation — schemas should use specific field names.
- **End-to-end tests** use unit coverage + conditional `buildAxProgram` checks; a full mock-`AxAI` integration test remains optional.

### Phase 5 — Auto-trigger & background optimization (partially shipped)

#### Implemented in core

- **`maybeRunAutoPromptOptimization`** (from `plugin-neuro` RUN_ENDED, after `recordTrace`) calls `OptimizationRunner` when `isPromptOptimizationEnabled()` and slot profile + registry allow it.
- **`runtime` is forwarded** into `runner.run()` so auto-opt respects **`OPTIMIZATION_AI_*`** and instrumentation settings.
- **Policy:** First run after `MIN_TRACES_FIRST_ARTIFACT` traces; re-runs use cooldown + `MIN_NEW_TRACES_REOPT` + score regression (see `SlotProfileManager.shouldReoptimize`).

**WHY still “partial”:** No shipped CLI / `POST /api/optimize` in core; operators rely on traffic or a script calling `OptimizationRunner.run()`.

#### Remaining

- **CLI:** `eliza optimize --model <id> --slot <slot> --prompt <name>`
- **API:** `POST /api/optimize` (host responsibility unless added to a server package)
- **Model-change triggers:** explicit detection when `modelId` changes for a slot (today a new folder naturally separates traces; optional migration tooling TBD)

**WHY gated thresholds and cooldowns?** Auto-triggering on every trace would spike cost and churn prompts. Thresholds + cooldown keep background work predictable; disabling `PROMPT_OPTIMIZATION_ENABLED` stops the whole pipeline without extra flags.

## Phase B (future) — Native optimizers & richer training context

- **Replace or complement Ax** for GEPA/ACE using data from `instrumentation.jsonl` once call patterns are understood.
- **Materialize `contextText`** from registry template slices or opt-in trajectory fields, with redaction policy.
- **WHY:** Cost control and fewer moving parts for operators who do not want Ax as a runtime dependency for optimization.

## Phase 6 — Cross-Project Sharing

### Artifact portability

- The on-disk format (`~/.eliza/optimization/<model_id>/<slot>/`) is already designed for portability — same model + slot = same optimization.
- Build CLI tooling: `eliza optimization export/import`
- Publish curated artifacts for common model/slot combinations with provenance metadata.

**WHY file-based, not DB?** Database storage couples optimizations to a specific agent instance. File-based storage makes artifacts portable — copy a directory, version in git, or distribute as packages.

## Phase 7 — Advanced Feedback Signals

### Richer neuro signals

- Task completion, multi-turn coherence, tool efficiency, safety signals.

### External feedback

- Webhooks, thumbs up/down via `enrichTrace`, custom signal plugins.

**WHY more signals?** Today’s set captures structural and surface quality; “did the agent help?” needs task-specific signals. `ScoreCard` already supports arbitrary kinds and weights.

### Trajectory union log vs optimizer training

- **`llm_observation` / `provider_observation`** share `history.jsonl` with `ExecutionTrace` but are **ignored** by `loadTraces` and `OptimizationRunner`.
  - **WHY:** Same append-only transport; training stays scored-DPE-only so pipeline semantics stay stable.
- **Future:** Optional trainer that ingests observations (needs rendered prompt materialization).

## Phase 8 — Multi-Model Optimization

- Transfer learning when switching models (same schema, new `modelId`).
- Route stages by model capability (demos vs instructions emphasis).

## Open design questions

### Signal weight tuning

Auto-tune weights from downstream outcomes? **Risk:** second optimization loop may oscillate.

### Optimization scope

Per-agent or per-room artifacts? **Tradeoff:** personalization vs data sparsity.

### Rollback safety

Delete failed artifacts vs keep for analysis?

### Trace retention

Rotation, compression, archival vs training quality?

### Concurrent optimization

Write-lock prevents corruption; semantic merge of competing artifacts TBD.
