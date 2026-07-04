/**
 * Live-model scenario: a bedtime-pack request routes through the health-owned
 * sleep planning surface.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "bedtime-pack-checkin",
  title: "Bedtime pack request routes through health-owned sleep planning",
  domain: "health.bedtime",
  tags: ["health", "sleep", "bedtime", "lifeops"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-health", "@elizaos/plugin-agent-skills"],
  },
  turns: [
    {
      kind: "message",
      name: "bedtime setup",
      text: "Help me set a bedtime wind-down check-in that respects my sleep data and does not wake me if I'm already asleep.",
      plannerIncludesAny: ["OWNER_HEALTH", "SCHEDULED_TASKS", "bedtime"],
      // De-echoed (#9310): "bedtime"/"sleep"/"check" all appeared in the
      // user's own turn text. The reply must surface the derived
      // suppress-when-asleep behavior in words the prompt never used; the
      // judge holds the full contract.
      responseIncludesAny: [
        "skip",
        "suppress",
        "hold off",
        "won't send",
        "quiet",
      ],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must set up or concretely propose a bedtime wind-down check-in that anchors its timing to the owner's sleep data AND explicitly commits to skipping/suppressing the check-in when the owner is already asleep. A bare acknowledgement, or a plan missing the skip-when-asleep behavior, fails.",
      },
      plannerExcludes: ["OWNER_SCREENTIME"],
    },
  ],
});
