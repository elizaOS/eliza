# `action.CALENDAR@packages/prompts/specs/actions/plugins.generated.json.description`

- **Kind**: action-description
- **Owner**: spec-only
- **File**: `packages/prompts/specs/actions/plugins.generated.json`
- **Token count**: 21
- **Last optimized**: never
- **Action**: CALENDAR
- **Similes**: CALENDAR, SCHEDULE, MEETING, CALENDAR_LIST_UPCOMING, CALENDAR_FIND_AVAILABILITY, CALENDAR_CREATE_EVENT, CALENDAR_CREATE_RECURRING_BLOCK, CALENDAR_RESCHEDULE_EVENT, CALENDAR_CANCEL_EVENT, CALENDAR_PROPOSE_TIMES, CALENDAR_PROTECT_WINDOW, CALENDAR_BUNDLE_MEETINGS, CALENDAR_ADD_PREP_BUFFER, CALENDAR_ADD_TRAVEL_BUFFER

## Current text
```
Manage live calendar events plus availability and meeting preferences. Subactions: 
```

## Compressed variant
```
calendar event CRUD + availability + prefs; subactions create_event|update_event|delete_event|search_events|propose_times|check_availability|next_event|feed
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
None.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
