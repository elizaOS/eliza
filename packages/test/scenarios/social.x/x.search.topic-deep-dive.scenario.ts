import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";
import { seedXReadFixtures } from "../_helpers/x-seeds.ts";

export default scenario({
  id: "x.search.topic-deep-dive",
  title: "Topic deep-dive search on X",
  domain: "social.x",
  tags: ["social", "twitter", "happy-path"],
  description:
    "User asks for recent posts about elizaOS on X and receives an in-chat summary backed by seeded X search data.",

  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  seed: [
    {
      type: "custom",
      name: "seed-x-search-results",
      apply: seedXReadFixtures({
        feedItems: [
          {
            externalTweetId: "x-search-elizaos-1",
            feedType: "search",
            authorHandle: "eliza_builder",
            text: "elizaOS just shipped a cleaner plugin runtime and the dev loop is much faster now.",
            offsetMinutes: 12,
          },
          {
            externalTweetId: "x-search-elizaos-2",
            feedType: "search",
            authorHandle: "agent_ops",
            text: "People are using elizaOS to wire X DMs, Discord, and Telegram into one assistant.",
            offsetMinutes: 25,
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
      title: "Twitter: topic search",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "topic-search-request",
      room: "main",
      text: "Search Twitter for posts about elizaOS and summarize what people are saying.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["X_READ"],
        description: "X search for elizaOS",
        includesAny: ["search", "elizaOS"],
      }),
      responseIncludesAny: [/elizaos|eliza/i, /@/i, /x search/i],
    },
  ],

  finalChecks: [
    {
      type: "selectedAction",
      actionName: "X_READ",
    },
    {
      type: "custom",
      name: "x-search-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["X_READ"],
        description: "X search for elizaOS",
        includesAny: ["search", "elizaOS"],
      }),
    },
    {
      type: "custom",
      name: "x-search-result-items",
      predicate: async (ctx) => {
        const hit = ctx.actionsCalled.find(
          (action) => action.actionName === "X_READ",
        );
        const data = (hit?.result?.data ?? {}) as {
          subaction?: string;
          query?: string;
          items?: Array<{ text?: string }>;
        };
        if (data.subaction !== "search") {
          return "expected X_READ search subaction";
        }
        if (data.query?.toLowerCase() !== "elizaos") {
          return "expected elizaOS query in X search result";
        }
        if (!Array.isArray(data.items) || data.items.length < 2) {
          return "expected seeded X search items";
        }
        return undefined;
      },
    },
  ],
});
