# `action.WORK_THREAD@plugins/app-lifeops/src/actions/work-thread.ts.description`

- **Kind**: action-description
- **Owner**: plugins/app-lifeops
- **File**: `plugins/app-lifeops/src/actions/work-thread.ts:302`
- **Token count**: 55
- **Last optimized**: never
- **Action**: WORK_THREAD
- **Similes**: THREAD_CONTROL, STEER_THREAD, STOP_THREAD, CREATE_THREAD, SCHEDULE_THREAD_FOLLOWUP, MESSAGE_CREATE_GROUP_HANDOFF

## Current text
```
Create, steer, stop, wait, complete, merge, attach source refs to, or schedule follow-up work for owner work threads. Use only for thread lifecycle/routing; domain work stays on existing task/messaging/workflow actions.
```

## Compressed variant
```
work-thread lifecycle: create|steer|stop|mark_waiting|mark_completed|merge|attach_source|schedule_followup
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (106 chars vs 219 chars — 52% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
