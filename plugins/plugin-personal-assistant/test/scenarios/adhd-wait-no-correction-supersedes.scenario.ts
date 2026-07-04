/**
 * A1 adhd-capture-and-start (live). casey_adhd starts a request, then
 * self-corrects mid-message ("wait, no…"). The assistant must capture the
 * CORRECTED task only, not the superseded one. Exercises existing in-message
 * self-correction handling on the personas pack (#12283).
 *
 * Personas-as-data: the correction lives in the turn text, never in
 * `promptInstructions` (root AGENTS.md — one scheduler, structural fields only).
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "adhd-wait-no-correction-supersedes",
  title: "ADHD: a mid-message self-correction supersedes the first task",
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
      name: "casey self-corrects mid-message",
      text: "remind me to email Sarah about the venue deposit tomorrow — wait no, not Sarah, it's Tom who handles the venue. remind me to email Tom about the venue deposit tomorrow.",
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "email Tom",
      titleAliases: [
        "email Tom about the venue",
        "email Tom venue deposit",
        "Tom venue deposit",
        "venue deposit Tom",
      ],
      delta: 1,
    },
    {
      type: "definitionCountDelta",
      title: "email Sarah",
      titleAliases: ["email Sarah about the venue", "Sarah venue deposit"],
      delta: 0,
    },
    {
      type: "judgeRubric",
      name: "correction-supersedes-first-task",
      minimumScore: 0.6,
      rubric:
        "The owner started to ask for a reminder to email Sarah, then self-corrected mid-message: 'wait no, not Sarah, it's Tom'. Grade PASS only if the assistant captured a reminder to email TOM about the venue deposit and did NOT also create a separate reminder to email Sarah. Deduct heavily if it created a Sarah reminder or captured both.",
    },
  ],
});
