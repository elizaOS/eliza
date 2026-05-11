# `action.MESSAGE@packages/core/src/features/messaging/triage/actions/searchMessages.ts.description`

- **Kind**: action-description
- **Owner**: packages/core
- **File**: `packages/core/src/features/messaging/triage/actions/searchMessages.ts:19`
- **Token count**: 93
- **Last optimized**: never
- **Action**: MESSAGE
- **Similes**: SEARCH_INBOX, FIND_MESSAGE, SEARCH_EMAIL, SEARCH_CHATS, CROSS_CHANNEL_SEARCH

## Current text
```
Read-only search across connected message channels with combinable filters: source/connector, world (account), channel, sender, content keyword, tags, time range. Returns merged hits with citations. Do not use for requests to draft, reply, send, unsubscribe, block, archive, trash, label, or otherwise mutate messages; use MESSAGE, MESSAGE, MESSAGE, or MESSAGE instead.
```

## Compressed variant
```
read-only search msgs; not for draft reply send unsubscribe archive trash label mutate
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (86 chars vs 369 chars — 77% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
