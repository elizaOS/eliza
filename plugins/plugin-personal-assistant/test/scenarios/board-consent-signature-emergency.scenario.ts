import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "board-consent-signature-emergency",
  title: "Assistant chases emergency board consent signatures without leaking deal terms",
  domain: "executive.documents",
  tags: ["lifeops", "executive-assistant", "documents", "privacy"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Board Consent Signature Emergency",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "map-board-consent-gap",
      text: "The financing consent needs signatures by 5pm. Find who has not signed, prepare reminder drafts, and keep deal terms out of the message body unless counsel already approved that wording.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "owner_send_message", "privacy"],
      responseIncludesAny: ["signature", "counsel", "draft", "approval"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "stage-counsel-escalation",
      text: "If any director is unreachable, draft an escalation to counsel with the missing names and the safest fallback path.",
      plannerIncludesAny: ["approval", "legal", "follow-up"],
      responseIncludesAny: ["director", "counsel", "fallback", "draft"],
      plannerExcludes: ["send_to_agent"],
    },
  ],
});
