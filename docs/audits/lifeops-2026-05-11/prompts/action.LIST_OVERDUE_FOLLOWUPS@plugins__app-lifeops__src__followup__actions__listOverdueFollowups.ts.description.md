# `action.LIST_OVERDUE_FOLLOWUPS@plugins/app-lifeops/src/followup/actions/listOverdueFollowups.ts.description`

- **Kind**: action-description
- **Owner**: plugins/app-lifeops
- **File**: `plugins/app-lifeops/src/followup/actions/listOverdueFollowups.ts:34`
- **Token count**: 61
- **Last optimized**: never
- **Action**: LIST_OVERDUE_FOLLOWUPS
- **Similes**: OVERDUE_FOLLOWUPS, WHO_TO_FOLLOW_UP, WHO_HAVEN_T_I_TALKED_TO, LIST_FOLLOWUPS, FOLLOWUP_LIST, FOLLOWUP_LIST_OVERDUE

## Current text
```
List contacts whose last-contacted-at timestamp exceeds their follow-up threshold. Use this for overdue or pending follow-up list queries, not for scheduling a new reminder. Returns an empty list when the RelationshipsService is not available.
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
