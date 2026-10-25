/** Scenario fixture for connector calendly certify core; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  lane: "live-only",
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
      // Derived-output tokens: a real handoff surfaces an actual link or
      // concrete open slots; none of these appear in the prompt text.
      responseIncludesAny: [
        "calendly.com",
        "https://",
        "single-use",
        "open slots",
      ],
      expectedActions: ["CALENDAR"],
      actionPayloadIncludesAny: ["calendly", "availability", "booking"],
      responseJudge: {
        rubric:
          "The reply hands over a concrete, shareable Calendly booking link (an actual URL) and reflects real availability data, rather than merely promising to look one up.",
        minimumScore: 0.6,
      },
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
