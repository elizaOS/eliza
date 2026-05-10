/**
 * `CircadianInsightContract` — runtime-registered seam between
 * `app-lifeops` (and other consumers) and the plugin-health circadian +
 * sleep-inference internals.
 *
 * W3-C drift D-4: prior to this contract, `app-lifeops/src/lifeops/
 * schedule-insight.ts` and downstream actions reached directly into
 * `@elizaos/plugin-health/src/sleep/*` for circadian scoring, awake
 * probability, sleep-cycle resolution, regularity scoring, and historical
 * episode reads. Per `post-cleanup-architecture.md` the sleep / circadian
 * / screen-time domain is owned by `plugin-health`. Consumers now read
 * through the contract registered on the runtime; the concrete
 * implementation continues to live inside `plugin-health` (where the
 * domain helpers live), so deep imports stay private to the plugin.
 *
 * The contract is read-only — the only writer of fresh inference is the
 * scheduler tick wired through `LifeOpsService.inspectSchedule`. Consumers
 * that just want "what does the scheduler currently believe" should call
 * `getCurrentSleepWindow` / `inferOptimalSchedulingWindow` instead of
 * driving fresh inspection themselves.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type {
  LifeOpsCircadianState,
  LifeOpsScheduleInsight,
  LifeOpsScheduleMealLabel,
} from "@elizaos/shared";

/**
 * The contract's view of "the current sleep window". `state` is null when
 * inference has not produced a high-confidence answer yet.
 */
export interface SleepWindow {
  /** Current circadian phase, or null when inference is still calibrating. */
  state: LifeOpsCircadianState | null;
  /** Confidence in `state` on [0, 1]. */
  confidence: number;
  /** ISO-8601 timestamp of the last inferred wake event, when known. */
  lastWakeAtIso: string | null;
  /** ISO-8601 timestamp of the current sleep onset, when the user is asleep. */
  currentSleepStartedAtIso: string | null;
  /** ISO-8601 next bedtime target, when the model has one. */
  bedtimeTargetAtIso: string | null;
}

/**
 * "When should I schedule something so it lands in the user's optimal
 * window?" The contract exposes the inference output without committing
 * callers to a particular meal/sleep cycle representation.
 */
export interface SchedulingWindow {
  /** Most appropriate ISO-8601 fire time for the next scheduled task. */
  recommendedAtIso: string | null;
  /** Optional meal label when the scheduler is targeting a meal-window. */
  nextMealLabel: LifeOpsScheduleMealLabel | null;
  /** ISO-8601 lower bound of the window. */
  windowStartIso: string | null;
  /** ISO-8601 upper bound of the window. */
  windowEndIso: string | null;
  /** Confidence in the recommendation on [0, 1]. */
  confidence: number;
  /**
   * Free-form reason for the recommendation, e.g. "next meal window
   * (lunch) starts in 12 minutes" or "still calibrating, defer to manual".
   * The string is stable and intended for surfacing to the user.
   */
  reason: string;
}

export interface SleepWindowOptions {
  /** Optional IANA timezone override (defaults to the owner's resolved tz). */
  timezone?: string;
}

export interface SchedulingWindowOptions {
  timezone?: string;
}

/**
 * Public contract every consumer reads. The implementation lives in
 * `plugin-health`; consumers resolve it via `getCircadianInsightContract`.
 */
export interface CircadianInsightContract {
  /** Snapshot of "are they awake / asleep / napping right now?". */
  getCurrentSleepWindow(opts?: SleepWindowOptions): Promise<SleepWindow>;

  /**
   * Snapshot of "when should the next scheduled task fire to land in the
   * owner's optimal window?". Returns recommendedAtIso=null when
   * inference is still calibrating.
   */
  inferOptimalSchedulingWindow(
    opts?: SchedulingWindowOptions,
  ): Promise<SchedulingWindow>;

  /**
   * Direct accessor for the underlying scheduler-tick insight record.
   * Returned for read-only consumption (UI, debug routes); writers must
   * go through the scheduler tick.
   */
  getLatestInsight(
    opts?: SchedulingWindowOptions,
  ): Promise<LifeOpsScheduleInsight | null>;
}

// --- Runtime registration ---------------------------------------------------

const CIRCADIAN_CONTRACT_KEY = Symbol.for(
  "@elizaos/plugin-health:circadian-insight-contract",
);

interface CircadianContractHostRuntime extends IAgentRuntime {
  [CIRCADIAN_CONTRACT_KEY]?: CircadianInsightContract;
}

export function registerCircadianInsightContract(
  runtime: IAgentRuntime,
  contract: CircadianInsightContract,
): void {
  (runtime as CircadianContractHostRuntime)[CIRCADIAN_CONTRACT_KEY] = contract;
}

export function getCircadianInsightContract(
  runtime: IAgentRuntime,
): CircadianInsightContract | null {
  return (
    (runtime as CircadianContractHostRuntime)[CIRCADIAN_CONTRACT_KEY] ?? null
  );
}
