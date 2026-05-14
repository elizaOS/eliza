/**
 * Default-pack registration shapes.
 *
 * `DefaultPack` is the envelope type for a curated set of `ScheduledTask`
 * records, consolidation policies, and escalation ladders shipped with the agent.
 * `DefaultPackRegistry` is the runtime registration surface.
 */

import type {
  AnchorConsolidationPolicy,
  DefaultEscalationLadderKey,
  EscalationLadder,
  ScheduledTaskSeed,
} from "./contract-stubs.js";

/**
 * A "default pack" is a curated set of `ScheduledTask` records — and any
 * registry contributions (consolidation policies, escalation ladders) — that
 * ships with the agent.
 *
 * `defaultEnabled = true` means the records auto-seed when first-run runs the
 * defaults path; `false` means the pack is **offered** at first-run customize
 * but not seeded automatically (this is how the 8 habit-starters ship).
 */
export interface DefaultPack {
  /** Stable namespaced key, e.g. `daily-rhythm`, `habit-starters`. */
  key: string;
  /** Short human label (used in first-run "pick a pack" UI). */
  label: string;
  /** One-paragraph rationale; surfaces in pack-detail UI and curation doc. */
  description: string;
  /**
   * If `true`, first-run defaults path seeds these records automatically.
   * If `false`, the pack is offered at customize time only.
   */
  defaultEnabled: boolean;
  /** Optional capability gate; pack is offered only if registry has all of these. */
  requiredCapabilities?: string[];
  /** ScheduledTask seeds (no `taskId`, no `state`). */
  records: ScheduledTaskSeed[];
  /** Anchor consolidation policies the pack contributes. */
  consolidationPolicies?: AnchorConsolidationPolicy[];
  /** Named escalation ladders the pack contributes. */
  escalationLadders?: Partial<
    Record<DefaultEscalationLadderKey, EscalationLadder>
  >;
  /** Optional metadata surface for first-run UI. */
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
