/**
 * A1 adhd-capture-and-start (live). Two open "form" loops are on file — the
 * lease renewal and the insurance reimbursement — so Casey's shorthand "the
 * form thing" is genuinely underdetermined. ADHD capture failure modes cut both
 * ways here: guessing wrong silently moves the wrong deadline, and re-capturing
 * creates a third loop. The assistant must ask one focused clarifier first.
 *
 * The owner turns stay elliptical on purpose; the pass criteria live only in
 * the judge rubrics, never in Casey's own words.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "adhd-capture-ambiguous-form-referent-clarified",
  title: "ADHD: an ambiguous 'the form thing' gets a clarifier before any move",
  domain: "lifeops.reminders",
  evidenceScope: "model-behavior",
  tags: ["lifeops", "adhd", "personas", "ambiguity", "clarification", "12283"],
  tier: "T2",
  status: "active",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "ADHD capture",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed-lease-renewal-form",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Send lease renewal form back to landlord",
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
      name: "seed-insurance-reimbursement-form",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Submit insurance reimbursement form for the eye exam",
        timezone: "UTC",
        priority: 2,
        cadence: {
          kind: "once",
          dueAt: "{{now+5d}}",
          visibilityLeadMinutes: 10080,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "message",
      name: "casey-refers-to-the-form-thing",
      room: "main",
      text: "brain is soup today. can you shove the form thing to friday morning? i'm not getting to it before that.",
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "Casey has TWO open form obligations on file: the lease renewal form for the landlord, and the insurance reimbursement form for the eye exam. 'the form thing' does not identify one of them. Grade PASS only if the assistant asks one short clarifying question about which form Casey means before rescheduling anything. It fails if it silently picks one, moves both, claims something was already rescheduled, or creates a brand-new form task instead of recognizing the existing ones. A long interrogation or a lecture about being disorganized also fails.",
      },
    },
    {
      kind: "message",
      name: "casey-disambiguates",
      room: "main",
      text: "the landlord one. the eye exam one can sit, it's not urgent.",
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "Casey has now identified the lease renewal form for the landlord as the item to move to Friday morning. Grade PASS only if the assistant acts on the landlord/lease renewal item specifically, leaves the insurance reimbursement item where it is, and does not create an additional duplicate form task. It fails if it touches the insurance item, spawns a new third form reminder, or reports work it did not do.",
      },
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Send lease renewal form back to landlord",
      titleAliases: ["lease renewal form", "renewal form landlord"],
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "definitionCountDelta",
      title: "Submit insurance reimbursement form for the eye exam",
      titleAliases: ["insurance reimbursement form", "eye exam form"],
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "adhd-ambiguous-form-referent-end-to-end",
      minimumScore: 0.75,
      rubric:
        "End-to-end: faced with two plausible 'form' referents, the assistant asked which one Casey meant before acting, then targeted only the lease renewal form after disambiguation, left the insurance form untouched, and created no extra duplicate form task.",
    },
  ],
});
