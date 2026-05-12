import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
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
      responseIncludesAny: ["travel", "hold", "book", "approve", "itinerary"],
      acceptedActions: [
        "CALENDAR",
        "MESSAGE",
        "VOICE_CALL",
      ],
      includesAny: ["travel", "hold", "book", "approve", "itinerary"],
    },
  ],
  finalChecks: [
    { type: "approvalRequestExists", expected: true },
    { type: "messageDelivered", channel: ["email", "sms"], expected: true },
  ],
});
