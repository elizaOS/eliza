import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "concierge-vip-itinerary-recovery",
  title: "Assistant recovers a VIP itinerary after a concierge vendor miss",
  domain: "executive.vendor",
  tags: ["lifeops", "executive-assistant", "vendor", "travel", "escalation"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps VIP Itinerary Recovery",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-concierge-failure",
      text: "The concierge vendor missed the dinner reservation and airport greeter. Find alternatives, preserve receipts, identify escalation contacts, and protect the guest list.",
      plannerIncludesAny: ["travel", "vendor", "privacy"],
      responseIncludesAny: ["reservation", "greeter", "receipts", "guest list"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "draft-recovery-briefs",
      text: "Draft a recovery brief for me, a neutral apology to the VIP, and a vendor escalation note. Do not send until I approve.",
      plannerIncludesAny: ["owner_send_message", "approval", "escalation"],
      responseIncludesAny: ["recovery", "VIP", "vendor", "approve"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
