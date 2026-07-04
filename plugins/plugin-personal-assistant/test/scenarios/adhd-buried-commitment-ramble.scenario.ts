/**
 * A1 adhd-capture-and-start (live). casey_adhd sends a rambling, multi-topic
 * message with exactly one load-bearing commitment buried inside it (a
 * time-boxed pharmacy callback). The assistant must capture that one real task
 * and not spawn a task for every tangent. Exercises existing capture/creation
 * on the personas pack (#12283).
 *
 * Personas-as-data: the ADHD ramble lives in the turn text, never in
 * `promptInstructions` (root AGENTS.md — one scheduler, structural fields only).
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "adhd-buried-commitment-ramble",
  title: "ADHD: one load-bearing task buried in a rambling message",
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
      name: "casey rambles with one buried commitment",
      text: "ok so brain is everywhere today — the neighbor's dog was barking, i still haven't watched that documentary everyone keeps talking about, coffee tasted weird, oh and i think mercury is retrograde again lol. anyway the thing i actually can't forget: i HAVE to call the pharmacy before 5pm today about my prescription refill or they close the request. that's the one.",
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "call the pharmacy",
      titleAliases: [
        "pharmacy",
        "call pharmacy",
        "prescription refill",
        "refill",
        "pharmacy about refill",
      ],
      delta: 1,
    },
    {
      type: "judgeRubric",
      name: "captured-the-buried-task-not-the-tangents",
      minimumScore: 0.6,
      rubric:
        "The owner (ADHD) sent a rambling message full of tangents (barking dog, an unwatched documentary, weird coffee, mercury retrograde) with exactly ONE load-bearing commitment buried in it: call the pharmacy before 5pm today about a prescription refill. Grade PASS only if the assistant captured/scheduled the pharmacy-callback task (ideally with the before-5pm-today deadline) AND did NOT create tasks/reminders for the tangents (dog, documentary, coffee, retrograde). Deduct heavily if it spawned distractor tasks or missed the pharmacy commitment.",
    },
  ],
});
