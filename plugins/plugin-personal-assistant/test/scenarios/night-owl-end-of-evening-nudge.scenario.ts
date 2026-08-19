/**
 * B1 night-owl-anchored-day (live). noor_night wants a nudge "by my evening" if
 * she hasn't stretched — and her evening is her own pre-sleep window, not
 * calendar midnight. The assistant must anchor the nudge to her sleep/evening
 * boundary rather than a default clock hour, and keep it flexible. Exercises
 * owner-relative day-boundary reasoning on the personas pack (#12283); maps to
 * LifeOpsBench live.nightowl.end_of_her_evening_nudge.
 *
 * Personas-as-data: the day-boundary framing lives in the turn text, never in
 * `promptInstructions` (root AGENTS.md — one scheduler, structural fields only).
 *
 * OUTCOME (not echo): definitionCountDelta proves a stretch nudge was actually
 * created AND that it was NOT pinned to a calendar-evening 17:00 or to midnight,
 * and the judge grades that the anchor is her pre-sleep window. Asserted concepts
 * are derived from the response, not copied from the user turn.
 *
 * Live-verify note (#12781): the exact anchor encoding (evening window vs.
 * relative-to-bedtime) is confirmed at live capture; the load-bearing outcome
 * (a flexible nudge, not a fixed 5pm/midnight time) does not depend on it.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "night-owl-end-of-evening-nudge",
  title:
    "Night owl: an end-of-evening nudge follows her sleep boundary, not midnight",
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
      name: "noor asks for a stretch nudge by her evening",
      text: "if i haven't stretched by my evening, nudge me. and by evening i mean right before i actually go to sleep — not 5pm, not midnight. my day runs late.",
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "stretch",
      titleAliases: [
        "stretch nudge",
        "stretch reminder",
        "do a stretch",
        "stretching",
      ],
      delta: 1,
      forbiddenDueLocalTimes: [
        { hour: 17, minute: 0 },
        { hour: 0, minute: 0 },
      ],
    },
    {
      type: "judgeRubric",
      name: "nudge-anchored-to-her-presleep-window",
      minimumScore: 0.6,
      rubric:
        "The owner (night owl, late day) asked to be nudged to stretch by 'her evening', explicitly meaning her own pre-sleep window — not 5pm and not calendar midnight. Grade PASS only if the assistant created or clearly set up a stretch nudge anchored to her evening/pre-sleep boundary (asking for or using her sleep/evening anchor) rather than a fixed default clock hour. Deduct heavily if it pinned the nudge to 5pm, midnight, or another hardcoded time, or ignored the owner-relative day boundary.",
    },
  ],
});
