import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  id: "connector.calendly.certify-disconnected",
  title: "Certify Calendly disconnected degradation handling",
  connector: "calendly",
  axis: "disconnected",
  description:
    "Connector certification for Calendly when the booking-link connector is disconnected. The assistant must acknowledge the disconnect instead of fabricating availability or a link.",
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
      text: "Get me a fresh Calendly booking link for next week, but if Calendly is disconnected, tell me that explicitly and ask me to reconnect it instead of inventing a link.",
      responseIncludesAny: ["calendly", "disconnected", "reconnect", "link"],
      acceptedActions: ["CALENDAR", "CALENDAR"],
      includesAny: ["calendly", "disconnected", "reconnect", "link"],
    },
  ],
  finalChecks: [{ type: "clarificationRequested", expected: true }],
});
