# `action.UPDATE_MEETING_PREFERENCES@plugins/app-lifeops/src/actions/lib/scheduling-handler.ts.description`

- **Kind**: action-description
- **Owner**: plugins/app-lifeops
- **File**: `plugins/app-lifeops/src/actions/lib/scheduling-handler.ts:857`
- **Token count**: 71
- **Last optimized**: never
- **Action**: UPDATE_MEETING_PREFERENCES
- **Similes**: SET_MEETING_PREFERENCES, SAVE_MEETING_PREFERENCES, SET_PREFERRED_TIMES, SET_BLACKOUT_WINDOWS, SLEEP_WINDOW, NO_CALL_HOURS, PROTECT_SLEEP

## Current text
```
Persist the owner's meeting scheduling preferences: preferred start/end of day (24h HH:MM local), blackout windows, default meeting duration, and travel buffer. These drive PROPOSE_MEETING_TIMES. Use this for durable sleep windows, no-call hours, and other recurring scheduling rules.
```

## Compressed variant
```
Persist owner meeting preferences: preferred hours, blackout windows, default duration, and travel buffer.
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (106 chars vs 284 chars — 63% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
