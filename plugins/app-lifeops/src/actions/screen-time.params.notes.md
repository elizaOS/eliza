SCREEN_TIME parameter typing rationale (2026-05-10):
- `subaction` enum mirrors the existing `SUBACTIONS` map keys (no new const because the SubactionsMap already enforces the closed set; the enum here just exposes it on the wire).
- `source` enum is a closed `app|website` filter (the handler already branches on these two literals).
- All other params left as scalar string/number — they are free-form (date strings, app bundle ids, domains) where a regex would over-constrain (bundle ids and Unicode domains are too varied).
- No fields marked required at the top level: the handler uses `resolveActionArgs` with per-subaction `required` lists (e.g. time_on_app needs appNameOrBundleId) and surfaces a clarification when missing.
