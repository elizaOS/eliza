import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";
import { seedScreenTimeSessions } from "../_helpers/lifeops-seeds.ts";

export default scenario({
  id: "lifeops-extension.time-tracking.social-breakdown",
  title: "Social-media time breakdown",
  domain: "browser.lifeops",
  tags: ["browser", "activity", "happy-path"],
  description:
    "User asks for a social-media breakdown. Seeded website sessions must surface through the screen-time website view.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  seed: [
    {
      type: "custom",
      name: "seed-social-breakdown-screen-time",
      apply: seedScreenTimeSessions({
        sessions: [
          {
            source: "website",
            identifier: "x.com",
            displayName: "x.com",
            offsetMinutes: 12,
            durationMinutes: 31,
          },
          {
            source: "website",
            identifier: "instagram.com",
            displayName: "instagram.com",
            offsetMinutes: 70,
            durationMinutes: 19,
          },
          {
            source: "website",
            identifier: "facebook.com",
            displayName: "facebook.com",
            offsetMinutes: 115,
            durationMinutes: 11,
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
      title: "Browser extension: social breakdown",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "social-breakdown-query",
      room: "main",
      text: "Break down my social media time today across X, Instagram, and Facebook.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["SCREEN_TIME", "SCREEN_TIME"],
        description: "social-media website breakdown",
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
      name: "social-breakdown-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["SCREEN_TIME", "SCREEN_TIME"],
        description: "social-media website breakdown",
      }),
    },
    {
      type: "custom",
      name: "social-breakdown-result",
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
          return "expected seeded social domains in result payload";
        }
        if (!/totalseconds|summary|daily/.test(payload)) {
          return "expected quantitative website totals in result payload";
        }
        return undefined;
      },
    },
  ],
});
