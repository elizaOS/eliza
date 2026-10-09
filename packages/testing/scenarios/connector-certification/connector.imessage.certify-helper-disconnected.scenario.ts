/** Scenario fixture for connector imessage certify helper disconnected; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  lane: "live-only",
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
      // The prompt never names the seeded failure; the agent must discover the
      // Mac-side helper outage from the connector itself and report it.
      text: "Use the iMessage bridge to read the thread and get my reply out. Level with me about anything standing in the way before you claim success.",
      responseIncludesAny: [
        "helper",
        "disconnected",
        "bluebubbles",
        "reconnect",
      ],
      expectedActions: ["MESSAGE"],
      actionPayloadIncludesAny: [
        "imessage",
        "helper",
        "disconnected",
        "repair",
      ],
    },
  ],
  finalChecks: [{ type: "interventionRequestExists", expected: true }],
});
