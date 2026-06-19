import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "estate-liquidity-tax-call",
  title: "Assistant prepares an estate liquidity and tax advisor call",
  domain: "executive.money",
  tags: ["lifeops", "executive-assistant", "money", "legal", "documents"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Estate Liquidity Tax Call",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "prepare-advisor-brief",
      text: "Prepare for the estate liquidity call: gather trust docs, upcoming tax deadlines, cash needs, illiquid assets, advisor questions, and decisions that need my approval.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "OWNER_FINANCES", "approval"],
      responseIncludesAny: ["trust", "tax", "cash", "approval"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "schedule-and-redact-packet",
      text: "Schedule the advisor call, draft the agenda, and prepare a redacted packet that excludes account numbers unless I approve sharing them.",
      plannerIncludesAny: ["calendar_action", "privacy", "owner_send_message"],
      responseIncludesAny: ["agenda", "redacted", "account numbers", "approve"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
