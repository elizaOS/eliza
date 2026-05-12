# `prompts.updateSettingsTemplate`

- **Kind**: template
- **Owner**: packages/prompts
- **File**: `packages/prompts/src/index.ts:1252`
- **Token count**: 99
- **Last optimized**: never

## Current text
```
# Task: Update settings based on the request.

{{providers}}

# Current Settings:
{{settings}}

# Instructions:
Determine which settings to update. Only update what user explicitly requested.

Example output:
thought: User asked to switch the default model to gpt-5.5.
updates[1]{key,value}:
  default_model,gpt-5.5

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
