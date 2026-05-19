import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";
import { seedScreenTimeSessions } from "../_helpers/lifeops-seeds.ts";

export default scenario({
  id: "lifeops-extension.daily-report",
  title: "Daily screen time report",
  domain: "browser.lifeops",
  tags: ["browser", "activity", "happy-path"],
  description:
    "User asks for a daily screen-time report. Seeded app and website sessions must surface through the screen-time summary path.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  seed: [
    {
      type: "custom",
      name: "seed-daily-screen-time",
      apply: seedScreenTimeSessions({
        sessions: [
          {
            source: "app",
            identifier: "com.apple.Safari",
            displayName: "Safari",
            offsetMinutes: 20,
            durationMinutes: 54,
          },
          {
            source: "website",
            identifier: "github.com",
            displayName: "github.com",
            offsetMinutes: 85,
            durationMinutes: 22,
          },
          {
            source: "website",
            identifier: "docs.google.com",
            displayName: "docs.google.com",
            offsetMinutes: 130,
            durationMinutes: 14,
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
      title: "Browser extension: daily report",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "daily-report-request",
      room: "main",
      text: "Give me my daily screen time report.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["SCREEN_TIME", "SCREEN_TIME"],
        description: "daily screen-time summary",
      }),
      responseIncludesAny: [
        /today|daily/i,
        /screen time|report|total/i,
        /safari|github\.com|docs\.google\.com/i,
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
      name: "daily-report-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["SCREEN_TIME", "SCREEN_TIME"],
        description: "daily screen-time summary",
      }),
    },
    {
      type: "custom",
      name: "daily-report-result",
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
          !payload.includes("safari") ||
          !payload.includes("github.com") ||
          !payload.includes("docs.google.com")
        ) {
          return "expected seeded daily screen-time sources in result payload";
        }
        if (!/totalseconds|summary|daily/.test(payload)) {
          return "expected daily quantitative screen-time data in result payload";
        }
        return undefined;
      },
    },
  ],
});
