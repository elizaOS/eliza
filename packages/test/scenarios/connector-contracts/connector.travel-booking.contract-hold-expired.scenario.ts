/** Defines one simulated connector failure contract or a deferred positive contract; positive provider evidence requires an external observer. */
import { buildConnectorContractScenario } from "./_factory.ts";

export default buildConnectorContractScenario({
  evidenceScope: "connector-contract",
  lane: "live-only",
  id: "connector.travel-booking.contract-hold-expired",
  title: "Exercise simulated travel booking expired-hold degradation handling",
  connector: "travel-booking",
  axis: "hold-expired",
  description:
    "Simulated connector contract for travel booking when a supplier hold expires before confirmation. The assistant must re-price and re-queue approval instead of pretending the old hold still exists.",
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
    {
      type: "connectorDispatchOccurred",
      channel: "travel-booking",
      turn: "travel-hold-expired",
      delivered: true,
      expected: false,
      maxCount: 0,
    },
  ],
});
