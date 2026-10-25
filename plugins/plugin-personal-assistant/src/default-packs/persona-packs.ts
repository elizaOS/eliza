/**
 * Persona default packs (issue #12186, plan D.1.2 / D.1.3 / D.5.1 / D.5.2).
 *
 * Three packs that serve the ADHD and overwhelmed/depressed personas through
 * the ONE-scheduler contract — no new mechanism, only trigger / gate /
 * completionCheck / escalation fields on `ScheduledTask` records. Routing stays
 * structural (the runner never inspects `promptInstructions`). The
 * `promptInstructions` here are a model *prompt* payload — self-compassionate
 * tone the planner reads when composing the check-in — not a behavior claim; the
 * behavioral-activation "shrink to one small step" transform itself lives in the
 * typed `laddered` progression rule, materialized by the occurrence engine.
 *
 *   - `low-energy-support` (D.5.1/D.5.2): a soft-only, low-priority morning
 *     check-in. Inline escalation steps are soft intensity with longer delays
 *     and no urgent step, so an unanswered nudge never becomes a demand.
 *
 *   - `adhd-body-double` (D.1.2): a "start now" body-double check-in fired in
 *     the morning window. Passive presence, not a demand — the completion check
 *     is a light reply gate, and the escalation is the same soft ladder.
 *
 *   - `object-permanence-watcher` (D.1.3): a daily watcher that re-surfaces
 *     overdue owner todos into the morning brief so out-of-sight items don't
 *     drop out of awareness. Mirrors `quiet-user-watcher` (no own notification).
 *
 * All three are **offered** at first-run customize (`defaultEnabled: false`);
 * the user opts in for their persona rather than everyone getting them.
 */

import type { EscalationStep } from "./contract-types.js";
import type { DefaultPack } from "./registry-types.js";
import {
  type CheckInTaskDefinition,
  compileTaskDefinition,
  type WatcherTaskDefinition,
} from "./task-definitions.js";

/**
 * Soft-only escalation ladder for low-energy / overwhelmed users (plan D.5.1).
 * Two gentle in-app nudges spaced far apart, both `soft` intensity, and no
 * `urgent` step — an unanswered check-in never escalates into a demand. This is
 * the structural anti-shame primitive: a missed reply is a longer, softer wait,
 * never a louder, cross-channel push.
 */
export const SOFT_LOW_ENERGY_ESCALATION_STEPS: ReadonlyArray<EscalationStep> = [
  { delayMinutes: 90, channelKey: "in_app", intensity: "soft" },
  { delayMinutes: 240, channelKey: "in_app", intensity: "soft" },
] as const;

// -- low-energy-support -----------------------------------------------------

export const LOW_ENERGY_SUPPORT_PACK_KEY = "low-energy-support";

export const LOW_ENERGY_SUPPORT_RECORD_IDS = {
  checkin: "default-pack:low-energy-support:morning-checkin",
} as const;

const lowEnergyCheckinDefinition: CheckInTaskDefinition = {
  definitionKind: "checkin",
  promptInstructions:
    "Offer the owner one small, concrete, valued next action for the day — the kind of thing that lowers the activation energy to get started. Keep the tone self-compassionate and non-judgemental: no streaks, no pressure, no guilt about anything left undone. Make it easy to say no. End with a gentle open question so they can reply if they want to.",
  contextRequest: {
    includeOwnerFacts: ["preferredName", "morningWindow", "timezone"],
    includeRecentTaskStates: { kind: "checkin", lookbackHours: 48 },
  },
  // Flexible: fire somewhere inside the owner's morning window rather than at a
  // fixed clock time. The window bounds resolve from ownerFacts.morningWindow.
  trigger: { kind: "during_window", windowKey: "morning" },
  priority: "low",
  completionCheck: {
    kind: "user_replied_within",
    params: { lookbackMinutes: 240 },
  },
  // Soft-only ladder: two gentle in-app nudges, no urgent cross-channel step.
  // INLINE steps only — no `ladderKey`, because a `ladderKey` must reference a
  // ladder registered in the runner's EscalationLadderRegistry (the runner
  // rejects an unregistered key at schedule time) and inline `steps` already
  // win over any named ladder in `resolveEffectiveLadder`.
  escalation: {
    steps: [...SOFT_LOW_ENERGY_ESCALATION_STEPS],
  },
  respectsGlobalPause: true,
  source: "default_pack",
  createdBy: LOW_ENERGY_SUPPORT_PACK_KEY,
  ownerVisible: true,
  idempotencyKey: LOW_ENERGY_SUPPORT_RECORD_IDS.checkin,
  metadata: {
    packKey: LOW_ENERGY_SUPPORT_PACK_KEY,
    recordKey: "morning-checkin",
    personaAxis: "overwhelmed_depressed",
  },
};

export const lowEnergySupportPack: DefaultPack = {
  key: LOW_ENERGY_SUPPORT_PACK_KEY,
  label: "Gentle daily support",
  description:
    "One soft, self-compassionate morning nudge toward a small valued action. No streaks, no guilt; unanswered nudges wait longer and softer rather than escalating.",
  defaultEnabled: false,
  requiredCapabilities: [],
  records: [compileTaskDefinition(lowEnergyCheckinDefinition)],
  uiHints: {
    summaryOnDayOne:
      "A single gentle morning check-in; if you don't reply it waits quietly, it never nags.",
    expectedFireCountPerDay: 1,
  },
};

// -- adhd-body-double -------------------------------------------------------

export const ADHD_BODY_DOUBLE_PACK_KEY = "adhd-body-double";

export const ADHD_BODY_DOUBLE_RECORD_IDS = {
  checkin: "default-pack:adhd-body-double:start-now",
} as const;

const adhdBodyDoubleDefinition: CheckInTaskDefinition = {
  definitionKind: "checkin",
  promptInstructions:
    "Act as a body double: offer quiet, non-judgemental presence while the owner starts one task now. Name a single small first step they can take in the next few minutes, then stay alongside — no checklist, no agenda, no pressure to finish. Separate the behaviour from their worth; there is no failure here, only starting.",
  contextRequest: {
    includeOwnerFacts: ["preferredName", "morningWindow", "timezone"],
    includeRecentTaskStates: { kind: "checkin", lookbackHours: 24 },
  },
  // Flexible morning-window fire — a body double shows up during the owner's
  // real start-of-day band, not at a rigid clock time.
  trigger: { kind: "during_window", windowKey: "morning" },
  priority: "low",
  // Light reply gate: presence, not verification. The owner acknowledging they
  // started is enough; no re-nag if they engaged.
  completionCheck: {
    kind: "user_replied_within",
    params: { lookbackMinutes: 120 },
  },
  // Inline soft-only steps (no `ladderKey`; see low-energy-support above).
  escalation: {
    steps: [...SOFT_LOW_ENERGY_ESCALATION_STEPS],
  },
  respectsGlobalPause: true,
  source: "default_pack",
  createdBy: ADHD_BODY_DOUBLE_PACK_KEY,
  ownerVisible: true,
  idempotencyKey: ADHD_BODY_DOUBLE_RECORD_IDS.checkin,
  metadata: {
    packKey: ADHD_BODY_DOUBLE_PACK_KEY,
    recordKey: "start-now",
    personaAxis: "adhd_executive_dysfunction",
  },
};

export const adhdBodyDoublePack: DefaultPack = {
  key: ADHD_BODY_DOUBLE_PACK_KEY,
  label: "Body-double start-now",
  description:
    "A quiet body-double presence in your morning window that helps you START one task now — passive company, not a nag. Soft-only escalation.",
  defaultEnabled: false,
  requiredCapabilities: [],
  records: [compileTaskDefinition(adhdBodyDoubleDefinition)],
  uiHints: {
    summaryOnDayOne:
      "A gentle body-double check-in in your morning window to help you start one thing.",
    expectedFireCountPerDay: 1,
  },
};

// -- object-permanence-watcher ----------------------------------------------

export const OBJECT_PERMANENCE_WATCHER_PACK_KEY = "object-permanence-watcher";

export const OBJECT_PERMANENCE_WATCHER_RECORD_IDS = {
  watcher: "default-pack:object-permanence-watcher:daily",
} as const;

const objectPermanenceWatcherDefinition: WatcherTaskDefinition = {
  definitionKind: "watcher",
  promptInstructions:
    "Consult RecentTaskStatesProvider and the owner's reminders/todos for items that are overdue or have quietly slipped out of view. Surface those overdue items as an observation for the morning-brief consolidation so they come back into awareness. Do not send a separate notification; do not shame the owner for anything overdue.",
  contextRequest: {
    includeOwnerFacts: ["preferredName", "timezone"],
    includeRecentTaskStates: { lookbackHours: 24 * 7 },
  },
  // Fire on the morning anchor so the morning-brief consolidation folds the
  // re-surfaced items into the same wake.confirmed batch.
  trigger: {
    kind: "relative_to_anchor",
    anchorKey: "wake.confirmed",
    offsetMinutes: 0,
  },
  priority: "low",
  respectsGlobalPause: true,
  source: "default_pack",
  createdBy: OBJECT_PERMANENCE_WATCHER_PACK_KEY,
  // Watcher tasks emit observations for the morning brief; not owner-visible.
  ownerVisible: false,
  idempotencyKey: OBJECT_PERMANENCE_WATCHER_RECORD_IDS.watcher,
  metadata: {
    packKey: OBJECT_PERMANENCE_WATCHER_PACK_KEY,
    recordKey: "object-permanence-watcher",
    personaAxis: "adhd_object_permanence",
  },
};

export const objectPermanenceWatcherPack: DefaultPack = {
  key: OBJECT_PERMANENCE_WATCHER_PACK_KEY,
  label: "Object-permanence watcher",
  description:
    "Daily silent watcher that re-surfaces overdue todos that have slipped out of view into your morning brief, so out-of-sight items don't stay out of mind. No separate notification.",
  defaultEnabled: false,
  requiredCapabilities: [],
  records: [compileTaskDefinition(objectPermanenceWatcherDefinition)],
  uiHints: {
    summaryOnDayOne:
      "A silent watcher that folds slipped/overdue items back into your morning brief.",
    expectedFireCountPerDay: 0,
  },
};

/** All persona packs, in offer order. */
export const PERSONA_PACKS: ReadonlyArray<DefaultPack> = [
  lowEnergySupportPack,
  adhdBodyDoublePack,
  objectPermanenceWatcherPack,
];
