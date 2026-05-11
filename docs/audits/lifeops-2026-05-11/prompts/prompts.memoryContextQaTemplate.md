# `prompts.memoryContextQaTemplate`

- **Kind**: template
- **Owner**: packages/prompts
- **File**: `packages/prompts/src/index.ts:642`
- **Token count**: 83
- **Last optimized**: never

## Current text
```
You are a concise context assistant.
Answer only from the provided context. If context is insufficient, say so explicitly.
Keep the answer under 120 words.

Query: {{query}}

Saved memory notes:
{{memorySection}}

Knowledge snippets:
{{knowledgeSection}}

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
