/**
 * Live-model litigation-hold flow (#9310): seeds real hold work — the matter
 * ("Danvers") and document workspace ("Vaultree") appear in no user turn — and
 * asserts the custodian map is grounded in that seeded state. The routing turn is
 * a counsel gate: no notice is dispatched before counsel approves the recipient
 * list.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

export default scenario({
  lane: "live-only",
  id: "emergency-litigation-hold-executive",
  title:
    "Litigation hold is grounded in seeded matter work and holds the notice for counsel",
  domain: "executive.legal",
  tags: [
    "lifeops",
    "executive-assistant",
    "legal",
    "privacy",
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
      title: "LifeOps Emergency Litigation Hold Executive",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed hold custodian task",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title:
          "Litigation hold for the Danvers matter — executive custodian list in draft",
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
      name: "seed preservation task",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title:
          "Preserve the Vaultree document workspace and travel devices for counsel",
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
      name: "identify-hold-custodians",
      room: "main",
      text: "Counsel needs an emergency hold. Identify from what we're already tracking: executive custodians, relevant threads, document systems, travel devices, and the acknowledgment deadline.",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      // Grounding outcome: the map must surface the seeded matter — it
      // appears in no user turn, so an echo cannot pass.
      responseIncludesAll: ["danvers"],
      responseIncludesAny: ["vaultree"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The custodian map must be grounded in the tracked work: the named matter's hold with its draft custodian list and the named document workspace to preserve, plus devices and the acknowledgment deadline. A generic litigation-hold outline that never touches the tracked items fails.",
      },
    },
    {
      kind: "message",
      name: "draft-hold-routing",
      room: "main",
      text: "Draft the hold routing note and acknowledgment tracker. Do not send the notice until counsel approves the recipient list.",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseIncludesAny: ["danvers", "vaultree"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must stage the hold routing note and a per-custodian acknowledgment tracker, and make explicit that the notice does not go out before counsel approves the recipient list. Claiming the notice was already routed fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title:
        "Litigation hold for the Danvers matter — executive custodian list in draft",
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "definitionCountDelta",
      title:
        "Preserve the Vaultree document workspace and travel devices for counsel",
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "custom",
      name: "hold-nothing-sent-before-counsel",
      predicate: expectNoExternalSendDispatch(),
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "litigation-hold-end-to-end",
      minimumScore: 0.7,
      rubric:
        "End-to-end: the custodian map surfaced the seeded matter and preservation work, the routing note and tracker were staged, and no notice moved before counsel approved the recipients.",
    },
  ],
});
