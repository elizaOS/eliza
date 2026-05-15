import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "calendar-vague-followup",
  title: "Calendar vague follow-up routing",
  domain: "calendar",
  tags: ["lifeops", "calendar"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "discord",
      title: "LifeOps Calendar Vague Follow-up",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "calendar flights this week",
      text: "do i have any flights this week?",
      plannerIncludesAll: ["calendar_action"],
      plannerExcludes: [
        "create_task",
        "spawn_agent",
        "send_to_agent",
        "list_agents",
      ],
      responseExcludes: ["no active task agents", "spawned", "scratch/"],
    },
    {
      kind: "message",
      name: "calendar return flight",
      text: "when do i fly back from denver",
      plannerIncludesAll: ["calendar_action"],
      plannerExcludes: [
        "create_task",
        "spawn_agent",
        "send_to_agent",
        "list_agents",
      ],
      responseExcludes: ["no active task agents", "spawned", "scratch/"],
    },
    {
      kind: "message",
      name: "calendar vague follow-up",
      text: "yeah, probably next week?",
      plannerIncludesAll: ["calendar_action"],
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
