# `action.ENTITY@plugins/app-lifeops/src/actions/entity.ts.routingHint`

- **Kind**: routing-hint
- **Owner**: plugins/app-lifeops
- **File**: `plugins/app-lifeops/src/actions/entity.ts:466`
- **Token count**: 72
- **Last optimized**: never
- **Action**: ENTITY

## Current text
```
people/contacts/relationships ("add Pat to my contacts", "Pat is my manager") -> ENTITY; follow-up cadence ("follow up with David", "how long since I talked to X", "who is overdue") -> SCHEDULED_TASK; one-off dated reminders to call/text someone ("remember to call mom Sunday") -> LIFE
```

## Compressed variant
```
none
```

## Usage stats (latest trajectories)
- Invocations: 21
- Success rate: 1.00
- Avg input chars when matched: 80261

## Sample failure transcripts
None.

## Suggested edits (heuristic)
None.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
