import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "private-chef-dietary-firebreak",
  title: "Assistant coordinates private chef dietary constraints with privacy firebreaks",
  domain: "executive.household",
  tags: ["lifeops", "executive-assistant", "household", "privacy", "vendor"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Private Chef Dietary Firebreak",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "collect-dinner-constraints",
      text: "Coordinate Saturday dinner with the private chef: allergies, religious restrictions, guest arrival times, kitchen access, invoice cap, and backup restaurant.",
      plannerIncludesAny: ["calendar_action", "vendor", "OWNER_FINANCES"],
      responseIncludesAny: ["allergies", "guest", "invoice", "backup"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "draft-privacy-scoped-chef-brief",
      text: "Draft the chef brief with only dietary constraints, not medical explanations, and ask me before confirming the invoice cap.",
      plannerIncludesAny: ["owner_send_message", "privacy", "approval"],
      responseIncludesAny: ["dietary", "medical", "invoice", "confirm"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
