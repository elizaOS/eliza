# `prompts.initialSummarizationTemplate`

- **Kind**: template
- **Owner**: packages/prompts
- **File**: `packages/prompts/src/index.ts:474`
- **Token count**: 182
- **Last optimized**: never

## Current text
```
# Task: Summarize Conversation

Create a concise summary capturing key points, topics, and details.

# Recent Messages
{{recentMessages}}

# Instructions
Generate a summary that:
1. Captures main topics
2. Highlights key information
3. Notes decisions and questions
4. Maintains context for future reference
5. Concise but comprehensive

**Keep summary under 2500 tokens.**

Also extract:
- **Topics**: main topics (comma-separated)
- **Key Points**: important facts or decisions (bullets)

JSON:
text: Your comprehensive summary here
topics[0]: topic1
topics[1]: topic2
topics[2]: topic3
keyPoints[0]: First key point
keyPoints[1]: Second key point

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
