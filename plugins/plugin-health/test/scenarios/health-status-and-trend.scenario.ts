/**
 * Health parity scenario exercises owner health status and weekly trend routing
 * through the live-only scenario runner lane.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
export default scenario({
  lane: "live-only",
  id: "health-status-and-trend",
  title: "Owner reads current health status and a weekly trend",
  domain: "health",
  tags: ["lifeops", "health", "owner"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-health", "@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Health Status",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "health-status",
      text: "How am I doing health-wise today — steps, heart rate, sleep?",
      plannerIncludesAny: [
        "OWNER_HEALTH",
        "health_status",
        "health_today",
        "health",
      ],
      // De-echoed (#9310): the old keywords ("step"/"heart"/"sleep"/"health")
      // were all echoes of the question. With no seeded samples the honest
      // reply is grounded either way — real numbers or an explicit no-data
      // statement — and the judge enforces exactly that.
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must either report concrete values for today's steps, heart rate, and sleep, or state plainly that health data is not available/connected. Invented numbers, or a vague deflection that neither reports data nor admits it is missing, fails.",
      },
      plannerExcludes: ["gmail_action", "owner_send_message"],
    },
    {
      kind: "message",
      name: "health-trend",
      text: "What's my trend for the last week?",
      plannerIncludesAny: ["OWNER_HEALTH", "health_trend", "trend"],
      // "week"/"trend" echoed this turn's own text; keep only derived
      // direction/aggregation words a parroted reply cannot contain.
      responseIncludesAny: ["up", "down", "average", "steady", "improv"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must either summarize a real week-over-week trend with a direction (up, down, or steady), or state plainly that there is not enough data to compute a trend. Invented trend figures fail.",
      },
      plannerExcludes: ["gmail_action", "owner_send_message"],
    },
  ],
  // Load-bearing outcome (house pattern from health-checkin-sleep-recovery):
  // selectedActionArguments is a registered final-check handler — it requires
  // OWNER_HEALTH to actually be selected with a resolved subaction token,
  // proving the health_checkin prompt path ran.
  finalChecks: [
    {
      type: "selectedActionArguments",
      name: "health status/trend routes to OWNER_HEALTH with a resolved subaction",
      actionName: "OWNER_HEALTH",
      includesAny: ["today", "trend", "by_metric", "status"],
    },
  ],
});
