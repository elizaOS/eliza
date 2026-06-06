import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "medical-poa-document-chase",
  title: "Assistant chases medical POA documents privately",
  domain: "executive.family",
  tags: ["lifeops", "executive-assistant", "family", "documents", "privacy"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Medical POA Document Chase",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "assemble-poa-gaps",
      text: "For my parent, find medical POA gaps: signed forms, hospital portal contact, sibling review status, notary requirement, and deadline before the procedure.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "deadline", "privacy"],
      responseIncludesAny: ["POA", "portal", "sibling", "notary"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "draft-poa-followups",
      text: "Draft follow-ups to the sibling and attorney, but do not disclose diagnosis details unless I approve that recipient.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["sibling", "attorney", "diagnosis", "approve"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
