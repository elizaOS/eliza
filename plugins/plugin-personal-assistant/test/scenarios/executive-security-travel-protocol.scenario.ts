import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "executive-security-travel-protocol",
  title: "Assistant coordinates sensitive travel with security and calendar constraints",
  domain: "executive.travel",
  tags: ["lifeops", "executive-assistant", "travel", "privacy"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Executive Security Travel Protocol",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "prepare-security-travel-plan",
      text: "For the private trip next week, reconcile flight windows, driver handoff, hotel alias, meeting calendar, and security contact details. Do not put the hotel alias in any broad calendar invite.",
      plannerIncludesAny: ["travel", "calendar_action", "privacy"],
      responseIncludesAny: ["flight", "driver", "hotel", "security"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "draft-need-to-know-notices",
      text: "Draft need-to-know messages for the driver, the assistant, and the host. Each should reveal only the details that person needs.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["driver", "assistant", "host", "draft"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
