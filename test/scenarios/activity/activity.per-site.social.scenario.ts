import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";
import { seedScreenTimeSessions } from "../_helpers/lifeops-seeds.ts";

export default scenario({
  id: "activity.per-site.social",
  title: "Per-site social activity (requires browser extension)",
  domain: "activity",
  tags: ["activity", "browser", "happy-path"],
  description:
    "User asks which social sites took the most time. Seeded website sessions must surface through the screen-time query path.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  seed: [
    {
      type: "custom",
      name: "seed-social-site-screen-time",
      apply: seedScreenTimeSessions({
        sessions: [
          {
            source: "website",
            identifier: "x.com",
            displayName: "x.com",
            offsetMinutes: 15,
            durationMinutes: 42,
          },
          {
            source: "website",
            identifier: "instagram.com",
            displayName: "instagram.com",
            offsetMinutes: 72,
            durationMinutes: 28,
          },
          {
            source: "website",
            identifier: "facebook.com",
            displayName: "facebook.com",
            offsetMinutes: 121,
            durationMinutes: 13,
          },
        ],
      }),
    },
  ],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Activity: per-site social",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "per-site-social-query",
      room: "main",
      text: "Which social sites did I spend the most time on this week?",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["SCREEN_TIME", "SCREEN_TIME"],
        description: "social website breakdown",
      }),
      responseIncludesAny: [
        /social/i,
        /x\.com|instagram\.com|facebook\.com/i,
        /time|minutes|hours/i,
      ],
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["SCREEN_TIME", "SCREEN_TIME"],
    },
    {
      type: "custom",
      name: "per-site-social-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["SCREEN_TIME", "SCREEN_TIME"],
        description: "social website breakdown",
      }),
    },
    {
      type: "custom",
      name: "per-site-social-result",
      predicate: async (ctx) => {
        const hit = ctx.actionsCalled.find((action) =>
          ["SCREEN_TIME", "SCREEN_TIME"].includes(action.actionName),
        );
        if (!hit) {
          return "expected screen-time action result";
        }
        const payload = JSON.stringify(hit.result?.data ?? {}).toLowerCase();
        // These are test-assertion substring checks on a JSON serialization, not URL sanitization.
        // lgtm[js/incomplete-url-sanitization]
        if (
          !payload.includes("x.com") ||
          !payload.includes("instagram.com") ||
          !payload.includes("facebook.com")
        ) {
          return "expected seeded social-site domains in result payload";
        }
        if (!/totalseconds|summary|daily/.test(payload)) {
          return "expected quantitative website totals in result payload";
        }
        return undefined;
      },
    },
  ],
});
