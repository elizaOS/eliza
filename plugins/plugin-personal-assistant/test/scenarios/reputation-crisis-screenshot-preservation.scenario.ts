import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "reputation-crisis-screenshot-preservation",
  title: "Assistant preserves evidence during reputation crisis",
  domain: "executive.escalation",
  tags: ["lifeops", "executive-assistant", "privacy", "legal", "messaging"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Reputation Crisis Screenshot Preservation",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-reputation-posts",
      text: "A false thread about me is spreading. Preserve screenshots, URLs, timestamps, affected contacts, and counsel escalation options without engaging publicly.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "priority", "privacy"],
      responseIncludesAny: ["screenshots", "URLs", "timestamps", "counsel"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "stage-counsel-brief",
      text: "Draft a private counsel brief and a stakeholder holding note, but ask before sending anything or naming the poster to the team.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["counsel", "stakeholder", "holding note", "ask"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
