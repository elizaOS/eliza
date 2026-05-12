# `prompts.chooseOptionTemplate`

- **Kind**: template
- **Owner**: packages/prompts
- **File**: `packages/prompts/src/index.ts:148`
- **Token count**: 95
- **Last optimized**: never

## Current text
```
# Task: Choose an option from available choices.

{{providers}}

# Available Options:
{{options}}

# Instructions:
Select the most appropriate option based on context. Provide reasoning and selected option ID.

JSON:
thought: Your reasoning for the selection
selected_id: The ID of the selected option

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
