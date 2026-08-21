/** Defines one simulated connector failure contract or a deferred positive contract; positive provider evidence requires an external observer. */
import { buildConnectorContractScenario } from "./_factory.ts";

export default buildConnectorContractScenario({
  evidenceScope: "connector-contract",
  lane: "live-only",
  id: "connector.whatsapp.contract-delivery-degraded",
  title: "Exercise simulated WhatsApp degraded-delivery handling",
  connector: "whatsapp",
  axis: "delivery-degraded",
  description:
    "Simulated connector contract for WhatsApp when a send attempt reaches the transport but delivery stays degraded. The assistant must surface that condition instead of reporting a clean send.",
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
    {
      type: "connectorDispatchOccurred",
      channel: "whatsapp",
      turn: "whatsapp-delivery-degraded",
      delivered: true,
      expected: false,
      maxCount: 0,
    },
    { type: "interventionRequestExists", expected: true },
  ],
});
