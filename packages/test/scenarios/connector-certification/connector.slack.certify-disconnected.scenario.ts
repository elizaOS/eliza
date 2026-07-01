import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  lane: "live-only",
  id: "connector.slack.certify-disconnected",
  title: "Certify Slack disconnected degradation handling",
  connector: "slack",
  axis: "disconnected",
  roomSource: "slack",
  description:
    "Connector certification for Slack when the workspace token or socket connection is unavailable. The assistant must report the disconnect instead of pretending the reply was delivered.",
  seed: [
    {
      type: "connectorStatus",
      connector: "slack",
      provider: "Slack workspace",
      state: "disconnected",
    },
  ],
  turns: [
    {
      name: "slack-disconnected",
      text: "Read the Slack message and send the reply in-thread, but if Slack is disconnected, tell me that clearly and ask me to reconnect it instead of claiming the message went out.",
      responseIncludesAny: ["slack", "disconnected", "reconnect", "reply"],
      acceptedActions: ["MESSAGE", "MESSAGE"],
      includesAny: ["slack", "disconnected", "reconnect", "reply"],
    },
  ],
  finalChecks: [{ type: "clarificationRequested", expected: true }],
});
