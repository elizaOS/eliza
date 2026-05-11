# `action.REPLY@packages/prompts/specs/actions/core.json.description`

- **Kind**: action-description
- **Owner**: packages/core
- **File**: `packages/prompts/specs/actions/core.json`
- **Token count**: 97
- **Last optimized**: never
- **Action**: REPLY
- **Similes**: GREET, RESPOND, RESPONSE

## Current text
```
Send a direct chat reply in the current conversation/thread. Default if the agent is responding with a message and no other action. Use REPLY at the beginning of a chain of actions as an acknowledgement, and at the end of a chain of actions as a final response. This is not an email reply, inbox workflow, or external-channel send — use the dedicated connector actions for those surfaces.
```

## Compressed variant
```
Reply in current chat only; use connector actions for external connector sends.
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (79 chars vs 388 chars — 80% shorter). Consider promoting it when planner cache pressure is high.
- Repeated phrase: `of a chain of actions` — appears more than once; consider deduping for token savings.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
