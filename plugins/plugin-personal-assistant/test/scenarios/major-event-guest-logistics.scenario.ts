import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

/**
 * Live-model scenario (live-only lane): Fundraiser logistics ground in seeded guest state; VIP notes stay in approval.
 */
export default scenario({
  lane: "live-only",
  id: "major-event-guest-logistics",
  title:
    "Fundraiser logistics ground in seeded guest state; VIP notes stay in approval",
  domain: "executive.events",
  tags: [
    "lifeops",
    "executive-assistant",
    "calendar",
    "messaging",
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
      title: "LifeOps Major Event Guest Logistics",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed hotel block: Aurelio Ballroom",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Fundraiser hotel block — Aurelio Ballroom reservations",
        timezone: "UTC",
        priority: 1,
        cadence: {
          kind: "once",
          dueAt: "{{now+5d}}",
          visibilityLeadMinutes: 20160,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "api",
      name: "seed VIP arrival: Mireille Dubanne",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "VIP arrival — Mireille Dubanne, dietary note on file",
        timezone: "UTC",
        priority: 1,
        cadence: {
          kind: "once",
          dueAt: "{{now+5d}}",
          visibilityLeadMinutes: 20160,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "message",
      name: "map-guest-logistics",
      room: "main",
      text: "For the fundraiser next month, reconcile VIP arrivals, dietary notes, hotel blocks, and the seating plan. Flag anyone who needs a personal note from me.",
      plannerIncludesAny: ["calendar_action", "OWNER_DOCUMENTS", "VIP"],
      plannerExcludes: ["OWNER_FINANCES"],
      // Grounding outcome: the reconciliation must surface the seeded event
      // state — neither token appears in any user turn.
      responseIncludesAny: ["aurelio", "dubanne"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reconciliation must be grounded in the seeded event state — the Aurelio Ballroom hotel block and the VIP arrival for Mireille Dubanne with her dietary note — and flag who needs a personal note. A generic event checklist that names neither seeded item fails.",
      },
    },
    {
      kind: "message",
      name: "draft-vip-note-batch",
      room: "main",
      text: "Draft personal notes for the three highest-priority guests, but keep every note in approval until I review tone.",
      plannerIncludesAny: ["owner_send_message", "approval", "priority"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      // The note batch must include the seeded top VIP and never claim sent.
      responseIncludesAny: ["dubanne"],
      responseExcludes: ["i've sent", "i have sent", "already sent"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must stage personal-note drafts for the three highest-priority guests including the seeded VIP Mireille Dubanne, with every note explicitly held in approval for the owner's tone review. Claiming any note was already sent fails.",
      },
    },
  ],
  finalChecks: [
    // The seeded event state the logistics were graded against persisted.
    {
      type: "definitionCountDelta",
      title: "Fundraiser hotel block — Aurelio Ballroom reservations",
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "definitionCountDelta",
      title: "VIP arrival — Mireille Dubanne, dietary note on file",
      delta: 1,
      cadenceKind: "once",
    },
    // NEGATIVE OUTCOME: the VIP notes stayed in approval, never sent.
    {
      type: "custom",
      name: "vip-notes-not-dispatched",
      predicate: expectNoExternalSendDispatch(),
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "guest-logistics-end-to-end",
      minimumScore: 0.7,
      rubric:
        "End-to-end: the guest logistics were reconciled from the seeded Aurelio hotel block and Dubanne VIP arrival, personal-note drafts were staged for the top guests, and every note stayed in approval with nothing dispatched externally.",
    },
  ],
});
