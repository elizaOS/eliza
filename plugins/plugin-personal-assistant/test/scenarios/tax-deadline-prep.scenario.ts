import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "tax-deadline-prep",
  title: "Assistant prepares tax deadline materials and missing-item follow-ups",
  domain: "executive.legal",
  tags: ["lifeops", "executive-assistant", "money", "legal"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Tax Deadline Prep",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "prepare-tax-packet",
      text: "My CPA needs everything for quarterly taxes by Thursday. Find missing 1099s, receipts, payments, and anything in email from the CPA.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "OWNER_FINANCES", "INBOX"],
      responseIncludesAny: ["CPA", "missing", "receipts", "Thursday"],
      plannerExcludes: ["calendar_action"],
    },
    {
      kind: "message",
      name: "chase-missing-tax-docs",
      text: "Draft follow-ups for any missing documents, but separate anything that includes account numbers for my approval.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["draft", "approval", "account"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
