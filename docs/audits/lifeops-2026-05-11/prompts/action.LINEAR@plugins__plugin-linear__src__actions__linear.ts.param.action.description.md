# `action.LINEAR@plugins/plugin-linear/src/actions/linear.ts.param.action.description`

- **Kind**: action-parameter
- **Owner**: plugins/plugin-linear
- **File**: `plugins/plugin-linear/src/actions/linear.ts:171`
- **Token count**: 58
- **Last optimized**: never
- **Action**: LINEAR
- **Parameter**: action (required: no)

## Current text
```
Operation to perform. One of: create_issue, get_issue, update_issue, delete_issue, create_comment, update_comment, delete_comment, list_comments, get_activity, clear_activity, search_issues. Inferred from message text when omitted.
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
