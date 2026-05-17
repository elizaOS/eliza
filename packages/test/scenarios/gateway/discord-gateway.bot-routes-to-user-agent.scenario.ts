import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "discord-gateway.bot-routes-to-user-agent",
  title: "Discord gateway bot routes to the active assistant",
  domain: "gateway",
  tags: ["gateway", "discord", "smoke"],
  description:
    "A Discord gateway DM resolves to the owning user agent and returns inbox-grounded context from the same Discord room.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "discord",
      channelType: "DM",
      title: "Discord Gateway Bot Routes To User Agent",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "discord-inbound",
      room: "main",
      text: "What's in this Discord gateway DM? Summarize it back to me.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["MESSAGE"],
        description: "Discord gateway inbox read",
        includesAny: ["discord", "dm", "message"],
      }),
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["MESSAGE", "MESSAGE"],
    },
    {
      type: "selectedActionArguments",
      actionName: ["MESSAGE", "MESSAGE"],
      includesAny: ["discord", "dm", "message", "channel", "guild"],
    },
    {
      type: "custom",
      name: "discord-gateway-inbox-context-is-real",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["MESSAGE"],
        description: "Discord gateway inbox read",
        includesAny: ["discord", "dm", "message"],
      }),
    },
    {
      type: "custom",
      name: "discord-gateway-response-is-grounded",
      predicate: async (ctx) => {
        const reply = (ctx.turns?.[0]?.responseText ?? "").trim();
        if (!reply) {
          return "expected a non-empty Discord gateway response";
        }

        const hit = ctx.actionsCalled.find((action) =>
          ["MESSAGE", "MESSAGE"].includes(action.actionName),
        );
        if (!hit) {
          return "expected an INBOX action";
        }

        const blob = JSON.stringify(hit).toLowerCase();
        if (
          !blob.includes("discord") ||
          (!blob.includes("dm") && !blob.includes("channel"))
        ) {
          return "expected Discord room metadata in the inbox action payload";
        }
        return undefined;
      },
    },
    {
      type: "custom",
      name: "discord-gateway-room-ownership-is-real",
      predicate: async (ctx) => {
        const hit = ctx.actionsCalled.find((action) =>
          ["MESSAGE", "MESSAGE"].includes(action.actionName),
        );
        if (!hit) {
          return "expected an INBOX action";
        }

        const blob = JSON.stringify(hit).toLowerCase();
        if (!blob.includes("roomid")) {
          return "expected the Discord inbox payload to include roomId";
        }
        if (!blob.includes("discord-dm:") && !blob.includes("discord-guild:")) {
          return "expected a namespaced Discord roomId";
        }
        if (!blob.includes("channelid")) {
          return "expected Discord channel metadata in the inbox payload";
        }
        return undefined;
      },
    },
  ],
});
