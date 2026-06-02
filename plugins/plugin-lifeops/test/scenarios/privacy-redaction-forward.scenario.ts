import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "privacy-redaction-forward",
  title: "Assistant redacts sensitive material before forwarding a briefing",
  domain: "executive.privacy",
  tags: ["lifeops", "executive-assistant", "documents", "privacy"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Privacy Redaction Forward",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "redact-sensitive-briefing",
      text: "Prepare the investor update for forwarding, but remove bank numbers, home addresses, private calendar details, and anything about health.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "redact", "privacy"],
      responseIncludesAny: ["redact", "bank", "address", "private"],
      plannerExcludes: ["owner_send_message"],
    },
    {
      kind: "message",
      name: "request-forward-approval",
      text: "Show me the redaction checklist and ask for approval before creating the forward draft.",
      plannerIncludesAny: ["RESOLVE_REQUEST", "owner_send_message", "draft"],
      responseIncludesAny: ["checklist", "approval", "draft"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
  ],
});
