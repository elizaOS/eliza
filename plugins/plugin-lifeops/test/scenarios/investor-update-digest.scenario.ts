import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "investor-update-digest",
  title: "Assistant compresses investor update inputs into approval-ready draft",
  domain: "executive.briefing",
  tags: ["lifeops", "executive-assistant", "briefing", "documents"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Investor Update Digest",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "collect-investor-update",
      text: "Build the investor update draft from this week's board notes, shipped work, open risks, and finance deltas. Keep sensitive customer names out.",
      plannerIncludesAny: ["BRIEF", "OWNER_DOCUMENTS", "privacy"],
      responseIncludesAny: ["investor", "draft", "risk", "redact"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "approval-ready-digest",
      text: "Make it approval-ready: bullets, asks, metrics that need verification, and the exact places I need to review.",
      plannerIncludesAny: ["approval", "metrics", "BRIEF"],
      responseIncludesAny: ["approval", "metrics", "review"],
      plannerExcludes: ["send_to_agent", "list_agents"],
    },
  ],
});
