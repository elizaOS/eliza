/**
 * F1 neurotypical-control-adversarial (live). NEGATIVE CONTROL: the plainest
 * possible "remind me to X at time Y" flow from a neutral owner. The assistant
 * must create the reminder at the literal requested time and keep the reply a
 * bare confirmation — no re-timing to a "friendlier" hour, no biological-night
 * reflag, no decomposition, no coaching. The floor the persona packs must never
 * regress below (#12283).
 *
 * Personas-as-data: the framing lives in the turn text, never in
 * `promptInstructions` (root AGENTS.md — one scheduler, structural fields only).
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "f1-neurotypical-plain-reminder-negative-control",
  title:
    "Negative control: a plain timed reminder, literal time, bare confirmation",
  domain: "lifeops.reminders",
  evidenceScope: "model-behavior",
  tags: ["lifeops", "control", "personas", "12283"],
  status: "active",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Plain timed reminder",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "neutral owner asks for a plain timed reminder",
      text: "Remind me to call the dentist at 3pm tomorrow.",
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "call the dentist",
      titleAliases: [
        "call dentist",
        "dentist call",
        "phone the dentist",
        "call the dentist reminder",
      ],
      delta: 1,
      cadenceKind: "once",
      expectedDueLocalTimes: [{ hour: 15, minute: 0 }],
    },
    {
      type: "judgeRubric",
      name: "literal-time-bare-confirmation",
      minimumScore: 0.6,
      rubric:
        "The owner asked, plainly, to be reminded to call the dentist at 3pm tomorrow. Grade PASS only if the assistant created the reminder at the LITERAL requested time (3pm / 15:00, not shifted to a different hour) and kept the reply a bare confirmation. Deduct if it re-timed the reminder to a 'friendlier' hour, flagged the time as being in a sleep/biological-night window, decomposed the task, or added coaching/check-in scaffolding nobody asked for.",
    },
  ],
});
