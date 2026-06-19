import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "vendor-negotiation-approval",
  title: "Assistant drafts a vendor negotiation without bypassing approval",
  domain: "executive.vendor",
  tags: ["lifeops", "executive-assistant", "money", "messaging"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Vendor Negotiation Approval",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "prepare-vendor-counteroffer",
      text: "The analytics vendor renewal is too expensive. Draft a counteroffer using our last invoice and usage, but keep it in drafts.",
      plannerIncludesAny: ["OWNER_FINANCES", "owner_send_message", "invoice"],
      responseIncludesAny: ["draft", "counteroffer", "renewal", "approval"],
      plannerExcludes: ["send_to_agent", "list_agents"],
    },
    {
      kind: "message",
      name: "track-vendor-response",
      text: "Also create a follow-up for next Tuesday if they don't reply, and mark it as low-noise unless the price changes.",
      plannerIncludesAll: ["SCHEDULED_TASKS"],
      plannerIncludesAny: ["Tuesday", "follow", "price", "low-noise"],
      responseIncludesAny: ["follow", "Tuesday", "price"],
      plannerExcludes: ["calendar_action"],
    },
  ],
});
