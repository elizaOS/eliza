import { scenario } from "@elizaos/scenario-schema";
import { expectTurnToCallAction } from "../_helpers/action-assertions.ts";
import { expectScenarioActionResultData } from "../_helpers/action-result-assertions.ts";

export default scenario({
  id: "x.post.with-confirmation",
  title: "Draft an X post inline in chat",
  domain: "social.x",
  tags: ["social", "twitter", "post", "draft"],
  description:
    "User asks for a short X post draft and gets the copy inline in chat.",

  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Twitter: post draft",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "draft-post",
      room: "main",
      text: "Draft a short X post saying Eliza shipped today.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["REPLY"],
        description: "X post draft reply",
        includesAny: ["eliza", "shipped"],
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
      name: "x-post-draft-result",
      predicate: expectScenarioActionResultData({
        description: "X post draft reply payload",
        actionName: "REPLY",
        includesAny: ["eliza", "shipped"],
      }),
    },
  ],
});
