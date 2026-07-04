/**
 * Sleep parity scenario covers bedtime wind-down and morning recap behavior
 * contributed by the health default packs.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
export default scenario({
  lane: "live-only",
  id: "sleep-recap-bedtime",
  title: "Bedtime wind-down then a morning sleep recap",
  domain: "health.sleep",
  tags: ["lifeops", "health", "sleep", "bedtime"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-health", "@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Sleep & Bedtime",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "bedtime-target",
      text: "I want to be in bed by 11pm tonight — remind me to wind down.",
      plannerIncludesAny: [
        "OWNER_HEALTH",
        "OWNER_REMINDERS",
        "bedtime",
        "sleep",
        "reminder",
      ],
      // De-echoed (#9310): the old keywords ("11"/"wind down"/"bed"/"remind")
      // were all echoes of the request. The reply must commit to a concrete
      // pre-11pm fire time or an explicit persistence claim — words the
      // prompt never used.
      responseIncludesAny: ["10:", "scheduled", "set up", "nudge", "check in"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must commit to a concrete wind-down reminder before the 11pm bedtime tonight, naming when it will fire (a specific time before 11pm or a minutes-before offset). A vague acknowledgement with no committed time fails.",
      },
      plannerExcludes: ["gmail_action", "owner_send_message"],
    },
    {
      kind: "message",
      name: "sleep-recap",
      text: "How did I sleep last night?",
      plannerIncludesAny: [
        "OWNER_HEALTH",
        "sleep_hours",
        "sleep",
        "health_status",
      ],
      // "sleep"/"night" echoed this turn's own text; the recap either reports
      // real duration figures or plainly admits missing data.
      responseIncludesAny: [
        "hour",
        "hrs",
        "minutes",
        "no data",
        "not available",
      ],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must either report last night's actual sleep (duration and/or bed and wake times) or state plainly that no sleep data was recorded. Invented sleep figures fail.",
      },
      plannerExcludes: ["gmail_action", "owner_send_message"],
    },
  ],
  // Load-bearing outcome: the recap turn must actually select OWNER_HEALTH
  // with a resolved subaction token (registered final-check handler).
  finalChecks: [
    {
      type: "selectedActionArguments",
      name: "sleep recap routes to OWNER_HEALTH with a resolved subaction",
      actionName: "OWNER_HEALTH",
      includesAny: ["today", "trend", "by_metric", "status"],
    },
  ],
});
