import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  id: "connector.imessage.certify-helper-disconnected",
  title: "Certify iMessage helper-disconnected degradation handling",
  connector: "imessage",
  axis: "helper-disconnected",
  description:
    "Connector certification for iMessage when the Mac-side helper is disconnected. The assistant must surface the helper outage instead of pretending the bridge is healthy.",
  seed: [
    {
      type: "connectorStatus",
      connector: "imessage",
      provider: "BlueBubbles / Blooio",
      state: "helper-disconnected",
    },
  ],
  turns: [
    {
      name: "imessage-helper-disconnected",
      text: "Use the iMessage bridge to read the thread and send the reply, but if the helper is disconnected, tell me that clearly and ask me to repair it instead of claiming success.",
      responseIncludesAny: ["imessage", "helper", "disconnected", "repair"],
      acceptedActions: ["MESSAGE", "MESSAGE"],
      includesAny: ["imessage", "helper", "disconnected", "repair"],
    },
  ],
  finalChecks: [{ type: "interventionRequestExists", expected: true }],
});
