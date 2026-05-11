# `prompts.mobileDirectReplyTemplate`

- **Kind**: template
- **Owner**: packages/prompts
- **File**: `packages/prompts/src/index.ts:736`
- **Token count**: 83
- **Last optimized**: never

## Current text
```
{{system}}

Answer the user directly. Do not select actions, do not return structured control output, and do not explain internal reasoning.
If the user asks for exact words, output exactly those words and nothing else.

User: {{userText}}
{{agentName}}:

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
