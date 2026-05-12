import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "telegram-gateway.bot-routes-to-user-agent",
  title: "Telegram gateway bot routes to the active assistant",
  domain: "gateway",
  tags: ["gateway", "telegram", "smoke"],
  description:
    "A Telegram gateway DM resolves to the owning user agent and returns inbox-grounded context from the same Telegram chat.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      channelType: "DM",
      title: "Telegram Gateway Bot Routes To User Agent",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "telegram-inbound",
      room: "main",
      text: "What's in this Telegram gateway DM? Summarize it back to me.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["MESSAGE"],
        description: "Telegram gateway inbox read",
        includesAny: ["telegram", "chat", "message"],
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
      includesAny: ["telegram", "chat", "message", "room"],
    },
    {
      type: "custom",
      name: "telegram-gateway-inbox-context-is-real",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["MESSAGE"],
        description: "Telegram gateway inbox read",
        includesAny: ["telegram", "chat", "message"],
      }),
    },
    {
      type: "custom",
      name: "telegram-gateway-response-is-grounded",
      predicate: async (ctx) => {
        const reply = (ctx.turns?.[0]?.responseText ?? "").trim();
        if (!reply) {
          return "expected a non-empty Telegram gateway response";
        }

        const hit = ctx.actionsCalled.find((action) =>
          ["MESSAGE", "MESSAGE"].includes(action.actionName),
        );
        if (!hit) {
          return "expected an INBOX action";
        }

        const blob = JSON.stringify(hit).toLowerCase();
        if (
          !blob.includes("telegram") ||
          (!blob.includes("chat") && !blob.includes("message"))
        ) {
          return "expected Telegram chat metadata in the inbox action payload";
        }
        return undefined;
      },
    },
  ],
});
