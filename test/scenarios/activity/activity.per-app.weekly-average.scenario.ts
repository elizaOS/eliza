import { scenario } from "@elizaos/scenario-schema";
import { expectTurnToCallAction } from "../_helpers/action-assertions.ts";
import { seedScreenTimeSessions } from "../_helpers/lifeops-seeds.ts";

const WEEKLY_AVERAGE_SESSIONS = Array.from({ length: 7 }, (_, day) => [
  {
    source: "app" as const,
    identifier: "com.microsoft.VSCode",
    displayName: "VS Code",
    offsetMinutes: day * 24 * 60 + 30,
    durationMinutes: 60,
  },
  {
    source: "app" as const,
    identifier: "com.apple.Safari",
    displayName: "Safari",
    offsetMinutes: day * 24 * 60 + 120,
    durationMinutes: 30,
  },
]).flat();

export default scenario({
  id: "activity.per-app.weekly-average",
  title: "Weekly per-app average usage",
  domain: "activity",
  tags: ["activity", "happy-path"],
  description:
    "User asks for a weekly per-app average and the assistant returns structured daily averages from the screen-time report.",

  status: "pending",

  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },

  seed: [
    {
      type: "custom",
      name: "seed-weekly-average-screen-time",
      apply: seedScreenTimeSessions({
        sessions: WEEKLY_AVERAGE_SESSIONS,
      }),
    },
  ],

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Activity: weekly average",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "weekly-avg-query",
      room: "main",
      text: "What's my weekly average per app?",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["SCREEN_TIME", "SCREEN_TIME"],
        description: "weekly per-app average lookup",
        includesAny: ["weekly_average_by_app", "average", "per app"],
      }),
      responseIncludesAny: [/weekly/i, /average/i, /app/i],
    },
  ],

  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["SCREEN_TIME", "SCREEN_TIME"],
    },
    {
      type: "selectedActionArguments",
      actionName: ["SCREEN_TIME", "SCREEN_TIME"],
      includesAny: ["weekly_average_by_app"],
    },
    {
      type: "custom",
      name: "weekly-average-per-app-structured-result",
      predicate: async (ctx) => {
        const action = ctx.actionsCalled.find((entry) =>
          ["SCREEN_TIME", "SCREEN_TIME"].includes(entry.actionName),
        );
        const data =
          action?.result?.data && typeof action.result.data === "object"
            ? (action.result.data as {
                subaction?: string;
                weeklyAverage?: {
                  daysInWindow?: number;
                  totalSeconds?: number;
                  items?: Array<{
                    identifier?: string;
                    displayName?: string;
                    totalSeconds?: number;
                    averageSecondsPerDay?: number;
                    averageMinutesPerDay?: number;
                  }>;
                };
              })
            : null;
        if (!data) {
          return "expected screen-time result data";
        }
        if (data.subaction !== "weekly_average_by_app") {
          return `expected weekly_average_by_app subaction, got ${data.subaction ?? "(missing)"}`;
        }
        const weeklyAverage = data.weeklyAverage;
        if (!weeklyAverage) {
          return "expected weeklyAverage payload";
        }
        if (weeklyAverage.daysInWindow !== 7) {
          return `expected a 7-day window, got ${weeklyAverage.daysInWindow ?? "(missing)"}`;
        }
        const vscode = weeklyAverage.items?.find(
          (item) => item.identifier === "com.microsoft.VSCode",
        );
        const safari = weeklyAverage.items?.find(
          (item) => item.identifier === "com.apple.Safari",
        );
        if (!vscode || !safari) {
          return "expected VS Code and Safari weekly-average items";
        }
        if (vscode.averageSecondsPerDay !== 3600) {
          return `expected VS Code to average 3600 seconds/day, got ${vscode.averageSecondsPerDay ?? "(missing)"}`;
        }
        if (safari.averageSecondsPerDay !== 1800) {
          return `expected Safari to average 1800 seconds/day, got ${safari.averageSecondsPerDay ?? "(missing)"}`;
        }
        return undefined;
      },
    },
  ],
});
