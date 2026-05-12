# `action.MESSAGE@packages/core/src/features/messaging/triage/actions/sendDraft.ts.description`

- **Kind**: action-description
- **Owner**: packages/core
- **File**: `packages/core/src/features/messaging/triage/actions/sendDraft.ts:220`
- **Token count**: 85
- **Last optimized**: never
- **Action**: MESSAGE
- **Similes**: DISPATCH_DRAFT, CONFIRM_AND_SEND, COMPOSE_MESSAGE, OUTBOUND_MESSAGE

## Current text
```
Create or send an owner-scoped outbound message draft. Use this for first-turn requests like 'send a Telegram message to Jane saying I am late', 'DM Bob on Discord', 'email Alice the notes', and 'text Sam that I am outside'. Without confirmed=true it only creates or previews the draft and asks for confirmation; it never sends directly.
```

## Compressed variant
```
owner outbound message draft/send confirmation-gated; use for Telegram Signal Discord email SMS/iMessage/DM send requests; never sends without confirmed=true
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (157 chars vs 337 chars — 53% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
