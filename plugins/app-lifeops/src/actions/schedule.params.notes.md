SCHEDULE parameter typing rationale (2026-05-10):
- `subaction` enum is just `summary | inspect` — the only two values the runtime accepts (per `coerceSubaction`). Adding the enum makes external agents pick correctly without LLM normalization.
- `timezone` is a free-form IANA string — no enum because the IANA list is too large to enumerate inline; `examples` give the model a pattern to follow.
- No required fields: the handler defaults subaction to `summary` and timezone to `resolveDefaultTimeZone()`.
