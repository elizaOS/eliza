import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "gmail-retry-followup",
  title: "Gmail retry and refinement follow-up",
  domain: "gmail",
  tags: ["lifeops", "gmail"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "discord",
      title: "LifeOps Gmail Retry Follow-up",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "gmail initial search",
      text: "find emails from suran",
      plannerIncludesAll: ["gmail_action", "suran"],
      plannerExcludes: [
        "create_task",
        "spawn_agent",
        "send_to_agent",
        "list_agents",
      ],
    },
    {
      kind: "message",
      name: "gmail retry follow-up",
      text: "can you try the suran search again?",
      responseExcludes: ["no active task agents", "spawned", "scratch/"],
    },
    {
      kind: "message",
      name: "gmail unread refinement",
      text: "what about unread ones?",
      plannerIncludesAll: ["gmail_action", "suran"],
      plannerIncludesAny: [
        "unread",
        "replyneededonly",
        "needs_response",
        "reply needed",
      ],
      plannerExcludes: [
        "create_task",
        "spawn_agent",
        "send_to_agent",
        "list_agents",
      ],
    },
  ],
});
