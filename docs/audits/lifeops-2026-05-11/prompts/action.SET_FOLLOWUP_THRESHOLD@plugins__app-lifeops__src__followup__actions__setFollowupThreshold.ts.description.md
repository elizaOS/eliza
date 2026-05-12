# `action.SET_FOLLOWUP_THRESHOLD@plugins/app-lifeops/src/followup/actions/setFollowupThreshold.ts.description`

- **Kind**: action-description
- **Owner**: plugins/app-lifeops
- **File**: `plugins/app-lifeops/src/followup/actions/setFollowupThreshold.ts:41`
- **Token count**: 64
- **Last optimized**: never
- **Action**: SET_FOLLOWUP_THRESHOLD
- **Similes**: FOLLOWUP_RULE, CHANGE_FOLLOWUP_INTERVAL, SET_CONTACT_FREQUENCY_DAYS, FOLLOWUP_CREATE_RULE

## Current text
```
Set a recurring follow-up cadence threshold (in days) for a specific contact. Use this for durable rules like 'every 14 days', not one-off reminders like 'next week'. Requires a positive integer threshold and either contactId or an unambiguous contactName.
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
