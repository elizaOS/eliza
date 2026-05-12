import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  id: "connector.notifications.certify-core",
  title: "Certify desktop and mobile notification synchronization",
  connector: "notifications",
  axis: "core",
  description:
    "Connector certification for desktop/mobile push dispatch, acknowledgement sync, and suppression after acknowledgement.",
  turns: [
    {
      name: "notifications-core",
      text: "Send the reminder to my desktop and phone, and stop the ladder everywhere once I acknowledge it.",
      responseIncludesAny: ["desktop", "phone", "acknowledge", "reminder"],
      acceptedActions: ["DEVICE_INTENT", "DEVICE_INTENT"],
      includesAny: ["desktop", "phone", "acknowledge", "reminder"],
    },
  ],
  finalChecks: [
    { type: "pushSent", channel: ["desktop", "mobile"] },
    { type: "pushEscalationOrder", channelOrder: ["desktop", "mobile"] },
    { type: "pushAcknowledgedSync", expected: true },
  ],
});
