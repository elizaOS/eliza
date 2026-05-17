import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  id: "connector.whatsapp.certify-delivery-degraded",
  title: "Certify WhatsApp degraded-delivery handling",
  connector: "whatsapp",
  axis: "delivery-degraded",
  description:
    "Connector certification for WhatsApp when a send attempt reaches the transport but delivery stays degraded. The assistant must surface that condition instead of reporting a clean send.",
  seed: [
    {
      type: "transportFault",
      connector: "whatsapp",
      provider: "WhatsApp bridge",
      state: "delivery-degraded",
      limit: 1,
    },
  ],
  turns: [
    {
      name: "whatsapp-delivery-degraded",
      text: "Read the WhatsApp chat and try to send the reply, but if delivery is degraded after dispatch, tell me that explicitly instead of saying it definitely went through.",
      responseIncludesAny: ["whatsapp", "delivery", "degraded", "reply"],
      acceptedActions: ["MESSAGE", "MESSAGE"],
      includesAny: ["whatsapp", "delivery", "degraded", "reply"],
    },
  ],
  finalChecks: [
    { type: "connectorDispatchOccurred", channel: "whatsapp" },
    { type: "interventionRequestExists", expected: true },
  ],
});
