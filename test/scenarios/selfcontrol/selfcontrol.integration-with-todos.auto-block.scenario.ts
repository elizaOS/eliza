import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "selfcontrol.integration-with-todos.auto-block",
  title: "Todo-gated social block asks for specific sites",
  domain: "selfcontrol",
  tags: ["lifeops", "selfcontrol", "clarification", "todo-gated"],
  description:
    "A todo-gated auto-block request without explicit websites should ask which social sites to include before the rule is created.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "SelfControl Auto-Block From Todos",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "set-rule",
      room: "main",
      text: "Auto-block socials if my workout isn't done by noon.",
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "REPLY",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "WEBSITE_BLOCK",
      minCount: 1,
    },
  ],
});
