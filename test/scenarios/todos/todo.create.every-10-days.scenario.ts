import { scenario } from "@elizaos/scenario-schema";

// 10 days * 24 hours * 60 minutes = 14,400 minutes
const EVERY_10_DAYS_MINUTES = 14_400;

export default scenario({
  id: "todo.create.every-10-days",
  title: "Create an every-10-days Invisalign tray swap todo",
  domain: "todos",
  tags: ["lifeops", "todos", "ambiguous-parameter"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Todos Invisalign Every 10 Days",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "invisalign-10d preview",
      text: "Every 10 days, remind me to swap my Invisalign tray.",
      responseIncludesAny: ["invisalign", "10 days", "every 10"],
    },
    {
      kind: "message",
      name: "invisalign-10d confirm",
      text: "Yes, save that every 10 days Invisalign swap.",
      expectedActions: ["LIFE"],
      responseIncludesAny: ["saved", "invisalign"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Swap Invisalign tray",
      titleAliases: [
        "Swap invisalign tray",
        "Invisalign tray swap",
        "Change Invisalign tray",
      ],
      delta: 1,
      requiredEveryMinutes: EVERY_10_DAYS_MINUTES,
    },
  ],
});
