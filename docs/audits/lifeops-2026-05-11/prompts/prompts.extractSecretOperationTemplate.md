# `prompts.extractSecretOperationTemplate`

- **Kind**: template
- **Owner**: packages/prompts
- **File**: `packages/prompts/src/index.ts:222`
- **Token count**: 276
- **Last optimized**: never

## Current text
```
Manage secrets for an AI agent.

Determine the operation:
- get: Retrieve a secret value
- set: Store a new secret
- delete: Remove a secret
- list: Show all secrets (without values)
- check: Check if a secret exists

Common patterns:
- "What is my OpenAI key?" -> operation: get, key: OPENAI_API_KEY
- "Do I have a Discord token set?" -> operation: check, key: DISCORD_BOT_TOKEN
- "Show me my secrets" -> operation: list
- "Delete my old API key" -> operation: delete
- "Remove TWITTER_API_KEY" -> operation: delete, key: TWITTER_API_KEY
- "Set my key to sk-..." -> operation: set, key: <infer>, value: sk-...

{{recentMessages}}

Extract operation, key (if applicable), value (if applicable), level, description, and type.

Output JSON only. One JSON object, no prose or fences.
Use only these fields:
operation: get|set|delete|list|check
key: OPENAI_API_KEY
value: secret_value
level: global|world|user
description: short_description
type: api_key|secret|credential|url|config

Omit unknown optional fields. No XML or JSON.

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.

```

## Compressed variant
```
none
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
None.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
