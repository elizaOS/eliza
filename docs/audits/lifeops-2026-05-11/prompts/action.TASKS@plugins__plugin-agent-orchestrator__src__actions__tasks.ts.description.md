# `action.TASKS@plugins/plugin-agent-orchestrator/src/actions/tasks.ts.description`

- **Kind**: action-description
- **Owner**: plugins/plugin-agent-orchestrator
- **File**: `plugins/plugin-agent-orchestrator/src/actions/tasks.ts:2161`
- **Token count**: 127
- **Last optimized**: never
- **Action**: TASKS
- **Similes**: CREATE_AGENT_TASK, CREATE_TASK, START_CODING_TASK, LAUNCH_CODING_TASK, RUN_CODING_TASK, START_AGENT_TASK, SPAWN_AND_PROVISION, CODE_THIS, LAUNCH_TASK, CREATE_SUBTASK, SPAWN_AGENT, SPAWN_CODING_AGENT, START_CODING_AGENT, LAUNCH_CODING_AGENT, CREATE_CODING_AGENT, SPAWN_CODER, RUN_CODING_AGENT, SPAWN_SUB_AGENT, START_TASK_AGENT, CREATE_AGENT, SEND_TO_AGENT, SEND_TO_CODING_AGENT, MESSAGE_CODING_AGENT, INPUT_TO_AGENT, RESPOND_TO_AGENT, TELL_CODING_AGENT, MESSAGE_AGENT, TELL_TASK_AGENT, STOP_AGENT, STOP_CODING_AGENT, KILL_CODING_AGENT, TERMINATE_AGENT, END_CODING_SESSION, CANCEL_AGENT, CANCEL_TASK_AGENT, STOP_SUB_AGENT, LIST_AGENTS, LIST_CODING_AGENTS, SHOW_CODING_AGENTS, GET_ACTIVE_AGENTS, LIST_SESSIONS, SHOW_CODING_SESSIONS, SHOW_TASK_AGENTS, LIST_SUB_AGENTS, SHOW_TASK_STATUS, CANCEL_TASK, STOP_TASK, ABORT_TASK, KILL_TASK, STOP_SUBTASK, TASK_HISTORY, LIST_TASK_HISTORY, GET_TASK_HISTORY, SHOW_TASKS, COUNT_TASKS, TASK_STATUS_HISTORY, TASK_CONTROL, CONTROL_TASK, PAUSE_TASK, RESUME_TASK, CONTINUE_TASK, ARCHIVE_TASK, REOPEN_TASK, TASK_SHARE, SHARE_TASK_RESULT, SHOW_TASK_ARTIFACT, VIEW_TASK_OUTPUT, CAN_I_SEE_IT, PULL_IT_UP, CREATE_WORKSPACE, PROVISION_WORKSPACE, CLONE_REPO, SETUP_WORKSPACE, PREPARE_WORKSPACE, SUBMIT_WORKSPACE, FINALIZE_WORKSPACE, COMMIT_AND_PR, CREATE_PR, SUBMIT_CHANGES, FINISH_WORKSPACE, MANAGE_ISSUES, CREATE_ISSUE, LIST_ISSUES, CLOSE_ISSUE, COMMENT_ISSUE, UPDATE_ISSUE, GET_ISSUE, ARCHIVE_CODING_TASK, CLOSE_CODING_TASK, ARCHIVE_TASK_THREAD, REOPEN_CODING_TASK, UNARCHIVE_CODING_TASK, RESUME_CODING_TASK

## Current text
```
Single planner-visible surface for the orchestrator's task-agent and workspace lifecycle. Pick `action` to dispatch: create / spawn_agent / send / stop_agent / list_agents / cancel / history / control / share / provision_workspace / submit_workspace / manage_issues / archive / reopen. Use `control` with controlAction=pause|resume|stop|continue|archive|reopen for task-thread state transitions, and `manage_issues` with issueAction=create|list|get|update|comment|close|reopen|add_labels for GitHub issues.
```

## Compressed variant
```
tasks: action=create|spawn_agent|send|stop_agent|list_agents|cancel|history|control|share|provision_workspace|submit_workspace|manage_issues|archive|reopen
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (155 chars vs 506 chars — 69% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
