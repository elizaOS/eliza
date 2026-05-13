/**
 * Default escalation ladders.
 *
 * Frozen shapes per `docs/audit/wave1-interfaces.md` §3.4.
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
