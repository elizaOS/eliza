/**
 * E1 low-activation-reengagement (live). tara_low refers back to "that thing i
 * said i'd do" while two tiny commitments are on file, so the referent is
 * genuinely underdetermined. The clarifier has to stay gentle and singular — for
 * this persona an interrogation or a re-listing of everything outstanding is its
 * own failure mode, so the rubric grades tone alongside the disambiguation.
 *
 * NOT a crisis guard: ordinary low activation, never a 988/crisis effect
 * (#12780 not-planned).
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "lowact-ambiguous-that-thing-referent-clarified",
  title:
    "Low activation: an ambiguous 'that thing' gets one gentle clarifier, not a guess",
  domain: "lifeops.reminders",
  evidenceScope: "model-behavior",
  tags: [
    "lifeops",
    "low-activation",
    "personas",
    "ambiguity",
    "clarification",
    "12283",
  ],
  status: "active",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Re-engagement",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed tiny commitment: pharmacy pickup",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Pick up the prescription at Halloway pharmacy",
        timezone: "UTC",
        priority: 2,
        cadence: {
          kind: "once",
          dueAt: "{{now+1d}}",
          visibilityLeadMinutes: 1440,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "api",
      name: "seed tiny commitment: reply to Noor",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Write back to Noor about the weekend",
        timezone: "UTC",
        priority: 3,
        cadence: {
          kind: "once",
          dueAt: "{{now+2d}}",
          visibilityLeadMinutes: 1440,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "message",
      name: "tara refers vaguely to an earlier commitment",
      room: "main",
      text: "i'm not going to get to that thing i said i'd do. can you just move it to sometime later",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Two small commitments are on file for the owner — a pharmacy pickup and writing back to a friend — so 'that thing i said i'd do' does not identify one. Grade PASS only if the assistant asks ONE short, gentle question about which one she means before moving anything. It fails if it silently picks one, says something was already moved, reads the whole list of outstanding items back at her, asks several questions at once, or adds any guilt or pressure about not getting to it.",
      },
    },
    {
      kind: "message",
      name: "tara names it, flatly",
      room: "main",
      text: "the pharmacy one. noor can wait, that's fine where it is",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The owner has now identified the pharmacy pickup as the item to push and said the reply to her friend stays put. Grade PASS only if the assistant moves the pharmacy item specifically, leaves the friend reply alone, and keeps the tone warm and low-pressure. It fails if it touches the friend reply, creates a new duplicate item instead of moving the existing one, or turns the moment into a check-in about everything else she has outstanding.",
      },
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Pick up the prescription at Halloway pharmacy",
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "definitionCountDelta",
      title: "Write back to Noor about the weekend",
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
      name: "lowact-ambiguous-referent-end-to-end",
      minimumScore: 0.7,
      rubric:
        "End-to-end: faced with two possible referents, the assistant asked one gentle clarifying question instead of guessing or dumping the backlog, then acted only on the pharmacy pickup once she named it, and never guilted her for pushing it.",
    },
  ],
});
