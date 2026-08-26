/**
 * Wave-1 contract types for the W1-A `ScheduledTask` schema and the W1-D
 * `DefaultPack` envelope. Re-exports canonical contracts from `@elizaos/plugin-scheduling`.
 */
import type {
  AnchorConsolidationPolicy,
  EscalationStep,
  ScheduledTask,
  ScheduledTaskCompletionCheck,
  ScheduledTaskContextRequest,
  ScheduledTaskInput,
  ScheduledTaskKind,
  ScheduledTaskOutput,
  ScheduledTaskOutputDestination,
  ScheduledTaskPipeline,
  ScheduledTaskPriority,
  ScheduledTaskRef,
  ScheduledTaskShouldFire,
  ScheduledTaskSource,
  ScheduledTaskState,
  ScheduledTaskStatus,
  ScheduledTaskSubject,
  ScheduledTaskSubjectKind,
  ScheduledTaskTrigger,
  TerminalState,
} from "@elizaos/plugin-scheduling";

export type {
  AnchorConsolidationPolicy,
  EscalationStep,
  ScheduledTask,
  ScheduledTaskCompletionCheck,
  ScheduledTaskContextRequest,
  ScheduledTaskInput,
  ScheduledTaskKind,
  ScheduledTaskOutput,
  ScheduledTaskOutputDestination,
  ScheduledTaskPipeline,
  ScheduledTaskPriority,
  ScheduledTaskRef,
  ScheduledTaskShouldFire,
  ScheduledTaskSource,
  ScheduledTaskState,
  ScheduledTaskStatus,
  ScheduledTaskSubject,
  ScheduledTaskSubjectKind,
  ScheduledTaskTrigger,
  TerminalState,
};

/** Default-pack records are `ScheduledTask`s without runner-managed fields. */
export type ScheduledTaskSeed = ScheduledTaskInput;

export type DefaultEscalationLadderKey =
  | "priority_low_default"
  | "priority_medium_default"
  | "priority_high_default";

export interface EscalationLadder {
  steps: EscalationStep[];
}

export interface DefaultPack {
  key: string;
  label: string;
  description: string;
  defaultEnabled: boolean;
  requiredCapabilities?: string[];
  records: ScheduledTaskSeed[];
  consolidationPolicies?: AnchorConsolidationPolicy[];
  escalationLadders?: Partial<
    Record<DefaultEscalationLadderKey, EscalationLadder>
  >;
  uiHints?: {
    summaryOnDayOne: string;
    expectedFireCountPerDay: number;
  };
}

export interface DefaultPackRegistry {
  register(pack: DefaultPack): void;
  list(): DefaultPack[];
  get(key: string): DefaultPack | null;
}
