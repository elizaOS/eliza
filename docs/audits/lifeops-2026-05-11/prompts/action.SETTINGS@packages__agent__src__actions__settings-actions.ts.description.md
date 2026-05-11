# `action.SETTINGS@packages/agent/src/actions/settings-actions.ts.description`

- **Kind**: action-description
- **Owner**: packages/agent
- **File**: `packages/agent/src/actions/settings-actions.ts:536`
- **Token count**: 53
- **Last optimized**: never
- **Action**: SETTINGS
- **Similes**: UPDATE_AI_PROVIDER, TOGGLE_CAPABILITY, TOGGLE_AUTO_TRAINING, SET_USER_NAME, SET_OWNER_NAME, UPDATE_OWNER_NAME, REMEMBER_NAME, SAVE_NAME, SET_NAME

## Current text
```
Owner-only polymorphic settings mutation. Dispatches on `action` to update AI provider, toggle a capability, toggle/configure auto-training, set the owner display name, or write to the world's settings registry.
```

## Compressed variant
```
owner-only settings mutation dispatch on action update AI provider, toggle capability, toggle/configure auto-train, set owner display name, write world settings registry
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (169 chars vs 211 chars — 20% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
