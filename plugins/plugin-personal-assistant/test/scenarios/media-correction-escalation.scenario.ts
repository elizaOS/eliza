import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "media-correction-escalation",
  title: "Assistant escalates a media correction with counsel and PR",
  domain: "executive.messaging",
  tags: ["lifeops", "executive-assistant", "messaging", "legal", "privacy"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Media Correction Escalation",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-correction",
      text: "A reporter published a wrong claim about the acquisition timeline. Gather the factual timeline, prior statements, PR owner, counsel contact, and correction deadline.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "privacy", "delegation"],
      responseIncludesAny: ["timeline", "PR", "counsel", "deadline"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "draft-correction-path",
      text: "Draft a correction request, an internal update, and a holding line. Do not send until counsel approves the language.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["correction", "holding line", "counsel", "approve"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
