import type {
  ScheduledTask,
  ScheduledTaskContextRequest,
  ScheduledTaskSeed,
  ScheduledTaskSubjectKind,
  ScheduledTaskTrigger,
} from "./contract-stubs.js";

type ScheduledTaskSeedBase = Omit<ScheduledTaskSeed, "kind">;

export type CompiledTaskDefinition = ScheduledTaskSeed;

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

interface TaskDefinitionBase {
  promptInstructions: string;
  contextRequest?: ScheduledTaskContextRequest;
  trigger: ScheduledTaskTrigger;
  priority: ScheduledTask["priority"];
  shouldFire?: ScheduledTaskSeedBase["shouldFire"];
  escalation?: ScheduledTaskSeedBase["escalation"];
  pipeline?: ScheduledTaskSeedBase["pipeline"];
  idempotencyKey?: string;
  respectsGlobalPause: boolean;
  source: ScheduledTask["source"];
  createdBy: string;
  ownerVisible: boolean;
  metadata?: Record<string, unknown>;
}

type CompletionCheck<K extends string> = {
  kind: K;
  params?: ScheduledTaskSeed["completionCheck"] extends infer Check
    ? Check extends { params?: infer Params }
      ? Params
      : never
    : never;
  followupAfterMinutes?: number;
};

type OutputDefinition = NonNullable<ScheduledTaskSeed["output"]> & {
  target: string;
};

export interface ReminderTaskDefinition extends TaskDefinitionBase {
  definitionKind: "reminder";
  completionCheck?: CompletionCheck<
    "user_acknowledged" | "user_replied_within"
  >;
  output?: ScheduledTaskSeedBase["output"];
}

export interface CheckInTaskDefinition extends TaskDefinitionBase {
  definitionKind: "checkin";
  completionCheck: CompletionCheck<"user_replied_within" | "user_acknowledged">;
  output?: ScheduledTaskSeedBase["output"];
}

export interface FollowUpTaskDefinition extends TaskDefinitionBase {
  definitionKind: "followup";
  completionCheck?: CompletionCheck<
    "subject_updated" | "user_replied_within" | "user_acknowledged"
  >;
  subject?: {
    kind: Extract<
      ScheduledTaskSubjectKind,
      "entity" | "relationship" | "thread"
    >;
    id: string;
  };
  output?: ScheduledTaskSeedBase["output"];
}

export interface WatcherTaskDefinition extends TaskDefinitionBase {
  definitionKind: "watcher";
  shouldFire?: NonNullable<ScheduledTaskSeedBase["shouldFire"]>;
  output?: ScheduledTaskSeedBase["output"];
}

export interface RecapTaskDefinition extends TaskDefinitionBase {
  definitionKind: "recap";
  completionCheck?: CompletionCheck<
    "user_acknowledged" | "user_replied_within"
  >;
  output?: ScheduledTaskSeedBase["output"];
}

export interface ApprovalTaskDefinition extends TaskDefinitionBase {
  definitionKind: "approval";
  completionCheck: CompletionCheck<"approval_resolved" | "user_replied_within">;
  subject: {
    kind: Extract<
      ScheduledTaskSubjectKind,
      "entity" | "relationship" | "thread" | "document" | "calendar_event"
    >;
    id: string;
  };
  output: OutputDefinition;
}

export interface OutputTaskDefinition extends TaskDefinitionBase {
  definitionKind: "output";
  output: OutputDefinition;
  completionCheck?: CompletionCheck<"delivered" | "user_acknowledged">;
}

export type TaskDefinition =
  | ReminderTaskDefinition
  | CheckInTaskDefinition
  | FollowUpTaskDefinition
  | WatcherTaskDefinition
  | RecapTaskDefinition
  | ApprovalTaskDefinition
  | OutputTaskDefinition;

export interface TaskCompiler<T extends TaskDefinition> {
  validate(definition: T): ValidationResult;
  compile(definition: T): ScheduledTaskSeed;
}

const allowedCompletionChecks: Record<
  TaskDefinition["definitionKind"],
  Set<string>
> = {
  reminder: new Set(["user_acknowledged", "user_replied_within"]),
  checkin: new Set(["user_replied_within", "user_acknowledged"]),
  followup: new Set([
    "subject_updated",
    "user_replied_within",
    "user_acknowledged",
  ]),
  watcher: new Set([]),
  recap: new Set(["user_acknowledged", "user_replied_within"]),
  approval: new Set(["approval_resolved", "user_replied_within"]),
  output: new Set(["delivered", "user_acknowledged"]),
};

export const defaultTaskCompiler: TaskCompiler<TaskDefinition> = {
  validate: validateTaskDefinition,
  compile: compileTaskDefinition,
};

export function validateTaskDefinition(
  definition: TaskDefinition,
): ValidationResult {
  const errors: string[] = [];

  if (!definition.trigger) {
    errors.push(`${definition.definitionKind} task is missing trigger.`);
  }

  const triggerNeedsGate =
    definition.trigger.kind === "event" ||
    definition.trigger.kind === "interval";
  if (triggerNeedsGate && !definition.shouldFire) {
    errors.push(
      `${definition.definitionKind} task with ${definition.trigger.kind} trigger must declare shouldFire gates.`,
    );
  }

  if (definition.definitionKind === "watcher" && definition.ownerVisible) {
    errors.push("watcher task definitions must not be owner-visible.");
  }

  if (
    (definition.definitionKind === "approval" ||
      definition.definitionKind === "output") &&
    !definition.output
  ) {
    errors.push(
      `${definition.definitionKind} task definitions require output.`,
    );
  }

  if (
    definition.output?.destination === "channel" &&
    !definition.output.target
  ) {
    errors.push(
      "channel output requires output.target connector/channel metadata.",
    );
  }

  if (
    definition.definitionKind === "approval" &&
    (!definition.subject?.kind || !definition.subject.id)
  ) {
    errors.push("approval task definitions require a typed subject.");
  }

  const completionKind =
    "completionCheck" in definition
      ? definition.completionCheck?.kind
      : undefined;
  if (completionKind) {
    const allowed = allowedCompletionChecks[definition.definitionKind];
    if (!allowed.has(completionKind)) {
      errors.push(
        `${definition.definitionKind} task cannot use completionCheck.kind="${completionKind}".`,
      );
    }
  } else if (
    definition.definitionKind === "checkin" ||
    definition.definitionKind === "approval"
  ) {
    errors.push(
      `${definition.definitionKind} task definitions require completionCheck.`,
    );
  }

  if (
    definition.definitionKind === "followup" &&
    definition.completionCheck?.kind === "subject_updated" &&
    !definition.subject
  ) {
    errors.push(
      "followup task definitions using subject_updated require subject.",
    );
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function compileTaskDefinition(
  definition: TaskDefinition,
): ScheduledTaskSeed {
  const validation = validateTaskDefinition(definition);
  if (!validation.ok) {
    throw new Error(
      `Invalid ${definition.definitionKind} task definition: ${validation.errors.join(" ")}`,
    );
  }

  const { definitionKind, ...seed } = definition;
  return {
    ...seed,
    kind: definitionKind,
  };
}

export function compileTaskDefinitions(
  definitions: ReadonlyArray<TaskDefinition>,
): ScheduledTaskSeed[] {
  return definitions.map((definition) => compileTaskDefinition(definition));
}
