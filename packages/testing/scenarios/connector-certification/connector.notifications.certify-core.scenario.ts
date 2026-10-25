/** Scenario fixture for connector notifications certify core; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  lane: "live-only",
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
      // Completion-state tokens the prompt never uses; parroting "send the
      // reminder" cannot satisfy any of them.
      responseIncludesAny: ["delivered", "pushed", "both devices", "sent"],
      expectedActions: ["DEVICE_INTENT"],
      actionPayloadIncludesAny: ["desktop", "phone", "acknowledge", "reminder"],
    },
  ],
  finalChecks: [
    { type: "pushSent", channel: ["desktop", "mobile"] },
    { type: "pushEscalationOrder", channelOrder: ["desktop", "mobile"] },
    { type: "pushAcknowledgedSync", expected: true },
  ],
});
