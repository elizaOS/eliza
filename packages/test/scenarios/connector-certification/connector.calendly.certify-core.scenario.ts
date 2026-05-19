import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  id: "connector.calendly.certify-core",
  title: "Certify Calendly availability and booking-link flows",
  connector: "calendly",
  axis: "core",
  description:
    "Connector certification for Calendly availability lookups, booking-link handoff, and reconciliation-friendly booking flows.",
  turns: [
    {
      name: "calendly-core",
      text: "Check my Calendly availability and give me a booking link I can send out.",
      responseIncludesAny: ["calendly", "availability", "booking link"],
      acceptedActions: ["CALENDAR", "CALENDAR"],
      includesAny: ["calendly", "availability", "booking"],
    },
  ],
  finalChecks: [
    {
      type: "selectedActionArguments",
      actionName: "CALENDAR",
      includesAny: ["availability", "single_use_link", "booking"],
    },
  ],
});
