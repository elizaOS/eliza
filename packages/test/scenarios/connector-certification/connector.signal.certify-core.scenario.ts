import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
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
      responseIncludesAny: ["signal", "reply", "deliver", "degraded"],
      acceptedActions: ["MESSAGE", "MESSAGE"],
      includesAny: ["signal", "reply", "deliver", "degraded"],
    },
  ],
  finalChecks: [
    { type: "draftExists", channel: "signal", expected: true },
    { type: "messageDelivered", channel: "signal", expected: true },
    { type: "interventionRequestExists", expected: true },
  ],
});
