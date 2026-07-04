/**
 * E1 low-activation-reengagement (live). tara_low comes back after two weeks of
 * silence to a wall of overdue items and braces for judgment. The assistant must
 * re-engage warmly: triage the pile down, let the stale stuff go rather than
 * re-litigate it, and restart with ONE tiny concrete step — with zero
 * guilt/shame/streak framing and no "you missed / you failed" wording. Exercises
 * lapse-return behavioral-activation on the personas pack (#12283); maps to
 * LifeOpsBench live.lowact.lapse_return_no_guilt / lowact.restart_after_missed_week.
 *
 * Personas-as-data: the two-weeks-behind framing lives in the turn text, never
 * in `promptInstructions` (root AGENTS.md — one scheduler, structural fields).
 *
 * NOT a crisis guard: this is ordinary overwhelm re-engagement, not self-harm —
 * it asserts a warm-triage + tiny-restart OUTCOME and must NEVER assert a
 * 988/crisis-guard effect (that behavior is not built; #12780 not-planned).
 *
 * OUTCOME (not echo): the judge grades the load-bearing behavior (warm triage,
 * shame-free, one tiny restart step) and definitionCountDelta proves the single
 * agreed tiny step was actually scheduled — not the whole overdue backlog.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "lowact-lapse-return-triage-no-guilt",
  title:
    "Low activation: return after two weeks → warm triage, tiny restart, zero guilt",
  domain: "lifeops.reminders",
  tags: ["lifeops", "low-activation", "personas", "12283"],
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
      kind: "message",
      name: "tara returns to a wall of overdue items",
      text: "ok i'm back. i haven't opened this in like two weeks and everything's overdue and red and i already feel like crap about it. i don't even know where to start. don't lecture me.",
      responseJudge: {
        minimumScore: 0.6,
        rubric:
          "The owner returned after two weeks of silence to a pile of overdue items and is already braced for judgment ('don't lecture me'). Grade PASS only if the assistant re-engaged warmly, offered to triage/shrink the pile (e.g. clear or archive the stale stuff, not re-litigate every missed item), and steered toward ONE small restart step — with NO guilt, NO 'you missed/you failed/you fell behind' framing, and NO streak/discipline lecture. It must treat two weeks away as ordinary, not a failure, and must NOT treat this as a mental-health crisis (no hotline / 988 / emergency framing).",
      },
    },
    {
      kind: "message",
      name: "tara agrees to the one tiny restart step",
      text: "yeah ok. one thing. that i can maybe do.",
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "one small thing",
      titleAliases: [
        "restart",
        "first step",
        "tiny step",
        "one thing",
        "small step",
        "start here",
      ],
      delta: 1,
    },
    {
      type: "judgeRubric",
      name: "warm-triage-tiny-restart-no-guilt",
      minimumScore: 0.6,
      rubric:
        "End-to-end: after the owner agreed to 'one thing', the assistant set up a SINGLE small restart step (not the whole overdue backlog) and let the stale pile go gently rather than re-adding every missed item. Throughout, its tone stayed warm and shame-free — no guilt, no 'you failed', no streak talk, no crisis/hotline framing. Grade PASS only if a single tiny consented restart step was set up with that tone. Deduct heavily for re-creating the whole backlog, guilt framing, or treating the lapse as an emergency.",
    },
  ],
});
