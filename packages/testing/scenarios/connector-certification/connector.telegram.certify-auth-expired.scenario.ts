/** Scenario fixture for connector telegram certify auth expired; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  lane: "live-only",
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
      // The prompt never names the seeded failure; the agent must discover the
      // dead login itself and report it in its own words.
      text: "Open the Telegram chat and get my reply out. Level with me about anything blocking it before you claim it went through.",
      responseIncludesAny: ["expired", "re-auth", "log in again", "session"],
      expectedActions: ["MESSAGE"],
      actionPayloadIncludesAny: ["telegram", "expired", "auth", "reconnect"],
    },
  ],
  finalChecks: [{ type: "interventionRequestExists", expected: true }],
});
