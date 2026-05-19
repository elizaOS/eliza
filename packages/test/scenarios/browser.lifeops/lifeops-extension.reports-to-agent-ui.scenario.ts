/**
 * The LifeOps browser extension must push activity telemetry to the
 * agent UI surface so the user can see a live panel of time-on-site,
 * current URL, etc. This scenario exercises the extension -> API -> UI
 * path by asking the agent what the extension is currently reporting.
 */

import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";
import { seedBrowserExtensionTelemetry } from "../_helpers/lifeops-seeds.ts";

export default scenario({
  id: "lifeops-extension.reports-to-agent-ui",
  title: "Extension pushes telemetry to agent UI",
  domain: "browser.lifeops",
  tags: ["browser", "activity", "extension"],
  description:
    "Tests the extension -> agent UI surface. User asks the agent to confirm the extension is connected and reporting, and the seeded telemetry must be reflected in the answer.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  seed: [
    {
      type: "custom",
      name: "seed-browser-telemetry",
      apply: seedBrowserExtensionTelemetry({
        deviceId: "browser-ui-primary",
        browserVendor: "chrome",
        windows: [
          {
            url: "https://github.com/elizaOS/eliza",
            offsetMinutes: 5,
            durationMinutes: 18,
          },
          {
            url: "https://docs.google.com/document/d/telemetry-brief",
            offsetMinutes: 30,
            durationMinutes: 9,
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
      title: "Browser extension: UI reporting",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "extension-status-query",
      room: "main",
      text: "Is the LifeOps browser extension connected right now, and what domains is it reporting into the agent UI?",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["SCREEN_TIME"],
        description: "browser extension telemetry snapshot",
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
      name: "browser-extension-telemetry-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["SCREEN_TIME"],
        description: "browser extension telemetry snapshot",
      }),
    },
    {
      type: "custom",
      name: "browser-extension-telemetry-result",
      predicate: async (ctx) => {
        const hit = ctx.actionsCalled.find(
          (action) => action.actionName === "SCREEN_TIME",
        );
        if (!hit) {
          return "expected FETCH_BROWSER_ACTIVITY action result";
        }
        const payload = JSON.stringify(hit.result?.data ?? {});
        if (!payload.includes("browser-ui-primary")) {
          return "expected seeded browser device id in extension activity payload";
        }
        // These are test-assertion substring checks on a JSON serialization, not URL sanitization.
        // lgtm[js/incomplete-url-sanitization]
        if (!payload.includes("github.com")) {
          return "expected github.com in extension activity payload";
        }
        if (!payload.includes("docs.google.com")) {
          return "expected docs.google.com in extension activity payload";
        }
        return undefined;
      },
    },
  ],
});
