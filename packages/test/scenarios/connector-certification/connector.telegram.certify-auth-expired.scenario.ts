import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  id: "connector.telegram.certify-auth-expired",
  title: "Certify Telegram expired-auth degradation handling",
  connector: "telegram",
  axis: "auth-expired",
  roomSource: "telegram",
  description:
    "Connector certification for Telegram when the local auth session has expired. The assistant must request re-auth instead of pretending the send path is still healthy.",
  seed: [
    {
      type: "connectorAuthSession",
      connector: "telegram",
      provider: "Telegram bridge",
      state: "auth-expired",
    },
  ],
  turns: [
    {
      name: "telegram-auth-expired",
      text: "Open the Telegram chat and send the reply, but if the Telegram login expired, say that explicitly and ask for re-authentication instead of claiming it was sent.",
      responseIncludesAny: ["telegram", "expired", "auth", "reconnect"],
      acceptedActions: ["MESSAGE", "MESSAGE"],
      includesAny: ["telegram", "expired", "auth", "reconnect"],
    },
  ],
  finalChecks: [{ type: "interventionRequestExists", expected: true }],
});
