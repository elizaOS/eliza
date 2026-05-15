import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "whatsapp-gateway.bot-routes-to-user-agent",
  title: "WhatsApp gateway bot routes to the active assistant",
  domain: "gateway",
  tags: ["gateway", "whatsapp", "smoke"],
  description:
    "A WhatsApp gateway DM resolves to the owning user agent and returns inbox-grounded context from the same WhatsApp chat.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "whatsapp",
      channelType: "DM",
      title: "WhatsApp Gateway Bot Routes To User Agent",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "whatsapp-inbound",
      room: "main",
      text: "What's in this WhatsApp gateway DM? Summarize it back to me.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["MESSAGE"],
        description: "WhatsApp gateway inbox read",
        includesAny: ["whatsapp", "chat", "message"],
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
      includesAny: ["whatsapp", "chat", "message", "room"],
    },
    {
      type: "custom",
      name: "whatsapp-gateway-inbox-context-is-real",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["MESSAGE"],
        description: "WhatsApp gateway inbox read",
        includesAny: ["whatsapp", "chat", "message"],
      }),
    },
    {
      type: "custom",
      name: "whatsapp-gateway-response-is-grounded",
      predicate: async (ctx) => {
        const reply = (ctx.turns?.[0]?.responseText ?? "").trim();
        if (!reply) {
          return "expected a non-empty WhatsApp response";
        }

        const hit = ctx.actionsCalled.find((action) =>
          ["MESSAGE", "MESSAGE"].includes(action.actionName),
        );
        if (!hit) {
          return "expected an INBOX action";
        }

        const blob = JSON.stringify(hit).toLowerCase();
        if (
          !blob.includes("whatsapp") ||
          (!blob.includes("chat") && !blob.includes("message"))
        ) {
          return "expected WhatsApp chat metadata in the inbox action payload";
        }
        return undefined;
      },
    },
  ],
});
