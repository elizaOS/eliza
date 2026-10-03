/** Scenario fixture for connector discord certify disconnected; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  lane: "live-only",
  id: "connector.discord.certify-disconnected",
  title: "Certify Discord disconnected degradation handling",
  connector: "discord",
  axis: "disconnected",
  roomSource: "discord",
  description:
    "Connector certification for Discord when the bridge or logged-in DM context is unavailable. The assistant must report the disconnect instead of pretending the reply was delivered.",
  seed: [
    {
      type: "connectorStatus",
      connector: "discord",
      provider: "Discord bridge",
      state: "disconnected",
    },
  ],
  turns: [
    {
      name: "discord-disconnected",
      // The prompt never names the seeded failure; the agent must discover the
      // disconnect from the connector itself and report it in its own words.
      text: "Read the latest Discord DM and get my reply posted in-thread. Be honest with me about anything that stops it from going out.",
      responseIncludesAny: [
        "disconnected",
        "not connected",
        "reconnect",
        "offline",
      ],
      expectedActions: ["MESSAGE"],
      actionPayloadIncludesAny: [
        "discord",
        "disconnected",
        "reconnect",
        "reply",
      ],
    },
  ],
  finalChecks: [{ type: "clarificationRequested", expected: true }],
});
