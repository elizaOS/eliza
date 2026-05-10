TOGGLE_FEATURE parameter typing rationale (2026-05-10):
- `featureKey` enum sourced from `ALL_FEATURE_KEYS` (already imported). The registry runtime list is dynamic and may include plugin-contributed keys, but the static base set in `ALL_FEATURE_KEYS` is what the LifeOps core registers and what scenarios target. Setting an enum means non-Eliza agents won't fabricate fake flag names.
- `enabled` stays boolean; `reason` stays free-form string.
- No required fields: handler runs an LLM extraction (`extractToggleWithLlm`) when fields are absent and surfaces a clarifying error otherwise.
