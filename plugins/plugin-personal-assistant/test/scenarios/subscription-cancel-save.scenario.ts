import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "subscription-cancel-save",
  title: "Assistant identifies a renewal, drafts cancellation, and protects approval",
  domain: "executive.money",
  tags: ["lifeops", "executive-assistant", "money", "documents"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Subscription Cancel Save",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "audit-renewal",
      text: "Figure out whether we still need the design tool subscription before it renews next week. Pull usage, invoice, and cancellation terms.",
      plannerIncludesAny: ["OWNER_FINANCES", "OWNER_DOCUMENTS", "subscription"],
      responseIncludesAny: ["renew", "invoice", "cancellation"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "draft-cancel-or-downgrade",
      text: "If usage is low, draft a cancellation or downgrade request and schedule a decision reminder two days before renewal.",
      plannerIncludesAny: ["SCHEDULED_TASKS", "draft", "renewal"],
      responseIncludesAny: ["draft", "decision", "renewal"],
      plannerExcludes: ["send_to_agent", "list_agents"],
    },
  ],
});
