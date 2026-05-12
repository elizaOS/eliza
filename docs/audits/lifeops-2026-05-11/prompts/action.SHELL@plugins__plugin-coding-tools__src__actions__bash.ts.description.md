# `action.SHELL@plugins/plugin-coding-tools/src/actions/bash.ts.description`

- **Kind**: action-description
- **Owner**: plugins/plugin-coding-tools
- **File**: `plugins/plugin-coding-tools/src/actions/bash.ts:62`
- **Token count**: 59
- **Last optimized**: never
- **Action**: SHELL
- **Similes**: BASH, EXEC, RUN_COMMAND

## Current text
```
Execute a shell command via the configured local shell. Runs synchronously in the session cwd by default. Returns stdout, stderr, and exit code. Hard timeout kills the command. Paths under the configured blocklist are off-limits as cwd.
```

## Compressed variant
```
Run a shell command synchronously.
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (34 chars vs 236 chars — 86% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
