# `action.MANAGE_PLUGINS@packages/core/src/features/plugin-manager/actions/plugin.ts.description`

- **Kind**: action-description
- **Owner**: packages/core
- **File**: `packages/core/src/features/plugin-manager/actions/plugin.ts:328`
- **Token count**: 151
- **Last optimized**: never
- **Action**: MANAGE_PLUGINS
- **Similes**: PLUGIN

## Current text
```
Unified plugin control. action=install installs from registry; eject clones a registry plugin locally; sync pulls upstream into an ejected plugin; reinject removes the local copy; list shows loaded/installed; list_ejected shows ejected; search queries the registry; details shows registry/runtime details; status reports plugin state; enable/disable load or unload runtime-registered plugins; core_status reports @elizaos/core ejection state; create runs the multi-turn create-or-edit flow that scaffolds from the min-plugin template and dispatches a coding agent with AppVerificationService validator.
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
