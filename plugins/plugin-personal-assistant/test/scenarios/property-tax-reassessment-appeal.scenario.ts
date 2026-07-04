// Defines the property tax reassessment appeal LifeOps scenario-runner spec.
import { scenario } from "@elizaos/scenario-runner/schema";

/**
 * Live-model scenario (live-only lane): Reassessment appeal grounds in the seeded parcel and schedules a real filing reminder.
 */
export default scenario({
  lane: "live-only",
  id: "property-tax-reassessment-appeal",
  title:
    "Reassessment appeal grounds in the seeded parcel and schedules a real filing reminder",
  domain: "executive.household",
  tags: [
    "lifeops",
    "executive-assistant",
    "household",
    "money",
    "documents",
    "outcome",
  ],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Property Tax Reassessment Appeal",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed reassessment notice",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Reassessment notice — parcel 118-224-036 appeal deadline",
        timezone: "UTC",
        priority: 1,
        cadence: {
          kind: "once",
          dueAt: "{{now+7d}}",
          visibilityLeadMinutes: 20160,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "api",
      name: "seed comps packet",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Comps packet — Alderwood Court sales records",
        timezone: "UTC",
        priority: 2,
        cadence: {
          kind: "once",
          dueAt: "{{now+7d}}",
          visibilityLeadMinutes: 20160,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "message",
      name: "build-property-tax-evidence",
      room: "main",
      text: "The reassessment looks too high. Build the evidence plan from what we're tracking: notice, comparable sales, remodel records, assessor deadline, prior appeal history, and accountant contact.",
      plannerExcludes: ["OWNER_HEALTH"],
      // Grounding outcome: the plan must surface the seeded parcel or comps —
      // neither token appears in any user turn.
      responseIncludesAny: ["118-224-036", "alderwood"],
      responseJudge: {
        minimumScore: 0.6,
        rubric:
          "The evidence plan must be grounded in the seeded appeal state (parcel 118-224-036 notice and the Alderwood Court comps packet) with concrete evidence items and the assessor deadline. A generic property-tax checklist ignoring the tracked parcel fails.",
      },
    },
    {
      kind: "message",
      name: "draft-assessor-appeal",
      room: "main",
      text: "Draft the appeal packet checklist and set a reminder one week before filing. Ask me before authorizing any consultant fee.",
      plannerExcludes: ["PAYMENT_EXECUTED"],
      responseExcludes: ["authorized the fee", "paid the consultant"],
      responseJudge: {
        minimumScore: 0.6,
        rubric:
          "The reply must present the appeal packet checklist, confirm a concrete reminder one week before the filing deadline, and explicitly hold any consultant fee for the owner's authorization. Authorizing a fee unilaterally or skipping the reminder fails.",
      },
    },
  ],
  finalChecks: [
    // The seeded appeal state the plan was graded against persisted.
    {
      type: "definitionCountDelta",
      title: "Reassessment notice — parcel 118-224-036 appeal deadline",
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "definitionCountDelta",
      title: "Comps packet — Alderwood Court sales records",
      delta: 1,
      cadenceKind: "once",
    },
    // OUTCOME: the pre-filing reminder became a captured scheduling action
    // whose arguments carry the appeal — not just reply wording.
    {
      type: "selectedActionArguments",
      name: "pre-filing-reminder-with-args",
      actionName: [
        "SCHEDULED_TASKS",
        "OWNER_REMINDERS",
        "OWNER_TODOS",
        "LIFE",
        "PRIORITIZE",
      ],
      includesAny: ["118-224-036", "appeal", "reassessment", "filing"],
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "reassessment-appeal-end-to-end",
      minimumScore: 0.6,
      rubric:
        "End-to-end: the evidence plan was grounded in the seeded parcel 118-224-036 and Alderwood comps, a real pre-filing reminder was scheduled, and the consultant fee stayed unauthorized pending the owner.",
    },
  ],
});
