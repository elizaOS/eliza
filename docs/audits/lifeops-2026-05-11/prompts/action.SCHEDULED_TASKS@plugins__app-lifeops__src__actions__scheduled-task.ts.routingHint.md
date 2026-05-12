# `action.SCHEDULED_TASKS@plugins/app-lifeops/src/actions/scheduled-task.ts.routingHint`

- **Kind**: routing-hint
- **Owner**: plugins/app-lifeops
- **File**: `plugins/app-lifeops/src/actions/scheduled-task.ts:635`
- **Token count**: 60
- **Last optimized**: never
- **Action**: SCHEDULED_TASKS

## Current text
```
reminder/checkin/followup/approval/recap/watcher/output state ("snooze that", "what follow-ups today", "complete the check-in", "show task history") -> SCHEDULED_TASKS; per-occurrence owner reminder verbs (complete/skip/snooze a definition\
```

## Compressed variant
```
none
```

## Usage stats (latest trajectories)
- Invocations: 33
- Success rate: 0.88
- Avg input chars when matched: 58493

## Sample failure transcripts
- traj `tj-ff0d32930f4070` scenario `shower-weekly-basic__childlike` status=errored stage=planner
  - user: `Can you help me with this please? Please remind me to shower three times a week.`
- traj `tj-ff0d32930f4070` scenario `shower-weekly-basic__childlike` status=errored stage=planner
  - user: `Can you help me with this please? Please remind me to shower three times a week.`
- traj `tj-ff0d32930f4070` scenario `shower-weekly-basic__childlike` status=errored stage=planner
  - user: `Can you help me with this please? Please remind me to shower three times a week.`

## Suggested edits (heuristic)
None.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
