# Roadmap

Planned improvements and directions for `@elizaos/core` (packages/typescript). Items include **why** they matter.

---

## Near-term

### Observability & debugging
- **Structured run IDs across logs**  
  **Why:** Correlate prompt logs, chat logs, and action callbacks by run so we can trace a single request end-to-end without grep-by-time.
- **Optional span/trace export**  
  **Why:** Integrate with OpenTelemetry or similar so production can see provider/model/action latency and failures in existing APM tools.

### Robustness
- **Configurable provider timeout**  
  **Why:** 30s is a safe default but some providers (e.g. slow search) may need a higher limit; making it a setting avoids hardcoding multiple values.
- **Circuit breaker or backoff for failing providers**  
  **Why:** Repeatedly calling a failing provider on every message wastes time and can amplify downstream errors; backoff or circuit-breaker would reduce load and improve latency when a dependency is unhealthy.

### API consistency
- **Message update flow (MESSAGE_UPDATED / UpdateHandlerCallback)**  
  **Why:** Editing or replacing a sent message is a common product need; defining the event and callback contract in core allows plugins and clients to implement it consistently.
- **Adopt the shared config-loading helpers across plugin ports**  
  **Why:** The new core helper removes the repeated runtime/env lookup and schema error boilerplate, but most callers still need to migrate one by one. A phased adoption pass will prove the helper across a few common patterns before widening it further.

---

## Medium-term

### Model & prompts
- **Structured generation (e.g. generateObject) evolution**  
  **Why:** Dynamic execution and schema-driven generation are the intended path; we will refine the API and behavior based on usage rather than porting legacy generateObject.
- **Thinking / CoT metadata in GenerateTextResult**  
  **Why:** Models that expose reasoning (e.g. extended thinking) need a standard place in the result so evaluators and logging can use it without provider-specific code.

### Performance
- **Provider result caching with TTL/invalidation**  
  **Why:** Some provider data changes rarely; short-lived cache could reduce duplicate work when composing state multiple times in one turn.
- **Selective provider re-run in multi-step**  
  **Why:** Today we already use `onlyInclude` in the action loop; we can extend this so only providers that depend on the latest messages/state are re-run in later steps.

### Plugin & configuration
- **Plugin init lifecycle and dependency order**  
  **Why:** Plugins that depend on others (e.g. services) need a clear init order and readiness signal so they don’t run before dependencies are registered.
- **Validation for critical env/settings at startup**  
  **Why:** Failing fast on missing or invalid config (e.g. model keys, adapter) saves debugging time and makes deployment errors obvious.
- **Decide which config behaviors stay plugin-local vs. move into core**  
  **Why:** Alias keys, character-setting merges, and plugin-specific derived values are intentionally out of scope for the first helper pass. We should only promote them after repeated adoption proves they are truly common and not accidental duplication.

---

## Longer-term / exploratory

- **Streaming for structured outputs**  
  **Why:** Large JSON or XML outputs could be streamed and parsed incrementally to improve perceived latency and allow early cancellation.
- **First-class “tool” or “function” abstraction**  
  **Why:** If actions and providers converge toward a common “tool” shape, we can simplify docs, plugins, and model prompts (e.g. one tool list for the model).
- **Cost and token usage aggregation**  
  **Why:** Operators need to understand cost per agent or per run; aggregating token usage and optional cost metadata would support billing and optimization.

---

## Out of scope (by design)

- **Re-adding a separate `generateObject` API**  
  **Why:** Dynamic execution and the evolving structured-generation path are the intended replacement; we do not plan to resurrect the old generateObject surface.

---

This roadmap is a living document and will be updated as priorities and constraints change.
