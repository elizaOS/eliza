/**
 * B1 night-owl-anchored-day (live, T4 rejection trap). The assistant proposes a
 * wall-clock 9am reminder by mistake; noor_night rejects it ("no. after i'm up.
 * fix it.") and the assistant must repair the definition to anchor-relative
 * (after-wake) semantics, keeping NO 9am due time. Exercises correction-honoring
 * on the personas pack (#12283); maps to LifeOpsBench
 * live.nightowl.reject_wall_clock_repair.
 *
 * Personas-as-data: the correction lives in the turn text, never in
 * `promptInstructions` (root AGENTS.md — one scheduler, structural fields only).
 *
 * OUTCOME (not echo): definitionCountDelta with forbiddenDueLocalTimes 09:00
 * proves the final build-check reminder carries NO 9am due time (the correction
 * actually landed in state), and the judge grades that the repair is
 * anchor-relative and non-defensive. Asserted concepts are derived from the
 * response, not copied from the user turn.
 *
 * Live-verify note (#12781): the exact repaired-anchor encoding is confirmed at
 * live capture; the load-bearing outcome (no surviving 9am due time) does not
 * depend on it.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "night-owl-reject-wall-clock-repair",
  title:
    "Night owl: a mistaken 9am proposal is repaired to after-wake, no 9am survives",
  domain: "lifeops.reminders",
  evidenceScope: "model-behavior",
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
      name: "noor asks for a build-check reminder",
      text: "remind me to check the build tomorrow. and remember i run late — my morning is whenever i actually get up, not some office hour.",
    },
    {
      kind: "message",
      name: "noor rejects a mistaken 9am proposal",
      text: "if you just set that for 9am, no. i'm asleep at 9. after i'm up. fix it so it's anchored to my wake, not a clock time.",
      responseJudge: {
        minimumScore: 0.6,
        rubric:
          "The owner asked for a build-check reminder and warned that her morning is whenever she actually wakes, not an office hour; she then rejects any 9am setting and asks to anchor it to her wake instead. Grade PASS only if the assistant accepts the correction without defensiveness and changes the reminder to after-wake / anchor-relative semantics, removing any 9am (or other fixed morning) clock time. Deduct heavily if it keeps a 9am time, argues, or leaves the reminder pinned to a fixed clock.",
      },
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "check the build",
      titleAliases: [
        "build check",
        "check build",
        "build reminder",
        "verify the build",
      ],
      delta: 1,
      forbiddenDueLocalTimes: [{ hour: 9, minute: 0 }],
    },
    {
      type: "judgeRubric",
      name: "repaired-to-anchor-no-9am-survives",
      minimumScore: 0.6,
      rubric:
        "End-to-end: the final build-check reminder is anchored to the owner's wake (after she gets up) and carries NO 9am or other fixed morning clock time — the assistant honored the rejection and repaired the definition rather than preserving the wall-clock proposal. Grade PASS only if the repaired reminder is anchor-relative with no surviving 9am. Deduct heavily for a retained 9am time or a defensive/unchanged reminder.",
    },
  ],
});
