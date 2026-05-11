# `prompts.optionExtractionTemplate`

- **Kind**: template
- **Owner**: packages/prompts
- **File**: `packages/prompts/src/index.ts:770`
- **Token count**: 131
- **Last optimized**: never

## Current text
```
# Task: Extract selected task and option from user message

# Available Tasks:
{{tasks}}

# Recent Messages:
{{recentMessages}}

# Instructions:
1. Identify which task and option the user is selecting
2. Match against available tasks and options, including ABORT
3. Return task ID (shortened UUID) and option name exactly as listed
4. If no clear selection, return null for both

JSON:
taskId: string_or_null
selectedOption: OPTION_NAME_or_null

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
