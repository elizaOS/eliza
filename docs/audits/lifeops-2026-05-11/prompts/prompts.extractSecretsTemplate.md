# `prompts.extractSecretsTemplate`

- **Kind**: template
- **Owner**: packages/prompts
- **File**: `packages/prompts/src/index.ts:282`
- **Token count**: 239
- **Last optimized**: never

## Current text
```
Extract secret/configuration values from user's message.

User wants to set one or more secrets. Extract:
1. Secret key (UPPERCASE_WITH_UNDERSCORES)
2. Secret value
3. Optional description
4. Type (api_key, secret, credential, url, or config)

Common patterns:
- "Set my OpenAI key to sk-..." -> key: OPENAI_API_KEY, value: sk-...
- "My Anthropic API key is sk-ant-..." -> key: ANTHROPIC_API_KEY, value: sk-ant-...
- "Use this Discord token: ..." -> key: DISCORD_BOT_TOKEN, value: ...
- "Set DATABASE_URL to postgres://..." -> key: DATABASE_URL, value: postgres://...

{{recentMessages}}

Extract the secrets. If key name not specified, infer an UPPERCASE_WITH_UNDERSCORES name from context.

Output JSON only. One JSON object, no prose or fences.
Use:
secrets[n]{key,value,description,type}:
level: global|world|user

Omit description/type/level when unknown. No XML or JSON.

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
