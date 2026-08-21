/** Defines one simulated connector failure contract or a deferred positive contract; positive provider evidence requires an external observer. */
import { buildConnectorContractScenario } from "./_factory.ts";

export default buildConnectorContractScenario({
  evidenceScope: "connector-contract",
  lane: "live-only",
  id: "connector.calendly.contract-disconnected",
  title: "Exercise simulated Calendly disconnected degradation handling",
  connector: "calendly",
  axis: "disconnected",
  description:
    "Simulated connector contract for Calendly when the booking-link connector is disconnected. The assistant must acknowledge the disconnect instead of fabricating availability or a link.",
  seed: [
    {
      type: "connectorStatus",
      connector: "calendly",
      provider: "Calendly API",
      state: "disconnected",
    },
  ],
  turns: [
    {
      name: "calendly-disconnected",
      // The prompt never names the seeded failure; the agent must discover the
      // disconnect from the connector itself and report it in its own words.
      text: "Get me a fresh Calendly booking link for next week, and be straight with me about anything blocking that before you claim it's ready.",
      responseIncludesAny: [
        "disconnected",
        "not connected",
        "reconnect",
        "connection",
      ],
      expectedActions: ["CALENDAR"],
      actionPayloadIncludesAny: [
        "calendly",
        "disconnected",
        "reconnect",
        "link",
      ],
    },
  ],
  finalChecks: [
    { type: "clarificationRequested", expected: true },
    {
      type: "connectorDispatchOccurred",
      channel: "calendly",
      turn: "calendly-disconnected",
      expected: false,
      maxCount: 0,
    },
  ],
});
