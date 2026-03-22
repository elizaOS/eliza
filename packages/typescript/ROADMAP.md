# Roadmap

Planned improvements and future work for `@elizaos/core` (packages/typescript). Items are grouped by area; order within a section is approximate. Items include **why** they matter.

---

## Runtime composition

- **Done:** `loadCharacters`, `getBootstrapSettings`, `mergeSettingsInto`, `createRuntimes`; adapter factory on `Plugin`; plugin-sql, plugin-inmemorydb, and plugin-localdb implement adapter factory; one entry point (telegram example) migrated; composition path does not sync character secrets to `process.env`; unit tests for composition (getBootstrapSettings, mergeSettingsInto, loadCharacters, createRuntimes with adapter override).
- **Possible next steps:**
  - Migrate more entry points (e.g. milaidy) to use composition where it fits. **WHY:** Validates the API and reduces duplicate bootstrap code.
  - Document "bootstrap vs runtime" settings in a single canonical place (e.g. schema or constant list of bootstrap keys) so adapter plugin authors know exactly what they receive. **WHY:** Reduces ambiguity for new plugins (e.g. plugin-mongo).

---

## Plugins and adapters

- **Done:** `Plugin.adapter` is an optional `AdapterFactory`; runtime no longer registers it (handled pre-construction by composition or host). `registerDatabaseAdapter` has been removed; pass the adapter in the `AgentRuntime` constructor. **WHY:** Simplifies the runtime contract.
- **Possible next steps:**
  - If plugin-mongo (or other DB plugins) are added: follow the same pattern (export `plugin` with `adapter(agentId, settings)` using bootstrap settings only). **WHY:** Keeps adapter discovery extensible and consistent.
  - **Plugin init lifecycle and dependency order**  
    **Why:** Plugins that depend on others (e.g. services) need a clear init order and readiness signal so they don't run before dependencies are registered.
  - **Adopt the shared config-loading helpers across plugin ports**  
    **Why:** The new core helper removes the repeated runtime/env lookup and schema error boilerplate, but most callers still need to migrate one by one. A phased adoption pass will prove the helper across a few common patterns before widening it further.
  - **Decide which config behaviors stay plugin-local vs. move into core**  
    **Why:** Alias keys, character-setting merges, and plugin-specific derived values are intentionally out of scope for the first helper pass. We should only promote them after repeated adoption proves they are truly common and not accidental duplication.

---

## Testing and quality

- **Done:** Unit tests for runtime composition (`src/__tests__/runtime-composition.test.ts`): getBootstrapSettings (string-only, override order, secrets), mergeSettingsInto (null, no settings, merge order), loadCharacters (empty, object, file path via mock, validation failure), createRuntimes (empty, one character with adapter override, merged character from getAgentsByIds).
- **Possible next steps:**
  - Integration test for `createRuntimes` without adapter override (real plugin-sql resolve) in CI when plugin-sql is available. **WHY:** Full pipeline with real plugin resolution.
  - Run existing plugin-sql and runtime test suites in CI after composition changes. **WHY:** Composition reuses plugin resolution and provisioning; regressions there affect many entry points.

---

## Documentation and DX

- **Done:** [Runtime composition](docs/RUNTIME_COMPOSITION.md) (API, settings divide, examples), WHY-focused comments in `runtime-composition.ts`, README section, CHANGELOG entry, this roadmap.
- **Possible next steps:**
  - Add a short "Quick start with composition" to the main README or docs index (one file path + one code block). **WHY:** Lowers friction for new users who want the recommended path.
  - Cross-link RUNTIME_ARCHITECTURE.md and RUNTIME_COMPOSITION.md (e.g. "for building blocks and bootstrap vs runtime, see Runtime composition"). **WHY:** Helps readers find the right doc.

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
- **Validation for critical env/settings at startup**  
  **Why:** Failing fast on missing or invalid config (e.g. model keys, adapter) saves debugging time and makes deployment errors obvious.

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

---

## Longer-term / exploratory

- **Streaming for structured outputs**  
  **Why:** Large JSON or XML outputs could be streamed and parsed incrementally to improve perceived latency and allow early cancellation.
- **First-class "tool" or "function" abstraction**  
  **Why:** If actions and providers converge toward a common "tool" shape, we can simplify docs, plugins, and model prompts (e.g. one tool list for the model).
- **Cost and token usage aggregation**  
  **Why:** Operators need to understand cost per agent or per run; aggregating token usage and optional cost metadata would support billing and optimization.

---

## Out of scope (by design)

- **Re-adding a separate `generateObject` API**  
  **Why:** Dynamic execution and the evolving structured-generation path are the intended replacement; we do not plan to resurrect the old generateObject surface.

---

## Other (existing TODO items)

The README "TODO Items" section still lists improvements (e.g. plugin sources, post formatting, server ID issues, ensureConnection refactor). Those remain valid; this roadmap focuses on composition and related areas. As work is done, items can move from "Possible next steps" to "Done" or into CHANGELOG.

---

This roadmap is a living document and will be updated as priorities and constraints change.
