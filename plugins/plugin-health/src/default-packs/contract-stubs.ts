/**
 * Wave-1 contract stubs for the W1-A `ScheduledTask` schema and the W1-D
 * `DefaultPack` envelope. Mirrors `wave1-interfaces.md` §1.1 / §6 byte-
 * identically. Once W1-A / W1-D land, every `import` from this file should
 * be replaced with the real path; nothing else needs to change because the
 * shapes here are the frozen contract.
 *
 * Cross-references:
 *  - `eliza/plugins/app-lifeops/src/lifeops/wave1-types.ts` — W1-A's stub
 *    of the same `ScheduledTask` shape, kept in sync with this one.
 *  - `eliza/plugins/app-lifeops/src/default-packs/contract-stubs.ts` —
 *    W1-D's stub of the same shape, kept in sync with this one.
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

export interface EscalationStep {
  delayMinutes: number;
  channelKey: string;
  intensity?: "soft" | "normal" | "urgent";
}

export interface ScheduledTask {
  taskId: string;
  kind: ScheduledTaskKind;
  promptInstructions: string;
  contextRequest?: {
    includeOwnerFacts?: ReadonlyArray<
      "preferredName" | "timezone" | "morningWindow" | "eveningWindow" | "locale"
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
  escalation?: { ladderKey?: string; steps?: EscalationStep[] };
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

/** Default-pack records are `ScheduledTask`s without runner-managed fields. */
export type ScheduledTaskSeed = Omit<ScheduledTask, "taskId" | "state">;

export interface AnchorConsolidationPolicy {
  anchorKey: string;
  mode: "merge" | "sequential" | "parallel";
  staggerMinutes?: number;
  maxBatchSize?: number;
  sortBy?: "priority_desc" | "fired_at_asc";
}

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
