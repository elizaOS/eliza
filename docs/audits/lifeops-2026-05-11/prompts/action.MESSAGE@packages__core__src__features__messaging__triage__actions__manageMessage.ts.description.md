# `action.MESSAGE@packages/core/src/features/messaging/triage/actions/manageMessage.ts.description`

- **Kind**: action-description
- **Owner**: packages/core
- **File**: `packages/core/src/features/messaging/triage/actions/manageMessage.ts:39`
- **Token count**: 86
- **Last optimized**: never
- **Action**: MESSAGE
- **Similes**: ARCHIVE_MESSAGE, TAG_MESSAGE, UNSUBSCRIBE, BLOCK_SENDER, MARK_READ

## Current text
```
Mutate a single message or sender: archive, trash, mark spam, mark read/unread, add or remove a label or tag, mute thread, unsubscribe, or block a sender. Use this for unsubscribe/block/archive/delete/label requests, including natural-language targets like newsletters@medium.com; pass messageId when known, otherwise pass sender/content hints.
```

## Compressed variant
```
mutate msg/sender: archive trash spam mark-read label tag mute unsubscribe block; target by messageId or sender/content
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (119 chars vs 344 chars — 65% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
