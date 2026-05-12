# `action.MESSAGE@packages/core/src/features/advanced-capabilities/actions/message.ts.description`

- **Kind**: action-description
- **Owner**: packages/core
- **File**: `packages/core/src/features/advanced-capabilities/actions/message.ts:3546`
- **Token count**: 113
- **Last optimized**: never
- **Action**: MESSAGE
- **Similes**: DM, DIRECT_MESSAGE, CHAT, CHANNEL, ROOM, INBOX_LIST_UNREAD, INBOX_TRIAGE_PRIORITY, INBOX_SUMMARIZE_CHANNEL, MESSAGE_DRAFT_REPLY, MESSAGE_SEND_APPROVAL_REQUEST, MESSAGE_SEND_CONFIRMED, MESSAGE_ARCHIVE_OR_DEFER, MESSAGE_REPAIR_AFTER_MISS, FOLLOWUP_CREATE_DRAFT, FOLLOWUP_SEND_CONFIRMED

## Current text
```
Primary action for addressed messaging surfaces: DMs, group chats, channels, rooms, threads, servers, users, inboxes, drafts, and owner message workflows. Choose action=send, read_channel, read_with_contact, search, list_channels, list_servers, react, edit, delete, pin, join, leave, get_user, triage, list_inbox, search_inbox, draft_reply, draft_followup, respond, send_draft, schedule_draft_send, or manage. Public feed publishing belongs to POST.
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
- Compressed variant exists (302 chars vs 449 chars — 33% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
