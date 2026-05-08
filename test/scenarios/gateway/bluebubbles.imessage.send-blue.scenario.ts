import { scenario } from "@elizaos/scenario-schema";
import {
  expectMemoryWrite,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "bluebubbles.imessage.send-blue",
  title: "Agent confirms then sends a BlueBubbles iMessage",
  domain: "gateway",
  tags: ["gateway", "imessage", "bluebubbles", "smoke"],
  description:
    "The first turn must ask for confirmation. After the explicit yes, MESSAGE should route through BlueBubbles and persist the outbound message.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
    os: "macos",
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "BlueBubbles iMessage Send Blue",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "propose-imessage",
      room: "main",
      text: "iMessage Sarah that I'll be there in 10 minutes.",
      responseIncludesAny: ["iMessage", "Sarah", "confirm", "10"],
      forbiddenActions: ["MESSAGE"],
    },
    {
      kind: "message",
      name: "confirm-imessage",
      room: "main",
      text: "Yes, send it.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["MESSAGE"],
        description: "BlueBubbles send after confirmation",
      }),
      responseIncludesAny: ["sent", "delivered", "iMessage"],
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: "MESSAGE",
    },
    {
      type: "actionCalled",
      actionName: "MESSAGE",
      status: "success",
    },
    {
      type: "custom",
      name: "bluebubbles-send-writes-outbound-memory",
      predicate: async (ctx) => {
        const outboundWrite = (ctx.memoryWrites ?? []).find((write) => {
          if (write.table !== "messages") {
            return false;
          }
          const blob = JSON.stringify(write.content ?? {});
          return (
            blob.includes('"source":"bluebubbles"') &&
            /10 minutes|there in 10/i.test(blob)
          );
        });

        if (!outboundWrite) {
          return "expected the BlueBubbles send action to persist an outbound message memory containing the confirmed 10 minute reply";
        }

        return undefined;
      },
    },
    {
      type: "custom",
      name: "bluebubbles-send-confirmation-gate",
      predicate: async (ctx) => {
        const firstTurnActions = ctx.turns?.[0]?.actionsCalled ?? [];
        const secondTurnActions = ctx.turns?.[1]?.actionsCalled ?? [];

        if (
          firstTurnActions.some((action) => action.actionName === "MESSAGE")
        ) {
          return "first turn sent a message before confirmation";
        }

        if (
          !secondTurnActions.some((action) => action.actionName === "MESSAGE")
        ) {
          return "second turn did not call MESSAGE";
        }

        return undefined;
      },
    },
    {
      type: "custom",
      name: "bluebubbles-send-memory-coverage",
      predicate: expectMemoryWrite({
        description: "BlueBubbles outbound message memory",
        table: "messages",
        contentIncludesAny: [/bluebubbles/i, /10 minutes|there in 10/i],
      }),
    },
  ],
});
