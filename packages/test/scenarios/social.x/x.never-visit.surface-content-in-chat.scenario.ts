import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";
import { seedXReadFixtures } from "../_helpers/x-seeds.ts";

export default scenario({
  id: "x.never-visit.surface-content-in-chat",
  title: "Agent surfaces X content in chat without redirecting user",
  domain: "social.x",
  tags: ["social", "twitter", "happy-path"],
  description:
    "User should not be redirected to X; the assistant should surface seeded X content directly in chat.",

  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  seed: [
    {
      type: "custom",
      name: "seed-openai-launch-search-results",
      apply: seedXReadFixtures({
        feedItems: [
          {
            externalTweetId: "x-openai-1",
            feedType: "search",
            authorHandle: "launch_watch",
            text: "People are saying the latest OpenAI launch made coding agents much more reliable.",
            offsetMinutes: 11,
          },
          {
            externalTweetId: "x-openai-2",
            feedType: "search",
            authorHandle: "shipfast",
            text: "The launch thread is mostly about agent speed, evals, and better tool use.",
            offsetMinutes: 19,
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
      title: "Twitter: never-visit",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "no-redirect-request",
      room: "main",
      text: "Search X for posts about the latest OpenAI launch and tell me the highlights here, not a link.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["X_READ"],
        description: "inline X search summary",
        includesAny: ["search", "OpenAI"],
      }),
      responseExcludes: [/go to x\.com/i, /open twitter/i, /visit x\.com/i],
      responseIncludesAny: [
        /openai/i,
        /people are saying|thread|launch/i,
        /@/i,
      ],
    },
  ],

  finalChecks: [
    {
      type: "selectedAction",
      actionName: "X_READ",
    },
    {
      type: "custom",
      name: "never-visit-x-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["X_READ"],
        description: "inline X search summary",
        includesAny: ["search", "OpenAI"],
      }),
    },
    {
      type: "custom",
      name: "never-visit-x-no-linkout",
      predicate: async (ctx) => {
        const responseText = ctx.turns?.[0]?.responseText ?? "";
        if (/x\.com|twitter\.com/i.test(responseText)) {
          return "expected in-chat content instead of an X/Twitter URL";
        }
        return undefined;
      },
    },
  ],
});
