import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "gmail-direct-message-sender-routing",
  title: "Narrative Gmail sender routing",
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
      title: "LifeOps Gmail Direct Message Sender Routing",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "gmail narrative sender routing",
      text: "can you search my email and tell me if anyone named pat emailed me",
      plannerIncludesAll: ["gmail_action", "pat"],
      plannerExcludes: [
        "create_task",
        "spawn_agent",
        "send_to_agent",
        "list_agents",
      ],
      responseExcludes: ["no active task agents", "spawned", "scratch/"],
    },
  ],
});
