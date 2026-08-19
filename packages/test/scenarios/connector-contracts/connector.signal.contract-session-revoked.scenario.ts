/** Defines one simulated connector failure contract or a deferred positive contract; positive provider evidence requires an external observer. */
import { buildConnectorContractScenario } from "./_factory.ts";

export default buildConnectorContractScenario({
  evidenceScope: "connector-contract",
  lane: "live-only",
  id: "connector.signal.contract-session-revoked",
  title: "Exercise simulated Signal revoked-session degradation handling",
  connector: "signal",
  axis: "session-revoked",
  description:
    "Simulated connector contract for Signal when the linked device session was revoked. The assistant must surface the revoked state and request repair instead of pretending delivery worked.",
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
  finalChecks: [
    { type: "interventionRequestExists", expected: true },
    {
      type: "connectorDispatchOccurred",
      channel: "signal",
      turn: "signal-session-revoked",
      expected: false,
      maxCount: 0,
    },
  ],
});
