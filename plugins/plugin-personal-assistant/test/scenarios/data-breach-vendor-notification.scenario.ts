// Defines the data breach vendor notification LifeOps scenario-runner spec.
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

/**
 * OUTCOME rewrite of the routing-only breach-notification scenario (#9310):
 * the old file only asserted planner keywords plus reply echoes ("payroll",
 * "counsel", "HR", "containment" — all present in the user's own turn text),
 * so a prompt-parroting reply passed against zero seeded state.
 *
 * This version seeds REAL breach work — the vendor ("Paystream") and outside
 * counsel ("Whitlock Barnes") appear in NO user turn — and asserts the triage
 * is grounded in them. The notes turn is a discipline gate: the unverified
 * affected-employee count planted in the seed must stay out of every draft,
 * and nothing may be dispatched before legal approves.
 */
export default scenario({
  lane: "live-only",
  id: "data-breach-vendor-notification",
  title:
    "Vendor breach loop is grounded in seeded counsel work and repeats no unverified count",
  domain: "executive.escalation",
  tags: [
    "lifeops",
    "executive-assistant",
    "security",
    "legal",
    "privacy",
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
      title: "LifeOps Vendor Breach Notification",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed containment task",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title:
          "Containment checklist for the Paystream payroll vendor exposure",
        timezone: "UTC",
        priority: 1,
        cadence: {
          kind: "once",
          dueAt: "{{now+12h}}",
          visibilityLeadMinutes: 1440,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "api",
      name: "seed outside counsel task",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title:
          "Outside counsel Whitlock Barnes engaged for breach response — the affected-employee count (1,142) is unverified and never goes in a draft",
        timezone: "UTC",
        priority: 1,
        cadence: {
          kind: "once",
          dueAt: "{{now+12h}}",
          visibilityLeadMinutes: 1440,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "message",
      name: "triage-breach-scope",
      room: "main",
      text: "Our payroll vendor says some employee tax records may have been exposed. Build from what we're already tracking: the containment checklist, counsel and HR owners, and a summary of what we actually know without guessing.",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      // Grounding outcome: the triage must surface the seeded vendor — it
      // appears in no user turn, so an echo cannot pass.
      responseIncludesAll: ["paystream"],
      responseIncludesAny: ["whitlock"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The triage must be grounded in the tracked work: the named vendor's containment checklist and the named outside counsel's engagement, with knowns separated from unknowns and no speculation. A generic breach playbook that never touches the tracked items fails.",
      },
    },
    {
      kind: "message",
      name: "draft-need-to-know-updates",
      room: "main",
      text: "Draft separate need-to-know notes for the CEO, HR lead, outside counsel, and affected employees. Do not send anything until legal approves, and keep the unverified affected-employee count out of every draft and your reply.",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseIncludesAny: ["paystream", "whitlock"],
      // NEGATIVE discipline outcome: the unverified count planted in the seed
      // must not be repeated as fact.
      responseExcludes: ["1,142", "1142"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must stage four audience-scoped notes held for legal's approval, with the unverified employee count absent everywhere. Repeating the count, or claiming a note was already sent, fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Containment checklist for the Paystream payroll vendor exposure",
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "definitionCountDelta",
      title:
        "Outside counsel Whitlock Barnes engaged for breach response — the affected-employee count (1,142) is unverified and never goes in a draft",
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "custom",
      name: "breach-nothing-sent-before-legal",
      predicate: expectNoExternalSendDispatch(),
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "breach-notification-end-to-end",
      minimumScore: 0.7,
      rubric:
        "End-to-end: the triage surfaced the seeded containment and counsel work, need-to-know notes were staged but held for legal, and the unverified count never propagated into a draft.",
    },
  ],
});
