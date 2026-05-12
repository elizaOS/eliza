# `action.MESSAGE@packages/core/src/features/messaging/triage/actions/triageMessages.ts.description`

- **Kind**: action-description
- **Owner**: packages/core
- **File**: `packages/core/src/features/messaging/triage/actions/triageMessages.ts:24`
- **Token count**: 55
- **Last optimized**: never
- **Action**: MESSAGE
- **Similes**: PRIORITIZE_MESSAGES, RANK_INBOX, SCAN_MESSAGES

## Current text
```
Fetch unread/recent messages across connected platforms (gmail, discord, telegram, twitter, imessage, signal, whatsapp), score each one with deterministic contact+urgency heuristics, and return a priority-ranked list.
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
- Compressed variant exists (302 chars vs 217 chars — -39% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
