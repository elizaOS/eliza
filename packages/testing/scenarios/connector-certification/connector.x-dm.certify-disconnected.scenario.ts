/** Scenario fixture for connector x dm certify disconnected; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  lane: "live-only",
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
      // The prompt never names the seeded failure; the agent must discover the
      // disconnect itself and report it in its own words.
      text: "Read my unread X DMs and get the right reply ready. Be straight with me about whether the DM workflow actually worked end to end.",
      responseIncludesAny: [
        "disconnected",
        "not connected",
        "reconnect",
        "credentials",
      ],
      expectedActions: ["X_READ", "INBOX"],
      actionPayloadIncludesAny: ["x", "dm", "disconnected", "reconnect"],
    },
  ],
  finalChecks: [{ type: "clarificationRequested", expected: true }],
});
