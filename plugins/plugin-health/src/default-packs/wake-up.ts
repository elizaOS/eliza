/**
 * `wake-up` default pack — surfaces a one-line "good morning" check-in when
 * the wake state is confirmed (sustained signal).
 *
 * Trigger: `relative_to_anchor("wake.confirmed", 0)` — at the moment the
 * circadian-rules scorer confirms a sustained-awake transition. Uses the
 * `wake.confirmed` anchor (sustained signal) and not `wake.observed` (first
 * signal) to avoid double-firing on micro-wakes.
 *
 * Per `IMPLEMENTATION_PLAN.md` §3.2 and `wave1-interfaces.md` §5.4.
 */

import type { DefaultPack } from "./contract-stubs.js";

export const wakeUpDefaultPack: DefaultPack = {
  key: "wake-up",
  label: "Morning gm reminder",
  description:
    "Fires a single low-pressure 'good morning' check-in at the wake.confirmed anchor (sustained-awake transition). Skips when the user has already started a chat session this morning.",
  defaultEnabled: true,
  records: [
    {
      kind: "checkin",
      promptInstructions:
        "Greet the user briefly (one sentence). If you have a non-trivial morning brief queued, surface it; otherwise leave space for them to lead.",
      contextRequest: {
        includeOwnerFacts: ["preferredName", "timezone", "morningWindow"],
        includeRecentTaskStates: { kind: "checkin", lookbackHours: 18 },
      },
      trigger: {
        kind: "relative_to_anchor",
        anchorKey: "wake.confirmed",
        offsetMinutes: 0,
      },
      priority: "low",
      shouldFire: {
        compose: "all",
        gates: [
          { kind: "circadian_state_in", params: { states: ["awake"] } },
          { kind: "no_recent_user_message_in", params: { minutes: 30 } },
        ],
      },
      completionCheck: {
        kind: "user_replied_within",
        params: { minutes: 60 },
        followupAfterMinutes: 90,
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
        defaultPackKey: "wake-up",
      },
    },
  ],
  consolidationPolicies: [
    {
      anchorKey: "wake.confirmed",
      mode: "merge",
      sortBy: "priority_desc",
      maxBatchSize: 5,
    },
  ],
  uiHints: {
    summaryOnDayOne:
      "Your morning gm fires once when your wake-up is confirmed.",
    expectedFireCountPerDay: 1,
  },
};
