import { scenario } from "@elizaos/scenario-runner/schema";
import { browserPlugin } from "../../../../plugins/plugin-browser/src/plugin.ts";
import {
  __resetBrowserWorkspaceStateForTests,
  executeBrowserWorkspaceCommand,
} from "../../../../plugins/plugin-browser/src/workspace/browser-workspace.ts";
import { expectScenarioBrowserTask } from "../_helpers/browser-task-assertions.ts";

type RuntimeWithBrowserPlugin = {
  plugins?: Array<{ name?: string }>;
  registerPlugin?: (plugin: typeof browserPlugin) => Promise<void>;
};

const GOOGLE_PLAY_SUBSCRIPTIONS_URL =
  "https://play.google.com/store/account/subscriptions";

const googlePlayFixtureRoutes = [
  {
    url: GOOGLE_PLAY_SUBSCRIPTIONS_URL,
    title: "Google Play Subscriptions",
    body: [
      "<main>",
      "<h1>Google Play</h1>",
      "<h2>Subscriptions</h2>",
      `<form method="get" action="${GOOGLE_PLAY_SUBSCRIPTIONS_URL}">`,
      '<input type="hidden" name="confirm" value="1" />',
      '<button data-lifeops-action="cancel-subscription" type="submit">Cancel subscription</button>',
      "</form>",
      "</main>",
    ].join(""),
  },
  {
    url: `${GOOGLE_PLAY_SUBSCRIPTIONS_URL}?canceled=1`,
    title: "Google Play Cancellation Complete",
    body: [
      "<main>",
      "<h1>Google Play</h1>",
      "<p>subscription canceled</p>",
      "</main>",
    ].join(""),
  },
  {
    url: `${GOOGLE_PLAY_SUBSCRIPTIONS_URL}?confirm=1`,
    title: "Google Play Confirm Cancellation",
    body: [
      "<main>",
      "<h1>Google Play</h1>",
      "<p>Confirm cancellation</p>",
      `<form method="get" action="${GOOGLE_PLAY_SUBSCRIPTIONS_URL}">`,
      '<input type="hidden" name="canceled" value="1" />',
      '<button data-lifeops-action="confirm-cancellation" type="submit">Confirm cancellation</button>',
      "</form>",
      "</main>",
    ].join(""),
  },
] as const;

export default scenario({
  lane: "live-only",
  id: "subscriptions.cancel-google-play",
  title: "Cancel a Google Play subscription",
  domain: "browser.lifeops",
  tags: ["browser", "subscriptions", "happy-path"],
  description:
    "The agent should run the subscription cancellation flow through the browser executor, finish the flow, and return completion evidence.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-browser"],
  },
  seed: [
    {
      type: "custom",
      name: "seed-browser-workspace-google-play-subscription-flow",
      apply: async (ctx) => {
        delete process.env.ELIZA_BROWSER_WORKSPACE_URL;
        delete process.env.ELIZA_BROWSER_WORKSPACE_TOKEN;
        __resetBrowserWorkspaceStateForTests();

        const runtime = ctx.runtime as RuntimeWithBrowserPlugin | undefined;
        if (!runtime?.registerPlugin) {
          return "runtime.registerPlugin unavailable";
        }
        if (
          !runtime.plugins?.some(
            (plugin) =>
              plugin.name === "@elizaos/plugin-browser" ||
              plugin.name === "browser",
          )
        ) {
          await runtime.registerPlugin(browserPlugin);
        }

        const opened = await executeBrowserWorkspaceCommand({
          show: true,
          subaction: "open",
          title: "Google Play Fixture",
          url: "about:blank",
        });
        const tabId = opened.tab?.id;
        if (!tabId) {
          return "browser workspace did not create a Google Play fixture tab";
        }

        for (const route of googlePlayFixtureRoutes) {
          await executeBrowserWorkspaceCommand({
            id: tabId,
            networkAction: "route",
            responseBody: [
              "<!doctype html>",
              "<html>",
              `<head><title>${route.title}</title></head>`,
              `<body>${route.body}</body>`,
              "</html>",
            ].join(""),
            responseStatus: 200,
            subaction: "network",
            url: route.url,
          });
        }
        return undefined;
      },
    },
  ],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Cancel Google Play subscription",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "cancel-google-play",
      room: "main",
      text: "Cancel my Google Play subscription. I confirm the final cancellation step.",
      responseIncludesAny: ["Google Play", "completed", "cancellation"],
      assertTurn: (turn) => {
        const hit = turn.actionsCalled.find(
          (action) => action.actionName === "SUBSCRIPTIONS",
        );
        if (!hit) {
          return "expected SUBSCRIPTIONS to run";
        }
        return undefined;
      },
    },
  ],
  finalChecks: [
    { type: "selectedAction", actionName: "SUBSCRIPTIONS" },
    { type: "browserTaskCompleted", expected: true },
    { type: "uploadedAssetExists", expected: true },
    {
      type: "custom",
      name: "subscriptions-google-play-browser-task-shape",
      predicate: expectScenarioBrowserTask({
        description:
          "google play cancellation completes with at least one artifact captured for the browser flow",
        actionName: "SUBSCRIPTIONS",
        completed: true,
        needsHuman: false,
        minArtifacts: 1,
      }),
    },
  ],
});
