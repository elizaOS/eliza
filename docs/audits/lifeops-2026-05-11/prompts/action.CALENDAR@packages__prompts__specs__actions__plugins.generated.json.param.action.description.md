# `action.CALENDAR@packages/prompts/specs/actions/plugins.generated.json.param.action.description`

- **Kind**: action-parameter
- **Owner**: spec-only
- **File**: `packages/prompts/specs/actions/plugins.generated.json`
- **Token count**: 58
- **Last optimized**: never
- **Action**: CALENDAR
- **Parameter**: action (required: no)

## Current text
```
Which calendar operation to run. Calendar: feed, next_event, search_events, create_event, update_event, delete_event, trip_window, bulk_reschedule. Availability: check_availability, propose_times. Preferences: update_preferences.
```

## Compressed variant
```
none
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- No compressed variant. Authors should add `descriptionCompressed` — the planner caches both shapes and falls back to the long form when the compressed one is absent.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
