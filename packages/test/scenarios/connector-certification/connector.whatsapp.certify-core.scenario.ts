import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  id: "connector.whatsapp.certify-core",
  title: "Certify WhatsApp inbound and delivery behavior",
  connector: "whatsapp",
  axis: "core",
  description:
    "Connector certification for WhatsApp inbound reads, response drafting, send attempts, and degraded delivery handling.",
  turns: [
    {
      name: "whatsapp-core",
      text: "Read the WhatsApp chat, draft a reply, and deliver it or tell me if WhatsApp is degraded.",
      responseIncludesAny: ["whatsapp", "reply", "deliver", "degraded"],
      acceptedActions: ["MESSAGE", "MESSAGE"],
      includesAny: ["whatsapp", "reply", "deliver", "degraded"],
    },
  ],
  finalChecks: [
    { type: "draftExists", channel: "whatsapp", expected: true },
    { type: "messageDelivered", channel: "whatsapp", expected: true },
    { type: "interventionRequestExists", expected: true },
  ],
});
