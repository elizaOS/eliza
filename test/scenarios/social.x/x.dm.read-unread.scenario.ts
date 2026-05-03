import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";
import { seedXReadFixtures } from "../_helpers/x-seeds.ts";

export default scenario({
  id: "x.dm.read-unread",
  title: "Read unread Twitter/X DMs",
  domain: "social.x",
  tags: ["social", "twitter", "dm", "happy-path"],
  description:
    "User asks for unread X DMs and receives an inline summary from seeded X DM data.",

  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  seed: [
    {
      type: "custom",
      name: "seed-x-dms",
      apply: seedXReadFixtures({
        dms: [
          {
            externalDmId: "x-dm-1",
            senderHandle: "jane_doe",
            text: "Can you hop on a quick call tomorrow morning?",
            offsetMinutes: 9,
          },
          {
            externalDmId: "x-dm-2",
            senderHandle: "eliza_art",
            text: "Sent over the concept sketch. Want feedback today?",
            offsetMinutes: 21,
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
      title: "Twitter: DM read",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "unread-dm-query",
      room: "main",
      text: "Check my X DMs and tell me what's unread.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["X_READ"],
        description: "X DM read",
        includesAny: ["read_dms"],
      }),
      responseIncludesAny: [
        /x dms|dm/i,
        /jane_doe|eliza_art/i,
        /call|sketch|feedback/i,
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
      name: "x-dm-read-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["X_READ"],
        description: "X DM read",
        includesAny: ["read_dms"],
      }),
    },
    {
      type: "custom",
      name: "x-dm-read-results",
      predicate: async (ctx) => {
        const hit = ctx.actionsCalled.find(
          (action) => action.actionName === "X_READ",
        );
        const data = (hit?.result?.data ?? {}) as {
          subaction?: string;
          items?: Array<{ senderHandle?: string; text?: string }>;
        };
        if (data.subaction !== "read_dms") {
          return "expected X_READ DM subaction";
        }
        if (!Array.isArray(data.items) || data.items.length < 2) {
          return "expected seeded X DM items";
        }
        return undefined;
      },
    },
  ],
});
