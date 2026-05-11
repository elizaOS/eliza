# `action.WINDOW@plugins/plugin-computeruse/src/actions/window.ts.description`

- **Kind**: action-description
- **Owner**: plugins/plugin-computeruse
- **File**: `plugins/plugin-computeruse/src/actions/window.ts:80`
- **Token count**: 72
- **Last optimized**: never
- **Action**: WINDOW
- **Similes**: MANAGE_WINDOW, WINDOW, USE_WINDOW, WINDOW_ACTION

## Current text
```
Single WINDOW action — manages local desktop windows through the computer-use service. Supported actions: list, focus, switch, arrange, move, minimize, maximize, restore, close. Pointer and keyboard primitives belong on COMPUTER_USE; file and shell operations belong on FILE and SHELL.
```

## Compressed variant
```
Single WINDOW action; action=list|focus|switch|arrange|move|minimize|maximize|restore|close manages local desktop windows.
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (122 chars vs 285 chars — 57% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
