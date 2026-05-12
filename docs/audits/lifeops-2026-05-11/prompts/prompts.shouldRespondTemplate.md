# `prompts.shouldRespondTemplate`

- **Kind**: template
- **Owner**: packages/prompts
- **File**: `packages/prompts/src/index.ts:1030`
- **Token count**: 401
- **Last optimized**: never

## Current text
```
task: Decide whether {{agentName}} should respond, ignore, or stop.

context:
{{providers}}

rules[7]:
- direct mention of {{agentName}} -> RESPOND
- different assistant name or talking to someone else -> IGNORE unless {{agentName}} is also directly addressed
- prior participation alone is not enough; newest message must clearly expect {{agentName}} -> otherwise IGNORE
- request to stop or be quiet directed at {{agentName}} -> STOP
- if multiple people mentioned and {{agentName}} is one of the addressees -> RESPOND
- in groups, if latest message is addressed to someone else, IGNORE
- when unsure, default IGNORE

available_contexts:
{{availableContexts}}

context_routing:
- contexts: zero or more context ids from available_contexts
- use [] when no tool or context provider is needed
- if contexts non-empty, planning runs and simple is ignored

decision_note:
- respond only when latest message is talking TO {{agentName}}
- talking TO {{agentName}}: name mention, reply chain, or clear follow-up
- mentions of others don't cancel direct address
- casual conversation between others is not enough
- if another assistant answered and nobody re-addressed, IGNORE
- if {{agentName}} replied recently and nobody re-addressed, IGNORE
- talking ABOUT {{agentName}} is not enough

output:
JSON only. One JSON object. No prose, no <think>.

Example:
{
  "action": "RESPOND",
  "simple": true,
  "contexts": [],
  "thought": "Direct mention and clear follow-up.",
  "reply": "Short direct reply when no context is needed."
}

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
- Repeated phrase: `and nobody re-addressed, ignore -` — appears more than once; consider deduping for token savings.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
