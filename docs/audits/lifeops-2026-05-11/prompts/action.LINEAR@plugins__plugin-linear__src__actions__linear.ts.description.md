# `action.LINEAR@plugins/plugin-linear/src/actions/linear.ts.description`

- **Kind**: action-description
- **Owner**: plugins/plugin-linear
- **File**: `plugins/plugin-linear/src/actions/linear.ts:172`
- **Token count**: 73
- **Last optimized**: never
- **Action**: LINEAR
- **Similes**: LINEAR_ISSUE, LINEAR_ISSUES, LINEAR_COMMENT, LINEAR_COMMENTS, LINEAR_WORKFLOW, LINEAR_ACTIVITY, LINEAR_SEARCH, CREATE_LINEAR_ISSUE, GET_LINEAR_ISSUE, UPDATE_LINEAR_ISSUE, DELETE_LINEAR_ISSUE, MANAGE_LINEAR_ISSUE, MANAGE_LINEAR_ISSUES, CREATE_LINEAR_COMMENT, COMMENT_LINEAR_ISSUE, UPDATE_LINEAR_COMMENT, DELETE_LINEAR_COMMENT, LIST_LINEAR_COMMENTS, GET_LINEAR_ACTIVITY, CLEAR_LINEAR_ACTIVITY, SEARCH_LINEAR_ISSUES, LINEAR_WORKFLOW_SEARCH

## Current text
```
Manage Linear issues, comments, and activity. Operations: create_issue, get_issue, update_issue, delete_issue, create_comment, update_comment, delete_comment, list_comments, get_activity, clear_activity, search_issues. The op is inferred from the message text when not explicitly provided.
```

## Compressed variant
```
Linear: create/get/update/delete issue, create/update/delete/list comment, search issues, get/clear activity.
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (109 chars vs 289 chars — 62% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
