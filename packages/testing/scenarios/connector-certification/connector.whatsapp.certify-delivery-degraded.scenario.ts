/** Scenario fixture for connector whatsapp certify delivery degraded; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  lane: "live-only",
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
      // The prompt never names the seeded fault; the agent must discover the
      // degraded delivery from the dispatch result itself and report it.
      text: "Read the WhatsApp chat and get my reply out, then give me the real status of what actually happened to it.",
      responseIncludesAny: [
        "degraded",
        "unconfirmed",
        "not confirmed",
        "undelivered",
      ],
      expectedActions: ["MESSAGE"],
      actionPayloadIncludesAny: ["whatsapp", "delivery", "degraded", "reply"],
    },
  ],
  finalChecks: [
    { type: "connectorDispatchOccurred", channel: "whatsapp" },
    { type: "interventionRequestExists", expected: true },
  ],
});
