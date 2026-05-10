HEALTH parameter typing rationale (2026-05-10):
- `subaction` enum draws from existing `HEALTH_SUBACTIONS` const so the wire schema mirrors the runtime guard.
- `metric` enum draws from `HEALTH_METRICS` (typed as `HealthDataPoint["metric"]`) so external agents pick from the same closed set the handler accepts.
- No fields are marked required: the handler's LLM planner can infer subaction + metric from `intent` when explicit fields are absent, so making them required would break the implicit-routing path.
- `days` gets `minimum:1, maximum:365` to match handler clamping (`days > 0`, falls back to 7) without changing handler behavior.
- `descriptionCompressed` added on every param to keep prompt-cache footprint small for non-Eliza consumers.
