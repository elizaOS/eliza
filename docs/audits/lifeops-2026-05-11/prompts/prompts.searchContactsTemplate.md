# `prompts.searchContactsTemplate`

- **Kind**: template
- **Owner**: packages/prompts
- **File**: `packages/prompts/src/index.ts:965`
- **Token count**: 148
- **Last optimized**: never

## Current text
```
task: Extract contact search criteria from the request.

context:
{{providers}}

current_message:
{{message}}

instructions[5]:
- categories: comma-separated list when user filters by category
- tags: comma-separated list when user filters by tags
- searchTerm: name or free-text lookup
- intent=count when user wants a count, else list
- omit fields not clearly requested

output:
JSON only. One JSON object. No prose, no <think>.

Example:
categories: vip,colleague
searchTerm: Jane
tags: ai,design
intent: list

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
- Repeated phrase: `comma-separated list when user filters` — appears more than once; consider deduping for token savings.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
