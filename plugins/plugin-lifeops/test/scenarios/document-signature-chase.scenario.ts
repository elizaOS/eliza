import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "document-signature-chase",
  title: "Assistant requests signature, tracks deadline, and prepares chase",
  domain: "executive.documents",
  tags: ["lifeops", "executive-assistant", "documents", "approvals"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Document Signature Chase",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "request-signature",
      text: "Get the partner NDA signed by Priya by Friday, track the deadline, and draft the chase note for approval.",
      plannerIncludesAll: ["OWNER_DOCUMENTS"],
      plannerIncludesAny: ["signature", "deadline", "priya", "approval"],
      responseIncludesAny: ["signature", "deadline", "approval", "Friday"],
      plannerExcludes: ["calendar_action", "gmail_action"],
    },
    {
      kind: "message",
      name: "close-after-signed",
      text: "Priya signed it. Close the request and stop chasing.",
      plannerIncludesAll: ["OWNER_DOCUMENTS"],
      plannerIncludesAny: ["close_request", "signed", "stop"],
      responseIncludesAny: ["closed", "stopped", "done"],
      plannerExcludes: ["owner_send_message"],
    },
  ],
});
