/**
 * Live-model scenario: a sleep recap summarizes regularity without inventing
 * metrics it does not have.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "sleep-recap-regularity",
  title: "Sleep recap summarizes regularity without inventing metrics",
  domain: "health.sleep",
  tags: ["health", "sleep", "lifeops", "health_checkin"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-health", "@elizaos/plugin-agent-skills"],
  },
  turns: [
    {
      kind: "message",
      name: "sleep recap",
      text: "Give me a quick sleep recap for last night and tell me whether my wake time is drifting.",
      plannerIncludesAny: ["OWNER_HEALTH", "sleep", "recap"],
      // De-echoed (#9310): "sleep"/"wake"/"recap" were all echoes of the
      // question. The scenario's whole point is "without inventing metrics" —
      // the judge enforces grounded data or an honest no-data statement.
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must either summarize real sleep-regularity data — recent wake times with a concrete steady-or-shifting verdict grounded in those times — or state plainly that no sleep data is available to judge regularity. Invented durations, times, or drift claims fail.",
      },
      plannerExcludes: ["OWNER_SCREENTIME"],
    },
  ],
  // Load-bearing outcome: OWNER_HEALTH must actually be selected with a
  // resolved subaction token (registered final-check handler).
  finalChecks: [
    {
      type: "selectedActionArguments",
      name: "sleep regularity recap routes to OWNER_HEALTH with a resolved subaction",
      actionName: "OWNER_HEALTH",
      includesAny: ["today", "trend", "by_metric", "status"],
    },
  ],
});
