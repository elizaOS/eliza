/**
 * W1-F — Default escalation ladders.
 *
 * Frozen per `wave1-interfaces.md` §3.4 and `GAP_ASSESSMENT.md` §8.7 (priority
 * → notification posture).
 *
 * The runner injects one of these ladders when a `ScheduledTask` lacks an
 * explicit `escalation` block, keyed off the task's `priority`:
 * - `priority_low_default`    — single attempt, no ladder.
 * - `priority_medium_default` — 1 retry after 30 min.
 * - `priority_high_default`   — 3 steps across channels (in_app → push → imessage).
 *
 * Channel keys (`in_app`, `push`, `imessage`) reference
 * {@link import("./channels/contract.js").ChannelContribution.kind}; the
 * channel registry is responsible for resolving them at dispatch time.
 *
 * The {@link EscalationStep} shape mirrors W1-A's ScheduledTask schema (see
 * `wave1-interfaces.md` §1.1). It is duplicated here intentionally so W1-F
 * does not import from W1-A's worktree before W1-A lands; the byte-for-byte
 * shape is enforced at the integration gate.
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
      { delayMinutes: 0, channelKey: "in_app", intensity: "soft" },
      { delayMinutes: 15, channelKey: "push", intensity: "normal" },
      { delayMinutes: 45, channelKey: "imessage", intensity: "urgent" },
    ],
  },
} as const;

export type DefaultEscalationLadderKey = keyof typeof DEFAULT_ESCALATION_LADDERS;
