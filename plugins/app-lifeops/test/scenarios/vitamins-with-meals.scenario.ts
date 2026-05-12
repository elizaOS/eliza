import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "vitamins-with-meals",
  title: "Vitamins tied to a meal window",
  domain: "habits",
  tags: ["lifeops", "habits"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "discord",
      title: "LifeOps Vitamins With Meals",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "vitamins meal preview",
      text: "Please remind me to take vitamins with lunch every day.",
      responseIncludesAny: ["vitamins", "lunch", "afternoon"],
    },
    {
      kind: "message",
      name: "vitamins meal confirm",
      text: "Yes, save that vitamin routine.",
      responseIncludesAny: ["saved", "vitamin"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Take vitamins",
      delta: 1,
      cadenceKind: "daily",
      requiredWindows: ["afternoon"],
      requireReminderPlan: true,
    },
  ],
});
