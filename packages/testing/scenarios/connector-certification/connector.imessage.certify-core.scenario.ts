/** Scenario fixture for connector imessage certify core; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  lane: "live-only",
  id: "connector.imessage.certify-core",
  title: "Certify iMessage bridge health and delivery",
  connector: "imessage",
  axis: "core",
  description:
    "Connector certification for iMessage bridge health, outbound message delivery, and reconnect-aware behavior.",
  turns: [
    {
      name: "imessage-core",
      text: "Use the iMessage bridge to read the thread, draft a reply, and send it when the bridge is healthy.",
      // Completion-state tokens the prompt never uses; parroting "draft a
      // reply, send it" cannot satisfy any of them.
      responseIncludesAny: ["drafted", "sent", "delivered", "on its way"],
      expectedActions: ["MESSAGE"],
      actionPayloadIncludesAny: ["imessage", "bridge", "reply", "send"],
    },
  ],
  finalChecks: [
    { type: "draftExists", channel: "imessage", expected: true },
    { type: "messageDelivered", channel: "imessage", expected: true },
    { type: "interventionRequestExists", expected: true },
  ],
});
