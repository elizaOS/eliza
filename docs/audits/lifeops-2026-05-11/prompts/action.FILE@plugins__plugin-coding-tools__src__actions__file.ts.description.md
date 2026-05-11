# `action.FILE@plugins/plugin-coding-tools/src/actions/file.ts.description`

- **Kind**: action-description
- **Owner**: plugins/plugin-coding-tools
- **File**: `plugins/plugin-coding-tools/src/actions/file.ts:81`
- **Token count**: 53
- **Last optimized**: never
- **Action**: FILE
- **Similes**: READ, WRITE, EDIT, GREP, GLOB, LS, READ_FILE, WRITE_FILE, EDIT_FILE, FILE_OPERATION, FILE_IO

## Current text
```
Read, write, edit, search, find, or list workspace files through one FILE action. Choose action=read/write/edit/grep/glob/ls. All paths must be absolute unless an operation explicitly defaults to the session cwd.
```

## Compressed variant
```
File operations umbrella: action=read/write/edit/grep/glob/ls.
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (62 chars vs 212 chars — 71% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
