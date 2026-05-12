# `action.IGNORE@packages/prompts/specs/actions/core.json.description`

- **Kind**: action-description
- **Owner**: packages/core
- **File**: `packages/prompts/specs/actions/core.json`
- **Token count**: 137
- **Last optimized**: never
- **Action**: IGNORE
- **Similes**: STOP_TALKING, STOP_CHATTING, STOP_CONVERSATION

## Current text
```
Call this action if ignoring the user. If the user is aggressive, creepy or is finished with the conversation, use this action. In group conversations, use IGNORE when the latest message is addressed to someone else and not to the agent. Or, if both you and the user have already said goodbye, use this action instead of saying bye again. Use IGNORE any time the conversation has naturally ended. Do not use IGNORE if the user has engaged directly, or if something went wrong and you need to tell them. Only ignore if the user should be ignored.
```

## Compressed variant
```
Ignore user when aggressive/creepy, convo ended, group msg addressed elsewhere, or both said goodbye. Don't use if user engaged directly or needs error info.
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (157 chars vs 545 chars — 71% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
