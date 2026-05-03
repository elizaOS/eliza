import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";
import { seedXReadFixtures } from "../_helpers/x-seeds.ts";

export default scenario({
  id: "x.feed-summary.top-interesting",
  title: "Summarize top 5 tweets in feed today",
  domain: "social.x",
  tags: ["social", "twitter", "smoke", "happy-path"],
  description:
    "User asks for a summary of the top posts in their X feed today and gets an inline summary from seeded timeline data.",

  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  seed: [
    {
      type: "custom",
      name: "seed-x-home-feed",
      apply: seedXReadFixtures({
        feedItems: [
          {
            externalTweetId: "x-home-1",
            feedType: "home_timeline",
            authorHandle: "builder_one",
            text: "Shipped a cleaner workflow for connector certifications today.",
            offsetMinutes: 18,
          },
          {
            externalTweetId: "x-home-2",
            feedType: "home_timeline",
            authorHandle: "eliza_ai",
            text: "Eliza dev loop feels dramatically better after trimming dead paths.",
            offsetMinutes: 22,
          },
          {
            externalTweetId: "x-home-3",
            feedType: "home_timeline",
            authorHandle: "agenticdev",
            text: "A good assistant summarizes the feed instead of punting you back to the site.",
            offsetMinutes: 31,
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
      title: "Twitter: feed summary",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "feed-summary-request",
      room: "main",
      text: "What's on my X timeline today? Summarize the top 5 posts for me.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["X_READ"],
        description: "X home timeline read",
        includesAny: ["read_feed", "home_timeline"],
      }),
      responseIncludesAny: [/feed/i, /@/i, /x home_timeline/i],
    },
  ],

  finalChecks: [
    {
      type: "selectedAction",
      actionName: "X_READ",
    },
    {
      type: "custom",
      name: "x-feed-summary-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["X_READ"],
        description: "X home timeline read",
        includesAny: ["read_feed", "home_timeline"],
      }),
    },
    {
      type: "custom",
      name: "x-feed-summary-results",
      predicate: async (ctx) => {
        const hit = ctx.actionsCalled.find(
          (action) => action.actionName === "X_READ",
        );
        const data = (hit?.result?.data ?? {}) as {
          subaction?: string;
          feedType?: string;
          items?: Array<{ text?: string }>;
        };
        if (data.subaction !== "read_feed") {
          return "expected X_READ feed subaction";
        }
        if (data.feedType !== "home_timeline") {
          return "expected home_timeline feed type";
        }
        if (!Array.isArray(data.items) || data.items.length < 3) {
          return "expected seeded home timeline items";
        }
        return undefined;
      },
    },
  ],
});
