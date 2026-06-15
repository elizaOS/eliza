import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "probate-beneficiary-document-chase",
  title: "Assistant coordinates probate documents and beneficiary follow-ups",
  domain: "executive.legal",
  tags: ["lifeops", "executive-assistant", "documents", "family"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Probate Beneficiary Chase",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "build-probate-chase-list",
      text: "Build a probate chase list for the estate attorney: missing beneficiary W-9s, signed waivers, death certificate copies, and one sensitive family note that should not go in the shared packet.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "PERSONAL_ASSISTANT", "privacy"],
      responseIncludesAny: ["beneficiary", "attorney", "document", "private"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "stage-family-followups",
      text: "Draft separate follow-ups for the two beneficiaries who are late, but make the cousin message warmer and hold both drafts for my approval.",
      plannerIncludesAny: ["owner_send_message", "approval", "relationship"],
      responseIncludesAny: ["draft", "approval", "beneficiary", "warmer"],
      plannerExcludes: ["send_to_agent"],
    },
  ],
});
