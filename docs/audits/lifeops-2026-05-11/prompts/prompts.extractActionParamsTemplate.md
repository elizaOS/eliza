# `prompts.extractActionParamsTemplate`

- **Kind**: template
- **Owner**: packages/prompts
- **File**: `packages/prompts/src/index.ts:199`
- **Token count**: 153
- **Last optimized**: never

## Current text
```
You are filling in missing parameters for the {{actionName}} action.
Action description: {{actionDescription}}

Parameter schema:
{{schemaLines}}

Already-supplied parameters: {{existingJson}}

Missing required fields you must extract: {{missingFields}}

{{recentConversationBlock}}

Current user message: {{currentMessageText}}

Return a JSON object containing values for the MISSING fields.
If a value is genuinely indeterminable from the conversation, return null for that field.
Example: {"subaction": "search", "query": "github"}

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
