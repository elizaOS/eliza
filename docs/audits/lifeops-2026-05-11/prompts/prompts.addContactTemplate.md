# `prompts.addContactTemplate`

- **Kind**: template
- **Owner**: packages/prompts
- **File**: `packages/prompts/src/index.ts:10`
- **Token count**: 186
- **Last optimized**: never

## Current text
```
task: Extract contact information to add to relationships.

context:
{{providers}}

recent_messages:
{{recentMessages}}

current_message:
{{message}}

instructions[5]:
- identify the contact name being added
- include entityId only when explicitly known from context
- return categories as comma-separated list
- include notes, timezone, language only when clearly present
- include short reason for saving this contact

output:
JSON only. One JSON object. No prose, no <think>.

Example:
contactName: Jane Doe
entityId:
categories: vip,colleague
notes: Met at the design summit
timezone: America/New_York
language: English
reason: Important collaborator to remember

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
- Repeated phrase: `one json object. no prose,` — appears more than once; consider deduping for token savings.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
