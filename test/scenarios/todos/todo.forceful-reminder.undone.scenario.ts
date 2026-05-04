import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "todo.forceful-reminder.undone",
  title: "Undone overdue todo prompts forceful reminder on greeting",
  domain: "todos",
  tags: ["lifeops", "todos", "smoke", "retry-after-failure"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Todos Forceful Reminder Undone",
    },
  ],
  seed: [
    {
      type: "todo",
      name: "Take vitamins",
      dueIso: "{{now-1h}}",
      isUrgent: true,
    },
  ],
  turns: [
    {
      kind: "message",
      name: "greeting-prompts-reminder",
      text: "hey",
      responseIncludesAny: [
        "vitamins",
        "take vitamins",
        "overdue",
        "still need",
      ],
    },
  ],
  finalChecks: [
    {
      type: "memoryExists",
      content: {
        text: { $contains: "vitamins" },
      },
    },
  ],
});
