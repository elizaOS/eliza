# Roadmap — `@elizaos/core` (TypeScript)

This file tracks **planned or discussed** work and the **why** behind it. It is not a commitment schedule; it keeps intent visible across contributors and releases.

For **shipped** behavior and rationale, see [CHANGELOG.md](./CHANGELOG.md) and [docs/DESIGN.md](./docs/DESIGN.md).

---

## Observability

- **Dual-pressure metrics:** Aggregate `dualPressure` / `shouldRespondClassifierAction` (or log equivalents) in hosted dashboards — counts of clamps, high-net IGNOREs, and missing scores. **Why:** Proves the guardrail fires at the expected rate and spots model regressions after prompt or weight changes.
- **Trace IDs:** Correlate should-respond LLM calls with the main generation span where the platform supports it. **Why:** Debugging “wrong gate” reports often requires seeing both the classifier output and the later reply in one trace.

---

## Robustness

- **Schema evolution:** Version or feature-detect should-respond fields when rolling new templates so old adapters do not silently drop `speak_up` / `hold_back`. **Why:** Partial objects already skip clamps; explicit versioning makes migrations safer.
- **Configurable policy on high-net IGNORE:** Today we warn only; some deployments may want an optional hard REPLY or human-review flag. **Why:** Product-specific risk tolerance differs; the default stays non-destructive.

---

## API consistency

- **`ResponseDecision` population:** Optionally have the default service attach `pressure` / `classifierAction` when the LLM path runs, if we want one type for “rule + LLM” without using `MessageProcessingResult` only. **Why:** Reduces parallel optional fields across types; requires a small refactor to avoid breaking callers that assume a minimal shape.
- **Basic capabilities parity:** Keep `basic-capabilities/shouldRespond` aligned with `DefaultMessageService.shouldRespond` (env aliases, return type). **Why:** Two entry points should not diverge on bypass rules.

---

## Performance and cost

- **Cache-friendly should-respond prompts:** Ensure character overrides preserve stable/unstable segment boundaries where providers support prompt caching. **Why:** The classifier runs often; caching stable instruction blocks reduces cost (see prompt-segment work in CHANGELOG).
- **Cheaper model routing:** Continue validating `SHOULD_RESPOND_MODEL` defaults for quality vs cost on small models. **Why:** The gate is latency-sensitive in chat UX.

---

## Should-respond / classifier (feature)

- **REACT or multi-act in main pipeline:** Previously deferred; would let the agent “react” without a full reply where the platform supports it. **Why:** Lowers noise in busy channels; needs clear product rules so it does not fight IGNORE/STOP semantics.
- **Fine-tuned heads:** Train or align adapters so logits match dual-pressure + action jointly. **Why:** Post-hoc clamps are a safety net; models that internalize the rubric reduce warnings and edge-case overrides.

---

## Documentation

- Keep [docs/SHOULD_RESPOND_DUAL_PRESSURE.md](./docs/SHOULD_RESPOND_DUAL_PRESSURE.md) updated when changing thresholds, composeState providers, or clamp rules. **Why:** Operators and plugin authors depend on the WHY, not only the diff.
