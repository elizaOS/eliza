# `action.MC@packages/prompts/specs/actions/plugins.generated.json.description`

- **Kind**: action-description
- **Owner**: spec-only
- **File**: `packages/prompts/specs/actions/plugins.generated.json`
- **Token count**: 78
- **Last optimized**: never
- **Action**: MC

## Current text
```
Drive a Minecraft bot. Choose one action: connect (host?,port?,username?,auth?,version?), disconnect, goto (x,y,z), stop, look (yaw,pitch), control (control,state,durationMs?), waypoint_goto (name), dig (x,y,z), place (x,y,z,face), chat (message), attack (entityId), waypoint_set (name), waypoint_delete (name).
```

## Compressed variant
```
minecraft ops: connect|disconnect|goto|stop|look|control|waypoint_*|dig|place|chat|attack
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (89 chars vs 311 chars — 71% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
