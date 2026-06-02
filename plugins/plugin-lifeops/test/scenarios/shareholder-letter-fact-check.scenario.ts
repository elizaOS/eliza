import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "shareholder-letter-fact-check",
  title: "Assistant fact-checks a shareholder letter",
  domain: "executive.briefing",
  tags: ["lifeops", "executive-assistant", "briefing", "documents", "privacy"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Shareholder Letter Fact Check",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "fact-check-shareholder-letter",
      text: "Fact-check the shareholder letter draft against board minutes, finance packet, approved metrics, and legal disclosure notes. Flag unsupported claims.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "privacy", "deadline"],
      responseIncludesAny: ["board minutes", "metrics", "disclosure", "claims"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "stage-correction-brief",
      text: "Prepare a correction brief for the CEO and counsel, with exact claims to revise and the evidence source for each.",
      plannerIncludesAny: ["owner_send_message", "approval", "OWNER_DOCUMENTS"],
      responseIncludesAny: ["CEO", "counsel", "claims", "evidence"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
