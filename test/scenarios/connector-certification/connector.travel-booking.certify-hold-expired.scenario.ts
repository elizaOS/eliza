import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  id: "connector.travel-booking.certify-hold-expired",
  title: "Certify travel booking expired-hold degradation handling",
  connector: "travel-booking",
  axis: "hold-expired",
  description:
    "Connector certification for travel booking when a supplier hold expires before confirmation. The assistant must re-price and re-queue approval instead of pretending the old hold still exists.",
  seed: [
    {
      type: "transportFault",
      connector: "travel-booking",
      provider: "Travel adapter",
      state: "hold-expired",
      limit: 1,
    },
  ],
  turns: [
    {
      name: "travel-hold-expired",
      text: "Hold the best flight option and get it ready for approval, but if the supplier hold expired before confirmation, re-price it and queue the updated itinerary instead of pretending the original hold is still valid.",
      responseIncludesAny: ["travel", "hold", "expired", "approval"],
      acceptedActions: [
        "CALENDAR",
        "MESSAGE",
        "VOICE_CALL",
      ],
      includesAny: ["travel", "hold", "expired", "approval"],
    },
  ],
  finalChecks: [
    { type: "approvalRequestExists", expected: true },
    { type: "connectorDispatchOccurred", channel: ["email", "sms"] },
  ],
});
