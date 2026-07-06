/**
 * Default escalation ladders.
 *
 * Frozen shapes per `docs/audit/wave1-interfaces.md` §3.4.
 *
 * ```
 * priority_low_default:    { steps: [] }
 * priority_medium_default: { steps: [{ delayMinutes: 30, channelKey: "in_app", intensity: "normal" }] }
 * priority_high_default: connected-channel candidates in urgency-fit order;
 *   the runner skips disconnected connector-backed channels at fire time and
 *   keeps `in_app` as the guaranteed final rung.
 * ```
 */

import type {
  DefaultEscalationLadderKey,
  EscalationLadder,
} from "./contract-types.js";

export const DEFAULT_ESCALATION_LADDERS: Readonly<
  Record<DefaultEscalationLadderKey, EscalationLadder>
> = {
  priority_low_default: { steps: [] },
  priority_medium_default: {
    steps: [{ delayMinutes: 30, channelKey: "in_app", intensity: "normal" }],
  },
  priority_high_default: {
    steps: [
      { delayMinutes: 15, channelKey: "push", intensity: "normal" },
      { delayMinutes: 45, channelKey: "telegram", intensity: "urgent" },
      { delayMinutes: 45, channelKey: "signal", intensity: "urgent" },
      { delayMinutes: 45, channelKey: "whatsapp", intensity: "urgent" },
      { delayMinutes: 45, channelKey: "discord", intensity: "urgent" },
      { delayMinutes: 45, channelKey: "sms", intensity: "urgent" },
      { delayMinutes: 45, channelKey: "voice", intensity: "urgent" },
      { delayMinutes: 45, channelKey: "imessage", intensity: "urgent" },
      { delayMinutes: 45, channelKey: "in_app", intensity: "urgent" },
    ],
  },
};
