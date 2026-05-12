# `action.ENTITY@plugins/app-lifeops/src/actions/entity.ts.param.action.description`

- **Kind**: action-parameter
- **Owner**: plugins/app-lifeops
- **File**: `plugins/app-lifeops/src/actions/entity.ts:447`
- **Token count**: 76
- **Last optimized**: never
- **Action**: ENTITY
- **Parameter**: action (required: no)

## Current text
```
Which ENTITY operation to run: add (new contact), list (read rolodex), log_interaction (record contact event), set_identity (force-merge a platform handle onto an entity), set_relationship (typed edge between entities), merge (collapse duplicate entities). Follow-up cadence belongs to SCHEDULED_TASKS.
```

## Compressed variant
```
ENTITY op: add | list | log_interaction | set_identity | set_relationship | merge
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (81 chars vs 302 chars — 73% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
