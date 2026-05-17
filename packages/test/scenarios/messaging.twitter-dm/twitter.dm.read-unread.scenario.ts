import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";
import { seedXReadFixtures } from "../_helpers/x-seeds.ts";

export default scenario({
  id: "twitter.dm.read-unread",
  title: "Read unread Twitter DMs",
  domain: "messaging.twitter-dm",
  tags: ["messaging", "twitter", "happy-path", "smoke"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  seed: [
    {
      type: "custom",
      name: "seed-twitter-dm-read",
      apply: seedXReadFixtures({
        dms: [
          {
            externalDmId: "twitter-dm-1",
            senderHandle: "alice",
            text: "Hey, are you around later today?",
            offsetMinutes: 7,
          },
          {
            externalDmId: "twitter-dm-2",
            senderHandle: "bob",
            text: "Thanks again for the intro.",
            offsetMinutes: 16,
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
      title: "Twitter DM Read",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "read twitter dms",
      room: "main",
      text: "Check my Twitter DMs and tell me what's unread.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["X_READ"],
        description: "Twitter DM inbox read",
        includesAny: ["read_dms"],
      }),
      responseIncludesAny: [/twitter|x/i, /dm/i, /alice|bob/i],
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: "X_READ",
    },
    {
      type: "custom",
      name: "twitter-dm-read-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["X_READ"],
        description: "Twitter DM inbox read",
        includesAny: ["read_dms"],
      }),
    },
    {
      type: "custom",
      name: "twitter-dm-read-items",
      predicate: async (ctx) => {
        const hit = ctx.actionsCalled.find(
          (action) => action.actionName === "X_READ",
        );
        const data = (hit?.result?.data ?? {}) as {
          subaction?: string;
          items?: Array<{ senderHandle?: string }>;
        };
        if (data.subaction !== "read_dms") {
          return "expected X_READ DM subaction";
        }
        if (!Array.isArray(data.items) || data.items.length < 2) {
          return "expected two seeded Twitter DMs";
        }
        return undefined;
      },
    },
  ],
});
