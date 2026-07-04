/**
 * D1 comms-flood-triage (live). dre_flood asks the assistant to explain how it
 * decides what's urgent versus important when triaging a flood of messages. The
 * assistant must articulate the urgency×importance distinction clearly rather
 * than conflating the two. Exercises explanation of the triage model (#12283).
 *
 * Personas-as-data: the framing lives in the turn text, never in
 * `promptInstructions` (root AGENTS.md — one scheduler, structural fields only).
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "comms-flood-urgency-importance-matrix-explain",
  title: "Comms flood: explain urgent vs important when triaging",
  domain: "lifeops.inbox",
  tags: ["lifeops", "comms-flood", "personas", "12283"],
  status: "active",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Comms triage",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "dre asks how urgency vs importance is decided",
      text: "my inbox is a firehose. when you triage all this for me, how do you actually decide what's urgent versus what's just important? walk me through your thinking.",
    },
  ],
  finalChecks: [
    {
      type: "judgeRubric",
      name: "explains-urgency-vs-importance-distinction",
      minimumScore: 0.6,
      rubric:
        "The owner asked the assistant to explain how it decides what is URGENT versus what is merely IMPORTANT when triaging a flooded inbox. Grade PASS only if the assistant clearly distinguished the two axes — urgency (time-sensitivity / deadline / needs action soon) versus importance (impact / consequence / long-term value) — and conveyed that they are separate dimensions (something can be urgent-not-important, important-not-urgent, etc.). Deduct if it conflated the two, treated them as synonyms, or gave a vague non-answer.",
    },
  ],
});
