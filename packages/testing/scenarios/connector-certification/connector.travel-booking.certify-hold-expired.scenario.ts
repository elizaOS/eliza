/** Scenario fixture for connector travel booking certify hold expired; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  lane: "live-only",
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
      // The prompt never names the seeded fault; the agent must discover the
      // lapsed supplier hold itself and report the re-priced state.
      text: "Hold the best flight option and get it ready for my sign-off. If anything changes with the option before I confirm, walk me through exactly where things stand.",
      responseIncludesAny: ["expired", "re-price", "new fare", "no longer"],
      expectedActions: ["CALENDAR", "MESSAGE", "VOICE_CALL"],
      actionPayloadIncludesAny: ["travel", "hold", "expired", "approval"],
    },
  ],
  finalChecks: [
    { type: "approvalRequestExists", expected: true },
    { type: "connectorDispatchOccurred", channel: ["email", "sms"] },
  ],
});
