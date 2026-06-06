import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "family-office-quarterly-board-book",
  title: "Assistant assembles a family office quarterly board book",
  domain: "executive.briefing",
  tags: ["lifeops", "executive-assistant", "briefing", "documents", "money"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Family Office Board Book",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "collect-board-book-inputs",
      text: "Assemble the quarterly family office board book inputs: investment summary, tax calendar, philanthropic commitments, entity actions, open risks, and decisions needed.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "OWNER_FINANCES", "briefing"],
      responseIncludesAny: ["investment", "tax", "philanthropic", "risks"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "route-board-book-review",
      text: "Draft review requests for counsel, tax advisor, and investment lead. Keep beneficiary names redacted until I approve the packet.",
      plannerIncludesAny: ["owner_send_message", "privacy", "approval"],
      responseIncludesAny: ["counsel", "tax advisor", "redacted", "approve"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
