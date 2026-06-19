import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "vendor-failure-home-recovery",
  title: "Assistant recovers from a failed household vendor visit",
  domain: "executive.vendor",
  tags: ["lifeops", "executive-assistant", "household", "vendor"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Vendor Failure Home Recovery",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "recover-failed-vendor",
      text: "The water heater contractor missed the appointment and guests arrive Friday. Find the fastest recovery plan: alternate vendors, refund language, access window, and which work meetings I may need to move.",
      plannerIncludesAny: ["PERSONAL_ASSISTANT", "calendar_action", "vendor"],
      responseIncludesAny: ["vendor", "refund", "Friday", "meeting"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "hold-vendor-messages",
      text: "Draft the firm vendor message and a softer message to the house manager. Hold both until I approve the tone.",
      plannerIncludesAny: ["owner_send_message", "approval", "relationship"],
      responseIncludesAny: ["draft", "vendor", "house manager", "approval"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
