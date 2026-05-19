import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  id: "connector.x-dm.certify-disconnected",
  title: "Certify X DM disconnected degradation handling",
  connector: "x-dm",
  axis: "disconnected",
  description:
    "Connector certification for X DMs when the connector is disconnected or lacks live credentials. The assistant must surface the disconnect instead of pretending a draft or send succeeded.",
  seed: [
    {
      type: "connectorStatus",
      connector: "x-dm",
      provider: "X bridge",
      state: "disconnected",
    },
  ],
  turns: [
    {
      name: "x-dm-disconnected",
      text: "Read my unread X DMs and draft the right reply, but if X is disconnected, tell me that clearly and ask for reconnect instead of pretending the DM workflow is available.",
      responseIncludesAny: ["x", "dm", "disconnected", "reconnect"],
      acceptedActions: ["X_READ", "INBOX"],
      includesAny: ["x", "dm", "disconnected", "reconnect"],
    },
  ],
  finalChecks: [{ type: "clarificationRequested", expected: true }],
});
