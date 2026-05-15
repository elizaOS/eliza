/**
 * Per-site time-tracking query via the LifeOps browser extension backed
 * by the activity collector. The user asks how much time they spent on
 * a specific site today; the agent should return a per-site breakdown
 * via GET_TIME_ON_SITE.
 */

import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";
import { seedBrowserExtensionTelemetry } from "../_helpers/lifeops-seeds.ts";

export default scenario({
  id: "lifeops-extension.time-tracking.per-site",
  title: "Per-site time tracking query (x.com today)",
  domain: "browser.lifeops",
  tags: ["browser", "activity", "smoke", "happy-path"],
  description:
    "User asks how much time they spent on x.com today. Seeded browser-extension telemetry should flow through GET_TIME_ON_SITE with a non-zero result.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  seed: [
    {
      type: "custom",
      name: "seed-x-domain-activity",
      apply: seedBrowserExtensionTelemetry({
        deviceId: "browser-activity-primary",
        browserVendor: "chrome",
        windows: [
          {
            url: "https://x.com/shawmakesmagic",
            offsetMinutes: 8,
            durationMinutes: 18,
          },
          {
            url: "https://github.com/elizaOS/eliza",
            offsetMinutes: 45,
            durationMinutes: 6,
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
      title: "Browser extension: per-site time",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "per-site-time-query",
      room: "main",
      text: "How much time did I spend on x.com today?",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["SCREEN_TIME"],
        description: "per-site time lookup for x.com",
      }),
      responseIncludesAny: [/x\.com/i, /minute|hour|m\./i, /time/i],
    },
  ],

  finalChecks: [
    {
      type: "selectedAction",
      actionName: "SCREEN_TIME",
    },
    {
      type: "custom",
      name: "per-site-time-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["SCREEN_TIME"],
        description: "per-site time lookup for x.com",
      }),
    },
    {
      type: "custom",
      name: "per-site-time-result",
      predicate: async (ctx) => {
        const hit = ctx.actionsCalled.find(
          (action) => action.actionName === "SCREEN_TIME",
        );
        if (!hit) {
          return "expected GET_TIME_ON_SITE action result";
        }
        const data = (hit.result?.data ?? {}) as {
          domain?: string;
          totalMs?: number;
        };
        if (data.domain !== "x.com") {
          return "expected x.com domain in GET_TIME_ON_SITE result";
        }
        if (typeof data.totalMs !== "number" || data.totalMs <= 0) {
          return "expected positive totalMs in GET_TIME_ON_SITE result";
        }
        return undefined;
      },
    },
  ],
});
