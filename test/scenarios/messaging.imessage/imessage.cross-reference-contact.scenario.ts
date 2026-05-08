import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "imessage.cross-reference-contact",
  title: "Unknown phone lookup must use Rolodex search or entity read",
  domain: "messaging.imessage",
  tags: ["messaging", "imessage", "routing"],
  description:
    "An unknown iMessage sender lookup must resolve through SEARCH_ENTITY or READ_ENTITY, not generic fallback tooling.",
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
      title: "iMessage Cross-Reference Contact",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "cross reference",
      room: "main",
      text: "Search the Rolodex for +14155551234 and tell me who it is.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["SEARCH_ENTITY", "READ_ENTITY"],
        description: "iMessage contact lookup",
        includesAny: ["14155551234", "+14155551234"],
      }),
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["SEARCH_ENTITY", "READ_ENTITY"],
    },
    {
      type: "selectedActionArguments",
      actionName: ["SEARCH_ENTITY", "READ_ENTITY"],
      includesAny: ["14155551234", "+14155551234"],
    },
    {
      type: "custom",
      name: "imessage-cross-ref-routing",
      predicate: async (ctx) => {
        const actionNames = new Set(
          ctx.actionsCalled.map((entry) => entry.actionName),
        );
        if (
          actionNames.has("SEARCH_ENTITY") ||
          actionNames.has("READ_ENTITY")
        ) {
          const fallbackActions = [
            "HEALTH",
            "VOICE_CALL",
            "MESSAGE",
            "RELATIONSHIP",
          ].filter((actionName) => actionNames.has(actionName));
          if (fallbackActions.length > 0) {
            return `unexpected fallback action(s) used alongside Rolodex lookup: ${fallbackActions.join(", ")}`;
          }
          return undefined;
        }
        return `expected a real Rolodex lookup via SEARCH_ENTITY or READ_ENTITY. Called: ${Array.from(actionNames).join(",") || "(none)"}`;
      },
    },
    {
      type: "custom",
      name: "imessage-cross-ref-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["SEARCH_ENTITY", "READ_ENTITY"],
        description: "iMessage contact lookup",
        includesAny: ["14155551234", "+14155551234"],
      }),
    },
  ],
});
