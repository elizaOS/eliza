import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "family-trust-beneficiary-briefing",
  title: "Assistant prepares a family trust beneficiary briefing",
  domain: "executive.family",
  tags: ["lifeops", "executive-assistant", "family", "legal", "documents"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Family Trust Beneficiary Briefing",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "map-trust-briefing",
      text: "Prepare for the beneficiary briefing: trust agreement, distribution schedule, open questions for counsel, family sensitivities, and who should attend.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "calendar_action", "privacy"],
      responseIncludesAny: ["trust", "distribution", "counsel", "attend"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "draft-beneficiary-update",
      text: "Draft a neutral update for beneficiaries and a separate private note for me on conflict risks. Hold both for my review.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["beneficiaries", "private note", "conflict", "review"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
