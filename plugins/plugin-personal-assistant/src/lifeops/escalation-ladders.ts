/**
 * Default escalation ladders. The runner injects one of these ladders when a
 * `ScheduledTask` lacks an explicit `escalation` block, keyed off the task's
 * `priority`:
 * - `priority_low_default`    — single attempt, no ladder.
 * - `priority_medium_default` — 1 retry after 30 min.
 * - `priority_high_default`   — connected-channel candidates, ending with in_app.
 *
 * Channel keys (`in_app`, `push`, `imessage`) reference
 * {@link import("./channels/contract.js").ChannelContribution.kind}; the
 * runner skips disconnected connector-backed channels before dispatch.
 */

export type EscalationIntensity = "soft" | "normal" | "urgent";

export interface EscalationStep {
  delayMinutes: number;
  channelKey: string;
  intensity?: EscalationIntensity;
}

export interface EscalationLadder {
  steps: EscalationStep[];
}

export const DEFAULT_ESCALATION_LADDERS: Readonly<{
  priority_low_default: EscalationLadder;
  priority_medium_default: EscalationLadder;
  priority_high_default: EscalationLadder;
}> = {
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
} as const;

export type DefaultEscalationLadderKey =
  keyof typeof DEFAULT_ESCALATION_LADDERS;
