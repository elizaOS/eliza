# `action.MESSAGE@packages/core/src/features/messaging/triage/actions/listInbox.ts.description`

- **Kind**: action-description
- **Owner**: packages/core
- **File**: `packages/core/src/features/messaging/triage/actions/listInbox.ts:20`
- **Token count**: 91
- **Last optimized**: never
- **Action**: MESSAGE
- **Similes**: LIST_MESSAGES, SHOW_UNREAD_ACROSS

## Current text
```
Read-only list of unread messages from every connected platform as one feed, sorted by priority and recency. Use when the user asks 'what's in my inbox across everything' or 'show me unread across all platforms'. Do not use as the first step for respond/reply-to-inbox or needs-answer requests; use MESSAGE so reply-worthy messages are identified before drafting.
```

## Compressed variant
```
primary message action operations send read_channel read_with_contact search list_channels list_servers react edit delete pin join leave get_user triage list_inbox search_inbox draft_reply draft_followup respond send_draft schedule_draft_send manage dm group channel room thread user server inbox draft
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (302 chars vs 363 chars — 17% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
