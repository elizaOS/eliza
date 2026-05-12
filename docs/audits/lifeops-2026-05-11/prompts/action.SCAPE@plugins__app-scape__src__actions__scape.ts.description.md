# `action.SCAPE@plugins/app-scape/src/actions/scape.ts.description`

- **Kind**: action-description
- **Owner**: plugins/app-scape
- **File**: `plugins/app-scape/src/actions/scape.ts:266`
- **Token count**: 93
- **Last optimized**: never
- **Action**: SCAPE
- **Similes**: SCAPE_WALK_TO, MOVE_TO, GO_TO, TRAVEL_TO, HEAD_TO, ATTACK_NPC, FIGHT_NPC, KILL_NPC, ENGAGE, CHAT_PUBLIC, SAY, SPEAK, TALK, BROADCAST, JOURNAL, INVENTORY, SET_GOAL, COMPLETE_GOAL, REMEMBER, EAT_FOOD, DROP_ITEM

## Current text
```
Drive the 'scape (xRSPS) game agent. Pick one action: walk_to (x,z,run?), attack (npcId), chat_public (message), eat (item?), drop (item), set_goal (title,notes?), complete_goal (status?,goalId?,notes?), remember (notes,kind?,weight?). Returns success and a short status message; the autonomous loop already handles its own dispatch — this is the planner-facing surface.
```

## Compressed variant
```
scape actions: walk_to|attack|chat_public|eat|drop|set_goal|complete_goal|remember
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (82 chars vs 370 chars — 78% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
