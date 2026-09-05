/**
 * Compatibility type barrel for first-run scheduling consumers.
 * Scheduling owns the task record and input contracts.
 */

export type {
  ScheduledTask,
  ScheduledTaskCompletionCheck,
  ScheduledTaskInput,
  ScheduledTaskKind,
  ScheduledTaskPriority,
  ScheduledTaskSource,
  ScheduledTaskState,
  ScheduledTaskStatus,
  ScheduledTaskSubject,
  ScheduledTaskTrigger,
  TerminalState,
} from "@elizaos/plugin-scheduling";
