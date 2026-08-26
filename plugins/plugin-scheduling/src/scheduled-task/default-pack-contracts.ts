/**
 * Scheduling-owned contracts for authored default packs and their registries.
 * Authored seeds deliberately permit readonly context selections and inline
 * child seeds, while persisted tasks retain the narrower runner-owned shape.
 */

import type {
  AnchorConsolidationPolicy,
  EscalationStep,
  ScheduledTask,
  ScheduledTaskContextRequest,
  ScheduledTaskInput,
} from "./types.js";

export interface ScheduledTaskSeedContextRequest
  extends Omit<
    ScheduledTaskContextRequest,
    "includeOwnerFacts" | "includeEntities"
  > {
  includeOwnerFacts?: readonly NonNullable<
    ScheduledTaskContextRequest["includeOwnerFacts"]
  >[number][];
  includeEntities?: Omit<
    NonNullable<ScheduledTaskContextRequest["includeEntities"]>,
    "fields"
  > & {
    fields?: readonly NonNullable<
      NonNullable<ScheduledTaskContextRequest["includeEntities"]>["fields"]
    >[number][];
  };
}

/** A child reference accepted while authoring a pack. */
export type ScheduledTaskSeedRef = string | ScheduledTask | ScheduledTaskSeed;

export interface ScheduledTaskSeedPipeline {
  onComplete?: ScheduledTaskSeedRef[];
  onSkip?: ScheduledTaskSeedRef[];
  onFail?: ScheduledTaskSeedRef[];
}

/**
 * Default-pack input before the runner assigns identity and lifecycle state.
 * Inline child seeds are an authoring form and must be compiled or rejected at
 * the persistence boundary rather than masquerading as persisted task refs.
 */
export type ScheduledTaskSeed = Omit<
  ScheduledTaskInput,
  "contextRequest" | "pipeline"
> & {
  contextRequest?: ScheduledTaskSeedContextRequest;
  pipeline?: ScheduledTaskSeedPipeline;
};

export type DefaultEscalationLadderKey =
  | "priority_low_default"
  | "priority_medium_default"
  | "priority_high_default";

/** Authoring contribution keyed by the containing pack registry entry. */
export interface DefaultPackEscalationLadder {
  steps: EscalationStep[];
}

/** Curated set of scheduled-task seeds and its registry contributions. */
export interface DefaultPack {
  key: string;
  label: string;
  description: string;
  defaultEnabled: boolean;
  requiredCapabilities: string[];
  records: ScheduledTaskSeed[];
  consolidationPolicies?: AnchorConsolidationPolicy[];
  escalationLadders?: Partial<
    Record<DefaultEscalationLadderKey, DefaultPackEscalationLadder>
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
