/** Scenario fixture for connector gmail certify missing scope; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  lane: "live-only",
  id: "connector.gmail.certify-missing-scope",
  title: "Certify Gmail missing-scope degradation handling",
  connector: "gmail",
  axis: "missing-scope",
  description:
    "Connector certification for Gmail degraded auth when send scope is missing. The assistant must surface the missing scope explicitly and hold a draft instead of pretending the reply was sent.",
  seed: [
    {
      type: "connectorStatus",
      connector: "gmail",
      provider: "Gmail API",
      state: "missing-scope",
      capabilities: ["google.gmail.triage"],
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    },
  ],
  turns: [
    {
      name: "gmail-missing-scope",
      // The prompt never names the seeded failure; the agent must discover the
      // missing send scope from the connector itself and report it.
      text: "Read Sarah Lee's unread Gmail thread and get the reply ready to go out. Tell me plainly if anything prevents that from completing, before you claim it happened.",
      responseIncludesAny: ["scope", "permission", "read-only", "re-auth"],
      expectedActions: ["MESSAGE"],
      actionPayloadIncludesAny: ["gmail", "missing", "scope", "reconnect"],
    },
  ],
  finalChecks: [
    { type: "draftExists", channel: "gmail", expected: true },
    { type: "interventionRequestExists", expected: true },
  ],
});
