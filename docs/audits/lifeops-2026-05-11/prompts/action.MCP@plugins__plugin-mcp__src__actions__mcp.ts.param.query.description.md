# `action.MCP@plugins/plugin-mcp/src/actions/mcp.ts.param.query.description`

- **Kind**: action-parameter
- **Owner**: plugins/plugin-mcp
- **File**: `plugins/plugin-mcp/src/actions/mcp.ts:366`
- **Token count**: 29
- **Last optimized**: never
- **Action**: MCP
- **Parameter**: query (required: no)

## Current text
```
Natural-language description of the tool call or resource to select; for action=search_actions, the keyword query.
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
