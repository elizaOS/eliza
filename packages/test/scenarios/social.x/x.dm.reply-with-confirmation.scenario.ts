import { scenario } from "@elizaos/scenario-schema";
import { expectTurnToCallAction } from "../_helpers/action-assertions.ts";
import { expectScenarioActionResultData } from "../_helpers/action-result-assertions.ts";

export default scenario({
  id: "x.dm.reply-with-confirmation",
  title: "Draft an X DM reply inline in chat",
  domain: "social.x",
  tags: ["social", "twitter", "dm", "draft"],
  description:
    "User asks for an X DM reply draft and gets the copy inline in chat.",

  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Twitter: DM reply draft",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "draft-reply",
      room: "main",
      text: "Draft an X DM reply to Jane that says I'll call her tomorrow and asks what time works best.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["REPLY"],
        description: "X DM reply draft",
        includesAny: ["jane", "call", "tomorrow", "time"],
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
      name: "x-dm-reply-draft-result",
      predicate: expectScenarioActionResultData({
        description: "X DM reply draft payload",
        actionName: "REPLY",
        includesAny: ["jane", "call", "tomorrow", "time"],
      }),
    },
  ],
});
