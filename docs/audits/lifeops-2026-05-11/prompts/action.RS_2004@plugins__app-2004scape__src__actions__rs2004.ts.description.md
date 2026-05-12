# `action.RS_2004@plugins/app-2004scape/src/actions/rs2004.ts.description`

- **Kind**: action-description
- **Owner**: plugins/app-2004scape
- **File**: `plugins/app-2004scape/src/actions/rs2004.ts:502`
- **Token count**: 108
- **Last optimized**: never
- **Action**: RS_2004

## Current text
```
Drive the 2004scape game agent. Choose one action (walk_to, chop, mine, fish, burn, cook, fletch, craft, smith, drop, pickup, equip, unequip, use, use_on_item, use_on_object, open, close, deposit, withdraw, buy, sell, attack, cast_spell, set_style, eat, talk, navigate_dialog, interact_object, open_door, pickpocket). For open/close, set target='bank' or target='shop' (or include npc to imply shop). Per-action fields go in params.
```

## Compressed variant
```
rs_2004 actions (walk_to, skills, inventory, bank, shop, combat, interact)
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (74 chars vs 432 chars — 83% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
