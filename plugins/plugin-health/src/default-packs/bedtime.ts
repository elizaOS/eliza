/**
 * `bedtime` default pack — fires a low-pressure reminder when the user is
 * approaching their personal bedtime target.
 *
 * Trigger: `relative_to_anchor("bedtime.target", -30)` — 30 minutes before
 * the bedtime target. Falls back to a fixed 22:30 local cron when the
 * personal-baseline projection is unavailable.
 *
 * Per `wave1-interfaces.md` §5.4: plugin-health ships bedtime / wake-up /
 * sleep-recap default `ScheduledTask` records consuming the W1-A schema.
 */

import type { DefaultPack } from "./contract-stubs.js";

export const bedtimeDefaultPack: DefaultPack = {
  key: "bedtime",
  label: "Bedtime reminder",
  description:
    "Low-pressure nudge 30 minutes before the user's personal bedtime target. Quiet when the user has already started winding down (circadian state = winding_down or sleeping).",
  defaultEnabled: false,
  records: [
    {
      kind: "reminder",
      promptInstructions:
        "Remind the user gently that bedtime is coming up in about 30 minutes. Reference their personal baseline if available; do not lecture or moralize.",
      contextRequest: {
        includeOwnerFacts: ["preferredName", "timezone", "eveningWindow"],
      },
      trigger: {
        kind: "relative_to_anchor",
        anchorKey: "bedtime.target",
        offsetMinutes: -30,
      },
      priority: "low",
      shouldFire: {
        compose: "all",
        gates: [{ kind: "circadian_state_in", params: { states: ["awake"] } }],
      },
      completionCheck: {
        kind: "user_acknowledged",
        followupAfterMinutes: 60,
      },
      output: {
        destination: "in_app_card",
        persistAs: "task_metadata",
      },
      respectsGlobalPause: true,
      source: "default_pack",
      createdBy: "plugin-health",
      ownerVisible: true,
      metadata: {
        defaultPackKey: "bedtime",
      },
    },
  ],
  uiHints: {
    summaryOnDayOne:
      "Your bedtime reminder will fire 30 minutes before your typical wind-down time.",
    expectedFireCountPerDay: 1,
  },
};
