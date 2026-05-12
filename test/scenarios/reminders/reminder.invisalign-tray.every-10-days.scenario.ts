import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "reminder.invisalign-tray.every-10-days",
  title: "Invisalign tray swap every 10 days",
  domain: "reminders",
  tags: ["lifeops", "reminders", "smoke", "critical", "happy-path"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "Reminders Invisalign Tray Every 10 Days",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "invisalign tray preview",
      text: "Remind me to swap Invisalign trays every 10 days.",
      responseIncludesAny: ["invisalign", "tray", "10"],
    },
    {
      kind: "message",
      name: "invisalign tray confirm",
      text: "Yes, save that recurring reminder.",
      responseIncludesAny: ["saved", "invisalign", "tray"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Swap Invisalign tray",
      titleAliases: [
        "Switch Invisalign tray",
        "Change Invisalign tray",
        "New Invisalign tray",
      ],
      delta: 1,
      requireReminderPlan: true,
    },
  ],
});
