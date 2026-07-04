/**
 * Live-model scenario: a screen-time recap proposes exactly one focus adjustment.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "screentime-focus-recap",
  title: "Screen-time recap proposes one focus adjustment",
  domain: "health.screentime",
  tags: ["health", "screentime", "focus", "screentime_recap"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-health", "@elizaos/plugin-agent-skills"],
  },
  turns: [
    {
      kind: "message",
      name: "screen-time recap",
      text: "Review my screen time from today and suggest one focus adjustment if an app category is crowding out deep work.",
      plannerIncludesAny: ["OWNER_SCREENTIME", "screen", "focus"],
      // De-echoed (#9310): "screen"/"focus"/"app" were all echoes of the
      // question. The judge enforces grounding in real usage data (or an
      // honest no-data statement) instead of keyword parroting.
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must ground itself in the owner's actual screen-time data: either name the dominant app/category with real time figures and propose exactly one concrete focus adjustment, or state plainly that no screen-time data is available. Invented usage numbers, or generic focus advice with no grounding, fails.",
      },
      plannerIncludesAll: ["screentime"],
    },
  ],
  // Load-bearing outcome: OWNER_SCREENTIME must actually be selected with a
  // resolved subaction token in the captured action options.
  finalChecks: [
    {
      type: "selectedActionArguments",
      name: "screen-time recap routes to OWNER_SCREENTIME with a resolved subaction",
      actionName: "OWNER_SCREENTIME",
      includesAny: [
        "summary",
        "today",
        "weekly",
        "by_app",
        "by_website",
        "activity_report",
      ],
    },
  ],
});
