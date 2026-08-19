/** Proves OWNER_SCREENTIME computes exact per-app seven-day averages. */

import { scenario } from "@elizaos/scenario-runner/schema";
import { seedScreenTimeSessions } from "../../../scenario-support/lifeops-seeds.ts";

const WEEKLY_AVERAGE_SESSIONS = Array.from({ length: 7 }, (_, day) => [
  {
    source: "app" as const,
    identifier: "test.eliza.ScenarioEditor",
    displayName: "Scenario Editor",
    offsetMinutes: day * 24 * 60 + 30,
    durationMinutes: 60,
  },
  {
    source: "app" as const,
    identifier: "test.eliza.ScenarioBrowser",
    displayName: "Scenario Browser",
    offsetMinutes: day * 24 * 60 + 120,
    durationMinutes: 30,
  },
]).flat();

export default scenario({
  lane: "pr-deterministic",
  id: "activity.per-app.weekly-average",
  title: "Weekly per-app average usage",
  domain: "activity",
  evidenceScope: "domain-contract",
  executionProfile: "simulated",
  tags: ["activity", "screen-time", "aggregation", "durable-readback"],
  description:
    "User asks for a weekly per-app average and the assistant returns structured daily averages from the screen-time report.",

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
      kind: "action",
      name: "weekly-avg-query",
      room: "main",
      actionName: "OWNER_SCREENTIME",
      text: "Compute the seven-day average per app.",
      options: {
        parameters: { action: "weekly_average_by_app", days: 7 },
      },
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: "OWNER_SCREENTIME",
      status: "success",
    },
    {
      type: "custom",
      name: "weekly-average-per-app-structured-result",
      predicate: async (ctx) => {
        const action = ctx.actionsCalled.find(
          (entry) => entry.actionName === "OWNER_SCREENTIME",
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
        const editor = weeklyAverage.items?.find(
          (item) => item.identifier === "test.eliza.ScenarioEditor",
        );
        const browser = weeklyAverage.items?.find(
          (item) => item.identifier === "test.eliza.ScenarioBrowser",
        );
        if (!editor || !browser) {
          return "expected Scenario Editor and Scenario Browser weekly-average items";
        }
        if (editor.averageSecondsPerDay !== 3600) {
          return `expected Scenario Editor to average 3600 seconds/day, got ${editor.averageSecondsPerDay ?? "(missing)"}`;
        }
        if (browser.averageSecondsPerDay !== 1800) {
          return `expected Scenario Browser to average 1800 seconds/day, got ${browser.averageSecondsPerDay ?? "(missing)"}`;
        }
        return undefined;
      },
    },
  ],
});
