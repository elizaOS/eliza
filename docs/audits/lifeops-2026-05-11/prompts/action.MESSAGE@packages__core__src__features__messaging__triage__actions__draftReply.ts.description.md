# `action.MESSAGE@packages/core/src/features/messaging/triage/actions/draftReply.ts.description`

- **Kind**: action-description
- **Owner**: packages/core
- **File**: `packages/core/src/features/messaging/triage/actions/draftReply.ts:38`
- **Token count**: 73
- **Last optimized**: never
- **Action**: MESSAGE
- **Similes**: COMPOSE_REPLY, DRAFT_MESSAGE_REPLY

## Current text
```
Compose a draft reply to an existing message. Use this when the user asks to draft a reply, including natural-language targets like latest email from Sarah; pass messageId when known, otherwise pass sender/content hints. Never sends — produces a preview that must be confirmed via MESSAGE.
```

## Compressed variant
```
draft reply only; can target by messageId or latest/from sender/content hints; never sends
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (90 chars vs 289 chars — 69% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
