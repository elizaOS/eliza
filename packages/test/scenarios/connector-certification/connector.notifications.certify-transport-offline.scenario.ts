import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  id: "connector.notifications.certify-transport-offline",
  title: "Certify push transport-offline degradation handling",
  connector: "notifications",
  axis: "transport-offline",
  description:
    "Connector certification for desktop/mobile push when the transport is offline. The assistant must surface the failure instead of claiming the device ladder fired.",
  seed: [
    {
      type: "transportFault",
      connector: "notifications",
      provider: "Desktop notification bridge",
      state: "transport-offline",
      limit: 1,
    },
  ],
  turns: [
    {
      name: "notifications-transport-offline",
      text: "Send the reminder to my desktop and phone, but if the push transport is offline, tell me that explicitly instead of pretending the ladder fired.",
      responseIncludesAny: ["desktop", "phone", "offline", "push"],
      acceptedActions: ["DEVICE_INTENT", "DEVICE_INTENT"],
      includesAny: ["desktop", "phone", "offline", "push"],
    },
  ],
  finalChecks: [
    { type: "clarificationRequested", expected: true },
    { type: "interventionRequestExists", expected: true },
  ],
});
