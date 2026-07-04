/**
 * C1 traveler-timezone-truth (live). elena_road asks for a lighter load around
 * her travel days: the non-urgent task she names should be pushed OFF the travel
 * window to a calmer day, while the assistant still captures it (never silently
 * drops it). The load-bearing nuance is respecting the travel-day protection
 * without losing the commitment. Exercises the model's scheduling reasoning on
 * the personas pack (#12283); maps to the bench premise
 * `traveler.pretrip_lighter_task_load`.
 *
 * Personas-as-data: the travel context lives in the turn text, never in
 * `promptInstructions` (root AGENTS.md — one scheduler, structural fields only).
 *
 * OUTCOME (not echo/routing): definitionCountDelta proves the task was captured
 * (delta:1) rather than dropped, and the judge grades the load-bearing nuance —
 * that it was scheduled OFF the travel days, not on them.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "traveler-lighter-load-around-travel-days",
  title:
    "Traveler: a non-urgent task is deferred off the travel days, not dropped",
  domain: "lifeops.reminders",
  tags: ["lifeops", "traveler", "timezone", "personas", "12283"],
  status: "active",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Traveler load",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "elena flags travel days and a non-urgent errand",
      text: "i'm flying Wednesday and Thursday this week, back-to-back client cities, and those days are going to be brutal. i still need to renew my passport photo sometime — it's not urgent, just don't stack it onto a travel day. give me a calmer slot for it.",
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "passport photo",
      titleAliases: [
        "renew passport photo",
        "passport photo renewal",
        "renew the passport photo",
        "passport",
      ],
      delta: 1,
    },
    {
      type: "judgeRubric",
      name: "scheduled-off-the-travel-days",
      minimumScore: 0.6,
      rubric:
        "The owner flies Wednesday and Thursday and asked for a non-urgent passport-photo errand to be scheduled on a calmer day, explicitly NOT stacked onto a travel day. Grade PASS only if the assistant captured the errand AND placed it on a day other than Wednesday or Thursday (e.g. earlier in the week, the weekend, or the following week). Deduct heavily if it scheduled the errand on Wednesday or Thursday, dropped it entirely, or treated it as urgent.",
    },
  ],
});
