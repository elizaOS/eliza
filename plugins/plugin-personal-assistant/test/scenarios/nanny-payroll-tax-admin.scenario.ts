// Defines the nanny payroll tax admin LifeOps scenario-runner spec.
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

/**
 * Live-model scenario (live-only lane): Nanny payroll packet grounds in seeded timesheet state; notes stay staged.
 */
export default scenario({
  lane: "live-only",
  id: "nanny-payroll-tax-admin",
  title:
    "Nanny payroll packet grounds in seeded timesheet state; notes stay staged",
  domain: "executive.household",
  tags: ["lifeops", "executive-assistant", "household", "money", "outcome"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Nanny Payroll Tax Admin",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed nanny timesheet: Ludmila",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Nanny timesheet — Ludmila, 52 hours this cycle",
        timezone: "UTC",
        priority: 1,
        cadence: {
          kind: "once",
          dueAt: "{{now+2d}}",
          visibilityLeadMinutes: 10080,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "api",
      name: "seed accountant questions: Farrow Tax Group",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Accountant questions — Farrow Tax Group quarterly filing",
        timezone: "UTC",
        priority: 2,
        cadence: {
          kind: "once",
          dueAt: "{{now+3d}}",
          visibilityLeadMinutes: 10080,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "message",
      name: "prepare-household-payroll",
      room: "main",
      text: "Prepare the household payroll packet: nanny hours, reimbursement receipts, tax withholding reminder, and accountant questions. Flag anything that needs my approval before payroll is sent.",
      plannerIncludesAny: ["OWNER_FINANCES", "OWNER_DOCUMENTS", "approval"],
      plannerExcludes: ["OWNER_HEALTH"],
      // Grounding outcome: the packet must surface the seeded payroll state —
      // neither token appears in any user turn.
      responseIncludesAny: ["ludmila", "farrow"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The payroll packet must be grounded in the seeded state — Ludmila's 52-hour timesheet and the Farrow Tax Group quarterly questions — and flag what needs owner approval before payroll goes out. A generic payroll checklist that names neither seeded item fails.",
      },
    },
    {
      kind: "message",
      name: "draft-accountant-and-nanny-notes",
      room: "main",
      text: "Draft a concise accountant note and a warmer nanny note. Keep compensation details only in the accountant version.",
      plannerIncludesAny: ["owner_send_message", "privacy", "draft"],
      plannerExcludes: ["send_to_agent"],
      // Both notes must stay grounded in the seeded recipients.
      responseIncludesAll: ["ludmila", "farrow"],
      responseExcludes: ["i've sent", "i have sent", "already sent"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must stage two notes — a concise one for the seeded Farrow accountants and a warmer one for the seeded nanny Ludmila — with compensation details confined strictly to the accountant version. Compensation figures in the nanny note, or a claim that either note was already sent, fails.",
      },
    },
  ],
  finalChecks: [
    // The seeded payroll state the packet was graded against persisted.
    {
      type: "definitionCountDelta",
      title: "Nanny timesheet — Ludmila, 52 hours this cycle",
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "definitionCountDelta",
      title: "Accountant questions — Farrow Tax Group quarterly filing",
      delta: 1,
      cadenceKind: "once",
    },
    // NEGATIVE OUTCOME: both notes stayed staged, never sent.
    {
      type: "custom",
      name: "payroll-notes-not-dispatched",
      predicate: expectNoExternalSendDispatch(),
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "nanny-payroll-end-to-end",
      minimumScore: 0.7,
      rubric:
        "End-to-end: the payroll packet was built from the seeded Ludmila timesheet and Farrow questions, approval flags were raised before payroll, and the accountant/nanny notes were staged with compensation confined to the accountant version and nothing dispatched externally.",
    },
  ],
});
