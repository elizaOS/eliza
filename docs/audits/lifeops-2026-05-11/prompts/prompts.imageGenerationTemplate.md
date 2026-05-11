# `prompts.imageGenerationTemplate`

- **Kind**: template
- **Owner**: packages/prompts
- **File**: `packages/prompts/src/index.ts:455`
- **Token count**: 94
- **Last optimized**: never

## Current text
```
# Task: Generate image prompt for {{agentName}}.

{{providers}}

# Instructions:
Create a specific, descriptive image-generation prompt based on the conversation.

# Recent conversation:
{{recentMessages}}

JSON:
thought: Your reasoning for the image prompt
prompt: Detailed image generation prompt

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
