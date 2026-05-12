# `action.CALENDAR@packages/prompts/specs/actions/plugins.generated.json.param.details.description`

- **Kind**: action-parameter
- **Owner**: spec-only
- **File**: `packages/prompts/specs/actions/plugins.generated.json`
- **Token count**: 28
- **Last optimized**: never
- **Action**: CALENDAR
- **Parameter**: details (required: no)

## Current text
```
Structured calendar fields — time bounds, timezone, calendar id, create-event timing, location, and attendees.
```

## Compressed variant
```
calendar details: calendarId timeMin timeMax timeZone startAt endAt durationMinutes eventId newTitle description location travelOriginAddress windowDays windowPreset forceSync
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
