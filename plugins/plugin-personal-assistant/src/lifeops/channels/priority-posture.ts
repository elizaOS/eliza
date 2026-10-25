/**
 * Priority → notification posture map.
 *
 * The three priority levels are distinct user surfaces, not just sort order:
 * - `low`    — in_app card only; no banner, no sound; badge only.
 * - `medium` — in_app + push (if registered); banner; no sound; badge.
 * - `high`   — escalation ladder mandatory; falls through channels until ack.
 *              Banner, sound, badge all on.
 *
 * The runner reads `defaultChannelKeys` when a `ScheduledTask` lacks an
 * explicit `escalation` and injects the matching default ladder from
 * {@link import("../escalation-ladders.js").DEFAULT_ESCALATION_LADDERS}.
 */

export type ScheduledTaskPriority = "low" | "medium" | "high";

export interface PriorityPosture {
  /**
   * Channel keys (matching {@link import("./contract.js").ChannelContribution.kind})
   * that the runner targets when a task at this priority lacks an explicit
   * escalation ladder. Order is the default fallback order.
   */
  defaultChannelKeys: readonly string[];

  /** Show a banner / OS notification surface. */
  banner: boolean;

  /** Play a notification sound. */
  sound: boolean;

  /** Update the unread badge count. */
  badge: boolean;

  /**
   * When `true`, the runner injects a default escalation ladder if the task
   * has none. The user cannot opt out without a per-task override; this is
   * what makes `high` distinct from `medium`.
   */
  mandatoryEscalation: boolean;
}

export const PRIORITY_TO_POSTURE: Readonly<
  Record<ScheduledTaskPriority, PriorityPosture>
> = {
  low: {
    defaultChannelKeys: ["in_app"],
    banner: false,
    sound: false,
    badge: true,
    mandatoryEscalation: false,
  },
  medium: {
    defaultChannelKeys: ["in_app", "push"],
    banner: true,
    sound: false,
    badge: true,
    mandatoryEscalation: false,
  },
  high: {
    defaultChannelKeys: ["in_app", "push"],
    banner: true,
    sound: true,
    badge: true,
    mandatoryEscalation: true,
  },
} as const;
