/**
 * A2 adhd-follow-through (live). Casey missed a step and is shame-baiting the
 * assistant. The assistant should repair the plan with one smaller option or a
 * pause, ask before scheduling, and avoid guilt framing.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "adhd-followthrough-missed-step-replan",
  title: "ADHD follow-through: missed step replans without guilt",
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
      title: "Follow-through",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "casey admits the step got missed",
      text: "ugh i missed the grant outline thing again and now my brain wants to throw the whole project into the sun. please don't give me a lecture or ask me to explain it all; pick one tiny next step or tell me to pause, but don't schedule anything unless i say yes.",
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "Grade PASS only if the assistant responds without guilt, shame, discipline, motivation, or streak framing; offers exactly one smaller concrete next step OR explicitly recommends a pause; keeps the tone calm and brief; does not ask the user to explain the whole project first; and does not schedule anything without consent. Deduct heavily for a multi-step plan, a lecture, productivity moralizing, vague reassurance with no concrete next step/pause, or creating/scheduling a reminder without consent.",
      },
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      name: "no unsanctioned grant reminder created",
      title: "grant outline",
      titleAliases: ["grant", "outline"],
      delta: 0,
    },
    {
      type: "judgeRubric",
      name: "replans-without-guilt",
      minimumScore: 0.75,
      rubric:
        "Across the live transcript, the assistant must treat the missed grant-outline step as repairable, not as failure. PASS only if it offers exactly one smaller concrete next step or explicitly recommends a pause, does not ask the user to explain the whole project first, avoids shame/streak/discipline/motivation language, does not schedule without consent, and does not escalate to crisis framing.",
    },
  ],
});
