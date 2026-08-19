/** Defines one simulated connector failure contract or a deferred positive contract; positive provider evidence requires an external observer. */
import { buildConnectorContractScenario } from "./_factory.ts";

export default buildConnectorContractScenario({
  evidenceScope: "connector-contract",
  lane: "live-only",
  id: "connector.gmail.contract-missing-scope",
  title: "Exercise simulated Gmail missing-scope degradation handling",
  connector: "gmail",
  axis: "missing-scope",
  description:
    "Simulated connector contract for Gmail degraded auth when send scope is missing. The assistant must surface the missing scope explicitly and hold a draft instead of pretending the reply was sent.",
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
    {
      type: "connectorDispatchOccurred",
      channel: "gmail",
      turn: "gmail-missing-scope",
      expected: false,
      maxCount: 0,
    },
  ],
});
