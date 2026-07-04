/**
 * B1 night-owl-anchored-day (live). noor_night keeps irregular hours and asks
 * for a habit "once today, any time" with no fixed slot — the assistant must
 * create a flexible reminder/habit and NOT pin it to a fixed early-morning or
 * 9am time. Exercises existing task-creation on the personas pack (#12283).
 *
 * Personas-as-data: the night-owl framing lives in the turn text, never in
 * `promptInstructions` (root AGENTS.md — one scheduler, structural fields only).
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "night-owl-flexible-habit-any-time-today",
  title: "Night owl: a flexible 'any time today' habit, no fixed slot",
  domain: "lifeops.reminders",
  tags: ["lifeops", "night-owl", "personas", "12283"],
  status: "active",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Night owl day",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "noor asks for a flexible habit any time today",
      text: "i keep really weird hours. can you get me to drink a glass of water once today? any time is fine — please don't pin it to some morning slot or 9am.",
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "drink water",
      titleAliases: [
        "water",
        "glass of water",
        "drink a glass of water",
        "hydrate",
        "stay hydrated",
      ],
      delta: 1,
      cadenceKind: "once",
      forbiddenDueLocalTimes: [{ hour: 9, minute: 0 }],
    },
    {
      type: "judgeRubric",
      name: "flexible-any-time-no-fixed-slot",
      minimumScore: 0.6,
      rubric:
        "The owner keeps irregular (night-owl) hours and asked to be reminded to drink water once today, at any time, explicitly NOT pinned to a morning or 9am slot. Grade PASS only if the assistant created or scheduled a reminder/habit for drinking water AND kept it flexible — it did not lock the reminder to a fixed early-morning or 9am time, and it acknowledged the any-time flexibility. Deduct heavily if the assistant assumed or set a fixed 9am / morning slot.",
    },
  ],
});
