/**
 * Wave-1 type stubs reproduced from `docs/audit/wave1-interfaces.md` §1.
 *
 * These mirror the canonical W1-A `ScheduledTask` / `TerminalState` /
 * `ScheduledTaskRunner` types. W1-A will land the production source-of-truth
 * under `src/lifeops/scheduled-task/`. When that happens, every `import` from
 * this file should be replaced with the real path; nothing else needs to
 * change because the shapes here are byte-identical to the frozen contract.
 *
 * No runtime behaviour lives here — types only.
 */

export type TerminalState =
  | "completed"
  | "skipped"
  | "expired"
  | "failed"
  | "dismissed";

export type ScheduledTaskStatus =
  | TerminalState
  | "scheduled"
  | "fired"
  | "acknowledged";

export type ScheduledTaskKind =
  | "reminder"
  | "checkin"
  | "followup"
  | "approval"
  | "recap"
  | "watcher"
  | "output"
  | "custom";

export type ScheduledTaskPriority = "low" | "medium" | "high";

export type ScheduledTaskSource =
  | "default_pack"
  | "user_chat"
  | "first_run"
  | "plugin";

export interface ScheduledTaskState {
  status: ScheduledTaskStatus;
  firedAt?: string;
  acknowledgedAt?: string;
  completedAt?: string;
  followupCount: number;
  lastFollowupAt?: string;
  pipelineParentId?: string;
  lastDecisionLog?: string;
}

export type ScheduledTaskTrigger =
  | { kind: "once"; atIso: string }
  | { kind: "cron"; expression: string; tz: string }
  | { kind: "interval"; everyMinutes: number; from?: string; until?: string }
  | { kind: "relative_to_anchor"; anchorKey: string; offsetMinutes: number }
  | { kind: "during_window"; windowKey: string }
  | { kind: "event"; eventKind: string; filter?: unknown }
  | { kind: "manual" }
  | { kind: "after_task"; taskId: string; outcome: TerminalState };

export interface ScheduledTaskCompletionCheck {
  kind: string;
  params?: unknown;
  followupAfterMinutes?: number;
}

export interface ScheduledTaskSubject {
  kind:
    | "entity"
    | "relationship"
    | "thread"
    | "document"
    | "calendar_event"
    | "self";
  id: string;
}

export interface ScheduledTask {
  taskId: string;
  kind: ScheduledTaskKind;
  promptInstructions: string;
  contextRequest?: {
    includeOwnerFacts?: ReadonlyArray<
      | "preferredName"
      | "timezone"
      | "morningWindow"
      | "eveningWindow"
      | "locale"
    >;
    includeEntities?: {
      entityIds: string[];
      fields?: ReadonlyArray<
        | "preferredName"
        | "type"
        | "identities"
        | "state.lastInteractionPlatform"
      >;
    };
    includeRelationships?: {
      relationshipIds?: string[];
      forEntityIds?: string[];
      types?: string[];
    };
    includeRecentTaskStates?: {
      kind?: ScheduledTaskKind;
      lookbackHours?: number;
    };
    includeEventPayload?: boolean;
  };
  trigger: ScheduledTaskTrigger;
  priority: ScheduledTaskPriority;
  shouldFire?: {
    compose?: "all" | "any" | "first_deny";
    gates: Array<{ kind: string; params?: unknown }>;
  };
  completionCheck?: ScheduledTaskCompletionCheck;
  escalation?: {
    ladderKey?: string;
    steps?: Array<{
      delayMinutes: number;
      channelKey: string;
      intensity?: "soft" | "normal" | "urgent";
    }>;
  };
  output?: {
    destination:
      | "in_app_card"
      | "channel"
      | "apple_notes"
      | "gmail_draft"
      | "memory";
    target?: string;
    persistAs?: "task_metadata" | "external_only";
  };
  pipeline?: {
    onComplete?: Array<string | ScheduledTask>;
    onSkip?: Array<string | ScheduledTask>;
    onFail?: Array<string | ScheduledTask>;
  };
  subject?: ScheduledTaskSubject;
  idempotencyKey?: string;
  respectsGlobalPause: boolean;
  state: ScheduledTaskState;
  source: ScheduledTaskSource;
  createdBy: string;
  ownerVisible: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Schedule input — `ScheduledTask` minus runner-managed fields. Mirrors the
 * runner signature `schedule(task: Omit<ScheduledTask, "taskId" | "state">)`.
 */
export type ScheduledTaskInput = Omit<ScheduledTask, "taskId" | "state">;
