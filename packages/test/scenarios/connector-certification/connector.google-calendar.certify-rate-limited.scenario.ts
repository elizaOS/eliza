import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  id: "connector.google-calendar.certify-rate-limited",
  title: "Certify Google Calendar rate-limit degradation handling",
  connector: "google-calendar",
  axis: "rate-limited",
  description:
    "Connector certification for Google Calendar rate limits. The assistant must surface the throttled state and offer a retry-safe next step instead of claiming the event was written.",
  seed: [
    {
      type: "transportFault",
      connector: "google-calendar",
      provider: "Google Calendar API",
      state: "rate-limited",
      limit: 1,
    },
  ],
  turns: [
    {
      name: "calendar-rate-limited",
      text: "Check whether I'm free tomorrow at 3pm and create the meeting if possible, but if Google Calendar is rate limited right now, say that clearly and ask whether to retry instead of pretending the event exists.",
      responseIncludesAny: ["calendar", "rate", "limited", "retry"],
      acceptedActions: ["CALENDAR", "CALENDAR", "CALENDAR"],
      includesAny: ["calendar", "rate", "limited", "retry"],
    },
  ],
  finalChecks: [{ type: "clarificationRequested", expected: true }],
});
