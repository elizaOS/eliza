/** Scenario fixture for connector signal certify session revoked; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  lane: "live-only",
  id: "connector.signal.certify-session-revoked",
  title: "Certify Signal revoked-session degradation handling",
  connector: "signal",
  axis: "session-revoked",
  description:
    "Connector certification for Signal when the linked device session was revoked. The assistant must surface the revoked state and request repair instead of pretending delivery worked.",
  seed: [
    {
      type: "connectorAuthSession",
      connector: "signal",
      provider: "Signal bridge",
      state: "session-revoked",
    },
  ],
  turns: [
    {
      name: "signal-session-revoked",
      // The prompt never names the seeded failure; the agent must discover the
      // revoked device session itself and report it in its own words.
      text: "Read the Signal thread and get my reply out. Be honest about anything preventing delivery before you claim it worked.",
      responseIncludesAny: ["revoked", "re-link", "linked device", "session"],
      expectedActions: ["MESSAGE"],
      actionPayloadIncludesAny: ["signal", "revoked", "relink", "reply"],
    },
  ],
  finalChecks: [{ type: "interventionRequestExists", expected: true }],
});
