import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  id: "connector.gmail.certify-core",
  title: "Certify Gmail read, draft, and send-after-approval",
  connector: "gmail",
  axis: "core",
  description:
    "Connector certification for Gmail inbox reads, reply draft creation against a real unread message, explicit approval before send, and successful reply dispatch.",
  turns: [
    {
      name: "gmail-draft",
      text: "Draft a reply to Sarah Lee's Gmail message with subject 'Can you review the product brief?'. Hold the reply for approval and do not send it yet.",
      responseIncludesAny: ["gmail", "draft", "approve", "unread"],
      acceptedActions: ["MESSAGE"],
      includesAny: ["gmail", "draft", "approve", "unread"],
    },
    {
      name: "gmail-confirm-send",
      text: "Use the existing Gmail draft reply to Sarah Lee and send_reply now with confirmed true.",
      responseIncludesAny: ["gmail", "sent", "reply"],
      acceptedActions: ["MESSAGE"],
      includesAny: ["gmail", "send", "reply"],
    },
  ],
  finalChecks: [
    { type: "draftExists", channel: "gmail", expected: true },
    { type: "approvalRequestExists", expected: true },
    { type: "messageDelivered", channel: "gmail", expected: true },
  ],
});
