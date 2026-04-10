# @elizaos/core roadmap

High-level planned and in-progress work for the core package. **Why a single file?** README and DESIGN link here; keeping one entry point avoids scattered “TODO” docs.

For **prompt optimization** phases (GEPA/ACE, signals, retention), see also:

- [`docs/PROMPT_OPTIMIZATION.md`](docs/PROMPT_OPTIMIZATION.md) — behavior, paths, parsing WHYs
- [`src/optimization/ROADMAP.md`](src/optimization/ROADMAP.md) — deep dive on optimizer stages and open questions

---

## Near term — robustness and observability

### Trajectory union log (`history.jsonl`)

- **Optional split file:** If `jq 'select(.type=="trace")'` becomes too noisy in shared directories, add `observations.jsonl` next to `history.jsonl` for `llm_observation` / `provider_observation` / `signal_context` only.
  - **Why:** Keeps optimizer one-liners pristine while preserving a single writer implementation internally (see [`docs/PROMPT_OPTIMIZATION.md`](docs/PROMPT_OPTIMIZATION.md) architecture section).
- **Per-call `executionTraceId`:** Thread trace UUID through `useModel` / action paths when a call is unambiguously tied to one DPE invocation.
  - **Why:** Today’s “latest active trace for `runId`” is correct for many turns but ambiguous when planner + reply both register traces in one run.
- **Redaction hooks** for `llm_observation` (system prompt, user text, response) per deployment policy.
  - **Why:** `TRAJECTORY_HISTORY_JSONL` is intentionally off by default; some orgs need on with masking, not off.

### Structured output parsing

- **Tolerant recovery:** When TOON decode fails, try stripping trailing non-TOON lines or isolating the first TOON document before XML fallback.
  - **Why:** Models append meta lines or mix formats; strict decode fails while the payload is otherwise usable.
- **Streaming + format alignment:** Revisit `preferredEncapsulation: "xml"` vs TOON when `onStreamChunk` is set; document or unify behavior.
  - **Why:** Today, XML mode can disable TOON detection via substring checks; models that return TOON anyway fail both paths.

### Prompt optimization operations

- **Trace rotation / caps** for `history.jsonl`.
  - **Why:** Unbounded growth affects disk and runner load time; policy should be explicit.
- **CLI or documented one-shot** `OptimizationRunner.run()` for operators.
  - **Why:** Debugging without sending N harness messages.

---

## Medium term — API and performance

- **Configurable provider timeouts** (today fixed in composeState).
  - **Why:** Different deployments need different SLAs.
- **Circuit breaker or backoff** for repeated provider failures.
  - **Why:** Avoid hammering dead endpoints.

---

## Longer term — optimization product

- **Wire AxGEPA / AxACE** to real LLM-backed optimization (see `src/optimization/ROADMAP.md`).
- **Cross-model artifact migration** when changing `modelId`.
- **Optional DB-backed index** of artifacts (files remain source of truth).
  - **Why:** Query “which prompts are optimized?” across many agents without scanning disk on every node.

---

## What we are *not* prioritizing without demand

- Per-room or per-user prompt artifacts in core (data sparsity and privacy).
- Automatic deletion of rolled-back artifacts (analysis value vs disk).
