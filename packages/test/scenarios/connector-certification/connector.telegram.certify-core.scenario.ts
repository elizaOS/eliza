import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  id: "connector.telegram.certify-core",
  title: "Certify Telegram inbound and reply delivery",
  connector: "telegram",
  axis: "core",
  roomSource: "telegram",
  description:
    "Connector certification for Telegram inbound fetch, draft/reply flows, thread context, and delivered outbound messages.",
  turns: [
    {
      name: "telegram-core",
      text: "Read the Telegram chat, draft a reply, and send it back in the same chat.",
      responseIncludesAny: ["telegram", "reply", "chat", "draft"],
      acceptedActions: ["MESSAGE", "MESSAGE"],
      includesAny: ["telegram", "reply", "chat", "draft"],
    },
  ],
  finalChecks: [
    { type: "draftExists", channel: "telegram", expected: true },
    { type: "messageDelivered", channel: "telegram", expected: true },
  ],
});
