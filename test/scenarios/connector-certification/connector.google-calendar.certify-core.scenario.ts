import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
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
      responseIncludesAny: ["availability", "meeting", "move", "cancel"],
      acceptedActions: [
        "CALENDAR",
        "CALENDAR",
        "CALENDAR",
      ],
      includesAny: ["availability", "meeting", "move", "cancel"],
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
