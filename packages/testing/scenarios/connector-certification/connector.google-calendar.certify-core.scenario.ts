/** Scenario fixture for connector google calendar certify core; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  lane: "live-only",
  id: "connector.google-calendar.certify-core",
  title: "Certify Google Calendar availability and lifecycle actions",
  connector: "google-calendar",
  axis: "core",
  description:
    "Connector certification for availability checks, event creation, reschedule, cancel, and conflict-aware calendar reads.",
  turns: [
    {
      name: "calendar-core",
      text: "Check my availability tomorrow, create the meeting if I'm free, and be able to move or cancel it later.",
      // Completion-state tokens the prompt never uses; parroting "create the
      // meeting" cannot satisfy any of them.
      responseIncludesAny: ["scheduled", "booked", "created", "confirmed"],
      expectedActions: ["CALENDAR"],
      actionPayloadIncludesAny: ["availability", "meeting", "move", "cancel"],
    },
  ],
  finalChecks: [
    {
      type: "selectedActionArguments",
      actionName: "CALENDAR",
      includesAny: ["availability", "create", "cancel", "reschedule"],
    },
    {
      type: "memoryWriteOccurred",
      table: ["messages", "facts"],
    },
  ],
});
