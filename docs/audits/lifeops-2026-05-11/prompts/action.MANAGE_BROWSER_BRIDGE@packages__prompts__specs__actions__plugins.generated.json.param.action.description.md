# `action.MANAGE_BROWSER_BRIDGE@packages/prompts/specs/actions/plugins.generated.json.param.action.description`

- **Kind**: action-parameter
- **Owner**: spec-only
- **File**: `packages/prompts/specs/actions/plugins.generated.json`
- **Token count**: 72
- **Last optimized**: never
- **Action**: MANAGE_BROWSER_BRIDGE
- **Parameter**: action (required: no)

## Current text
```
Bridge management action. Use refresh for show/settings/status/connection-state requests. Use open_manager only for explicit chrome://extensions or extension-manager requests. install builds/reveals/opens setup; reveal_folder opens the build folder. Inferred from message text if omitted.
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
