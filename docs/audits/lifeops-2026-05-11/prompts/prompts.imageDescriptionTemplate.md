# `prompts.imageDescriptionTemplate`

- **Kind**: template
- **Owner**: packages/prompts
- **File**: `packages/prompts/src/index.ts:436`
- **Token count**: 191
- **Last optimized**: never

## Current text
```
Task: Analyze image and generate description with multiple detail levels.

Provide:
1. Concise descriptive title capturing main subject/scene
2. Brief summary (1-2 sentences) of key elements
3. Extensive description: visible elements, composition, lighting, colors, mood, etc.

Be objective. Describe what you see; don't assume context or meaning.

JSON:
title: A concise, descriptive title for the image
description: A brief 1-2 sentence summary of the key elements in the image
text: An extensive, detailed description covering all visible elements, composition, lighting, colors, mood, setting, objects, people, activities, and any other relevant details you can observe in the image

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
- Repeated phrase: `visible elements, composition, lighting, colors,` — appears more than once; consider deduping for token savings.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
