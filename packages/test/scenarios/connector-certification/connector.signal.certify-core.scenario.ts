/** Scenario fixture for connector signal certify core; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  lane: "live-only",
  id: "connector.signal.certify-core",
  title: "Certify Signal inbound and delivery behavior",
  connector: "signal",
  axis: "core",
  description:
    "Connector certification for Signal inbound reads, response drafting, send attempts, and degraded delivery handling.",
  turns: [
    {
      name: "signal-core",
      text: "Read the Signal thread, draft a reply, and deliver it or tell me if Signal is degraded.",
      // Completion-state tokens the prompt never uses; parroting "draft a
      // reply, deliver it" cannot satisfy any of them.
      responseIncludesAny: ["drafted", "sent", "delivered", "on its way"],
      expectedActions: ["MESSAGE"],
      actionPayloadIncludesAny: ["signal", "reply", "deliver", "degraded"],
    },
  ],
  finalChecks: [
    { type: "draftExists", channel: "signal", expected: true },
    { type: "messageDelivered", channel: "signal", expected: true },
    { type: "interventionRequestExists", expected: true },
  ],
});
