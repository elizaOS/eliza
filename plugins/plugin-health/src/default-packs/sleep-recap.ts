/**
 * `sleep-recap` default pack — fires a one-shot summary of last night's
 * sleep about 240 minutes (4 hours) after wake.confirmed, when the
 * personal baseline has enough samples to produce a meaningful recap.
 *
 * Trigger: `relative_to_anchor("wake.confirmed", 240)`. The 4-hour offset
 * gives the morning brief time to land first and avoids interrupting the
 * user's first wake hour.
 *
 * Per `wave1-interfaces.md` §5.4 / `GAP_ASSESSMENT.md` §4.4.
 */

import type { DefaultPack } from "./contract-stubs.js";

export const sleepRecapDefaultPack: DefaultPack = {
  key: "sleep-recap",
  label: "Last-night sleep recap",
  description:
    "Surfaces a one-line recap of last night's sleep duration, regularity, and any anomalies. Quiet on days where the personal baseline has fewer than 5 sealed episodes (insufficient_data).",
  defaultEnabled: false,
  records: [
    {
      kind: "recap",
      promptInstructions:
        "Summarize last night's sleep in one sentence. Mention duration vs the user's median, and any regularity-class change. Do not surface raw biometric numbers; speak in normal-language terms.",
      contextRequest: {
        includeOwnerFacts: ["preferredName", "timezone"],
      },
      trigger: {
        kind: "relative_to_anchor",
        anchorKey: "wake.confirmed",
        offsetMinutes: 240,
      },
      priority: "low",
      shouldFire: {
        compose: "all",
        gates: [
          { kind: "personal_baseline_sufficient", params: { minSamples: 5 } },
          { kind: "circadian_state_in", params: { states: ["awake"] } },
        ],
      },
      completionCheck: {
        kind: "user_acknowledged",
        followupAfterMinutes: 240,
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
        defaultPackKey: "sleep-recap",
      },
    },
  ],
  uiHints: {
    summaryOnDayOne:
      "After 5 nights of sleep data, you'll get a one-line recap each morning.",
    expectedFireCountPerDay: 1,
  },
};
