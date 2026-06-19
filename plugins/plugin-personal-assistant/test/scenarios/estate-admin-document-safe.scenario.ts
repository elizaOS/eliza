import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "estate-admin-document-safe",
  title: "Assistant organizes estate admin documents with sensitive-data controls",
  domain: "executive.legal",
  tags: ["lifeops", "executive-assistant", "legal", "documents", "privacy"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Estate Admin Document Safe",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "organize-estate-docs",
      text: "Organize the estate admin docs: will, trust, beneficiary forms, and account inventory. Flag missing signatures and do not expose account numbers.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "privacy", "signature"],
      responseIncludesAny: ["estate", "signature", "account"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "prepare-counsel-question-list",
      text: "Draft a question list for counsel and create tasks for anything that needs notarization or witness scheduling.",
      plannerIncludesAny: ["SCHEDULED_TASKS", "owner_send_message", "notarization"],
      responseIncludesAny: ["counsel", "notarization", "witness"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
