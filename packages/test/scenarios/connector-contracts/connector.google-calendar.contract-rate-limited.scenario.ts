/** Defines one simulated connector failure contract or a deferred positive contract; positive provider evidence requires an external observer. */
import { buildConnectorContractScenario } from "./_factory.ts";

export default buildConnectorContractScenario({
  evidenceScope: "connector-contract",
  lane: "live-only",
  id: "connector.google-calendar.contract-rate-limited",
  title: "Exercise simulated Google Calendar rate-limit degradation handling",
  connector: "google-calendar",
  axis: "rate-limited",
  description:
    "Simulated connector contract for Google Calendar rate limits. The assistant must surface the throttled state and offer a retry-safe next step instead of claiming the event was written.",
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
      // The prompt never names the seeded throttle; the agent must discover it
      // from the connector's own response and report it.
      text: "Check whether I'm free tomorrow at 3pm and put the meeting on the books if possible. If Google Calendar pushes back, tell me exactly what it said and what you plan to do next, instead of pretending the event exists.",
      responseIncludesAny: ["rate limit", "rate-limited", "throttl", "quota"],
      expectedActions: ["CALENDAR"],
      actionPayloadIncludesAny: ["calendar", "rate", "limited", "retry"],
    },
  ],
  finalChecks: [
    { type: "clarificationRequested", expected: true },
    {
      type: "connectorDispatchOccurred",
      channel: "google-calendar",
      turn: "calendar-rate-limited",
      delivered: true,
      expected: false,
      maxCount: 0,
    },
  ],
});
