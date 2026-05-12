# `action.SCHEDULED_TASKS@plugins/app-lifeops/src/actions/scheduled-task.ts.description`

- **Kind**: action-description
- **Owner**: plugins/app-lifeops
- **File**: `plugins/app-lifeops/src/actions/scheduled-task.ts:631`
- **Token count**: 60
- **Last optimized**: never
- **Action**: SCHEDULED_TASKS
- **Similes**: TASKS, SCHEDULED_TASK, REMINDER_TASK, SCHEDULED_REMINDER, SCHEDULED_FOLLOWUP, TASK_SNOOZE, TASK_COMPLETE, TASK_ACKNOWLEDGE, TASK_DISMISS, ADD_FOLLOW_UP, COMPLETE_FOLLOW_UP, FOLLOW_UP_LIST, DAYS_SINCE, LIST_OVERDUE_FOLLOWUPS, MARK_FOLLOWUP_DONE, SET_FOLLOWUP_THRESHOLD, EVENT_SET_DECISION_DEADLINE, EVENT_TRACK_ASSET_DEADLINES, NOTIFICATION_CREATE_INTENT, NOTIFICATION_ACKNOWLEDGE, NOTIFICATION_ESCALATE

## Current text
```
Manage the owner's scheduled-task spine: reminders, check-ins, follow-ups, approvals, recaps, watchers, outputs, and custom tasks. Actions: list, get, create, update, snooze, skip, complete, acknowledge, dismiss, cancel, reopen, history.
```

## Compressed variant
```
scheduled tasks: list|get|create|update|snooze|skip|complete|acknowledge|dismiss|cancel|reopen|history; kinds reminder|checkin|followup|approval|recap|watcher|output|custom
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (172 chars vs 237 chars — 27% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
