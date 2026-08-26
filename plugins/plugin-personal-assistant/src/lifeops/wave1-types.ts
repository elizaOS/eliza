/**
 * Scheduled-task types used by the `first-run` module. Re-exports the canonical
 * contracts from `@elizaos/plugin-scheduling` to prevent contract duplication.
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
