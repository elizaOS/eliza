import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
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
      text: "Read the Discord DM and send the reply in-thread, but if Discord is disconnected, tell me that clearly and ask me to reconnect it instead of claiming the message went out.",
      responseIncludesAny: ["discord", "disconnected", "reconnect", "reply"],
      acceptedActions: ["MESSAGE", "MESSAGE"],
      includesAny: ["discord", "disconnected", "reconnect", "reply"],
    },
  ],
  finalChecks: [{ type: "clarificationRequested", expected: true }],
});
