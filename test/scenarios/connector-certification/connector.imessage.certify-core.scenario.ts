import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  id: "connector.imessage.certify-core",
  title: "Certify iMessage bridge health and delivery",
  connector: "imessage",
  axis: "core",
  description:
    "Connector certification for iMessage bridge health, outbound message delivery, and reconnect-aware behavior.",
  turns: [
    {
      name: "imessage-core",
      text: "Use the iMessage bridge to read the thread, draft a reply, and send it when the bridge is healthy.",
      responseIncludesAny: ["imessage", "bridge", "reply", "send"],
      acceptedActions: ["MESSAGE", "MESSAGE"],
      includesAny: ["imessage", "bridge", "reply", "send"],
    },
  ],
  finalChecks: [
    { type: "draftExists", channel: "imessage", expected: true },
    { type: "messageDelivered", channel: "imessage", expected: true },
    { type: "interventionRequestExists", expected: true },
  ],
});
