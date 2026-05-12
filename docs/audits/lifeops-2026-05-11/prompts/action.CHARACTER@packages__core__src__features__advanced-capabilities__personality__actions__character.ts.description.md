# `action.CHARACTER@packages/core/src/features/advanced-capabilities/personality/actions/character.ts.description`

- **Kind**: action-description
- **Owner**: packages/core
- **File**: `packages/core/src/features/advanced-capabilities/personality/actions/character.ts:102`
- **Token count**: 69
- **Last optimized**: never
- **Action**: CHARACTER
- **Similes**: MODIFY_CHARACTER, PERSIST_CHARACTER, UPDATE_IDENTITY, UPDATE_OWNER_NAME, IDENTITY, SET_IDENTITY, UPDATE_AGENT_NAME, UPDATE_SYSTEM_PROMPT, SET_AGENT_NAME, SET_SYSTEM_PROMPT, RENAME_AGENT

## Current text
```
Modify, persist, or update the agent character. Actions: modify (LLM-driven personality, tone, voice, style, bio, name, topics, response format) | persist (flush in-memory runtime.character to the persistence service) | update_identity (rename agent or replace system prompt).
```

## Compressed variant
```
Character action=modify|persist|update_identity.
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (48 chars vs 276 chars — 83% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
