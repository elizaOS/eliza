import { scenario } from "@elizaos/scenario-schema";
import { expectTurnToCallAction } from "../_helpers/action-assertions.ts";
import { expectScenarioActionResultData } from "../_helpers/action-result-assertions.ts";

export default scenario({
  id: "x.dm.group-chat-gateway",
  title: "Advise on an X group DM handoff",
  domain: "social.x",
  tags: ["social", "twitter", "gateway", "advice"],
  description:
    "User asks whether an X group DM handoff would help, and the assistant answers inline in chat.",

  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Twitter: group DM handoff",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "group-handoff-advice",
      room: "main",
      text: "If coordinating on X gets messy, would an X group DM handoff help?",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["REPLY"],
        description: "X group DM handoff advice",
        includesAny: ["group", "dm", "x"],
      }),
    },
  ],

  finalChecks: [
    {
      type: "selectedAction",
      actionName: "REPLY",
    },
    {
      type: "custom",
      name: "x-group-dm-handoff-result",
      predicate: expectScenarioActionResultData({
        description: "X group DM handoff advice payload",
        actionName: "REPLY",
        includesAny: ["group", "dm", "x"],
      }),
    },
  ],
});
