# `action.MESSAGE@packages/core/src/features/messaging/triage/actions/scheduleDraftSend.ts.description`

- **Kind**: action-description
- **Owner**: packages/core
- **File**: `packages/core/src/features/messaging/triage/actions/scheduleDraftSend.ts:22`
- **Token count**: 39
- **Last optimized**: never
- **Action**: MESSAGE
- **Similes**: DEFER_SEND, SCHEDULE_SEND, SEND_LATER

## Current text
```
Schedule a previously created draft to send at a future time. Uses the adapter's native scheduling if supported; otherwise enqueues a process-local timer.
```

## Compressed variant
```
schedule draft send sendAtMs adapter-native or fallback queue
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
