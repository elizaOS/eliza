# `action.MESSAGE@packages/core/src/features/messaging/triage/actions/respondToMessage.ts.description`

- **Kind**: action-description
- **Owner**: packages/core
- **File**: `packages/core/src/features/messaging/triage/actions/respondToMessage.ts:65`
- **Token count**: 77
- **Last optimized**: never
- **Action**: MESSAGE
- **Similes**: REPLY_TO_MESSAGE, QUICK_REPLY, ONE_SHOT_REPLY

## Current text
```
Reply to a message in one step. Use this when the user asks to send/respond/reply now, including natural-language targets like last email from finance; pass messageId when known, otherwise pass sender/content hints. Drafts the reply, then sends or queues it for owner approval per the registered SendPolicy.
```

## Compressed variant
```
send/respond reply to msg: target by messageId or latest/from sender/content hints; draft policy-gate send
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (106 chars vs 307 chars — 65% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
