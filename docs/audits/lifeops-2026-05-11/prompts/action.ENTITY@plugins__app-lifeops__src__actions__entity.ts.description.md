# `action.ENTITY@plugins/app-lifeops/src/actions/entity.ts.description`

- **Kind**: action-description
- **Owner**: plugins/app-lifeops
- **File**: `plugins/app-lifeops/src/actions/entity.ts:462`
- **Token count**: 74
- **Last optimized**: never
- **Action**: ENTITY
- **Similes**: RELATIONSHIP, CONTACTS, ROLODEX, LOG_INTERACTION, ADD_ENTITY, ADD_PERSON, MERGE_ENTITIES, MERGE_CONTACTS, SET_IDENTITY, SET_RELATIONSHIP

## Current text
```
Manage people, organizations, projects, and concepts the owner cares about, plus typed relationships between them. Subactions: add, list, set_identity, set_relationship, log_interaction, merge. Use SCHEDULED_TASK for follow-up cadence; use LIFE for one-off dated reminders to call/text someone.
```

## Compressed variant
```
people+relationships: add|list|set_identity|set_relationship|log_interaction|merge; follow-up cadence → SCHEDULED_TASK
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (118 chars vs 294 chars — 60% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
