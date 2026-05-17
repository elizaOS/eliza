import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";
import { seedBrowserExtensionTelemetry } from "../_helpers/lifeops-seeds.ts";

export default scenario({
  id: "activity.browser-extension-feeds-data",
  title: "Browser extension feeds per-site activity data",
  domain: "activity",
  tags: ["activity", "browser", "happy-path"],
  description:
    "Tests the browser extension -> runtime cache -> agent query path using seeded per-domain telemetry.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  seed: [
    {
      type: "custom",
      name: "seed-browser-extension-data",
      apply: seedBrowserExtensionTelemetry({
        deviceId: "browser-extension-feed",
        browserVendor: "chrome",
        windows: [
          {
            url: "https://github.com/elizaOS/eliza",
            offsetMinutes: 7,
            durationMinutes: 16,
          },
          {
            url: "https://docs.google.com/document/d/ops-brief",
            offsetMinutes: 29,
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
      title: "Activity: extension pipeline",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "extension-feed-check",
      room: "main",
      text: "What's the latest per-site data the LifeOps extension has sent you?",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["SCREEN_TIME"],
        description: "browser extension activity snapshot",
      }),
      responseIncludesAny: [/extension/i, /github/i, /docs\.google\.com/i],
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: "SCREEN_TIME",
    },
    {
      type: "custom",
      name: "extension-feed-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["SCREEN_TIME"],
        description: "browser extension activity snapshot",
      }),
    },
    {
      type: "custom",
      name: "extension-feed-result",
      predicate: async (ctx) => {
        const hit = ctx.actionsCalled.find(
          (action) => action.actionName === "SCREEN_TIME",
        );
        if (!hit) {
          return "expected FETCH_BROWSER_ACTIVITY action result";
        }
        const payload = JSON.stringify(hit.result?.data ?? {});
        if (!payload.includes("browser-extension-feed")) {
          return "expected seeded browser device id in activity payload";
        }
        // These are test-assertion substring checks on a JSON serialization, not URL sanitization.
        // lgtm[js/incomplete-url-sanitization]
        if (!payload.includes("github.com")) {
          return "expected github.com in activity payload";
        }
        if (!payload.includes("docs.google.com")) {
          return "expected docs.google.com in activity payload";
        }
        return undefined;
      },
    },
  ],
});
