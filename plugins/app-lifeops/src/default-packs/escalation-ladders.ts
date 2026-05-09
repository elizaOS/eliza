/**
 * Default escalation ladders registered by W1-D.
 *
 * Frozen by wave1-interfaces.md §3.4. Wave-1 ships the ladder data here;
 * once W1-F's `src/lifeops/escalation-ladders.ts` lands, this module flips
 * to a re-export per the integration gate (`IMPLEMENTATION_PLAN.md` §4).
 *
 * Ladders shipped:
 *
 * ```
 * priority_low_default:    { steps: [] }
 * priority_medium_default: { steps: [{ delayMinutes: 30, channelKey: "in_app", intensity: "normal" }] }
 * priority_high_default:   { steps: [
 *   { delayMinutes: 0,  channelKey: "in_app",   intensity: "soft" },
 *   { delayMinutes: 15, channelKey: "push",     intensity: "normal" },
 *   { delayMinutes: 45, channelKey: "imessage", intensity: "urgent" },
 * ]}
 * ```
 *
 * Stub status: see `contract-stubs.ts` — `EscalationStep` /
 * `EscalationLadder` types are local until W1-A's `escalation.ts` lands.
 */

import type {
  DefaultEscalationLadderKey,
  EscalationLadder,
} from "./contract-stubs.js";

export const DEFAULT_ESCALATION_LADDERS: Readonly<
  Record<DefaultEscalationLadderKey, EscalationLadder>
> = {
  priority_low_default: { steps: [] },
  priority_medium_default: {
    steps: [{ delayMinutes: 30, channelKey: "in_app", intensity: "normal" }],
  },
  priority_high_default: {
    steps: [
      { delayMinutes: 0, channelKey: "in_app", intensity: "soft" },
      { delayMinutes: 15, channelKey: "push", intensity: "normal" },
      { delayMinutes: 45, channelKey: "imessage", intensity: "urgent" },
    ],
  },
};
