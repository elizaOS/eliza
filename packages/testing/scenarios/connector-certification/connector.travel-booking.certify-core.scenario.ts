/** Scenario fixture for connector travel booking certify core; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  lane: "live-only",
  id: "connector.travel-booking.certify-core",
  title: "Certify travel booking adapter search and approval gating",
  connector: "travel-booking",
  axis: "core",
  description:
    "Connector certification for travel search, hold/book approval gating, itinerary sync, and rebooking coordination on conflicts.",
  turns: [
    {
      name: "travel-booking-core",
      text: "Search the travel options, hold the best one, and only book it once I approve the itinerary.",
      // Derived-output tokens: a real hold reports concrete pricing and the
      // pending approval; none of these appear in the prompt text.
      responseIncludesAny: [
        "fare",
        "price",
        "awaiting your approval",
        "placed a hold",
      ],
      expectedActions: ["CALENDAR", "MESSAGE", "VOICE_CALL"],
      actionPayloadIncludesAny: [
        "travel",
        "hold",
        "book",
        "approve",
        "itinerary",
      ],
    },
  ],
  finalChecks: [
    { type: "approvalRequestExists", expected: true },
    { type: "messageDelivered", channel: ["email", "sms"], expected: true },
  ],
});
