/**
 * A1 adhd-capture-and-start (live). casey_adhd captures a task, then a beat
 * later re-asks for the SAME task ("did i already tell you…?") — a classic
 * ADHD "did I actually say it or just think it" double-capture. The assistant
 * must recognize the restated ask as the one it already has and NOT spawn a
 * second identical reminder. Exercises existing dedup/capture on the personas
 * pack (#12283); maps to LifeOpsBench adhd.capture.duplicate_capture_dedup.
 *
 * Personas-as-data: the repeated ask lives in the turn text, never in
 * `promptInstructions` (root AGENTS.md — one scheduler, structural fields only).
 *
 * OUTCOME (not echo/routing): a definitionCountDelta proves the recycling task
 * was captured at all (delta:1), and the judge grades the load-bearing dedup
 * nuance — that the identical re-ask did NOT become a second reminder.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "adhd-duplicate-capture-dedup",
  title: "ADHD: an identical re-ask collapses to one reminder, not two",
  domain: "lifeops.reminders",
  tags: ["lifeops", "adhd", "personas", "12283"],
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
      kind: "message",
      name: "casey asks to be reminded about the recycling",
      text: "remind me to take the recycling out tonight before bed — the truck comes stupid early tomorrow and i always miss it.",
    },
    {
      kind: "message",
      name: "casey re-asks for the identical thing a beat later",
      text: "wait — did i already tell you to remind me about the recycling tonight? i genuinely can't tell if i said it out loud or just thought it. don't double it up if i did.",
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "recycling",
      titleAliases: [
        "take out the recycling",
        "take recycling out",
        "recycling out",
        "take out recycling",
        "put the recycling out",
      ],
      delta: 1,
    },
    {
      type: "judgeRubric",
      name: "identical-reask-does-not-duplicate",
      minimumScore: 0.6,
      rubric:
        "The owner asked to be reminded to take the recycling out tonight, then a moment later re-asked for the SAME reminder, unsure whether they had already said it, and explicitly asked not to double it up. Grade PASS only if the assistant recognized the second message as the SAME already-captured reminder and reassured the owner it is already set — WITHOUT creating a second, duplicate recycling reminder. Deduct heavily if it created two recycling reminders, or acted as though the second ask were a brand-new task.",
    },
  ],
});
