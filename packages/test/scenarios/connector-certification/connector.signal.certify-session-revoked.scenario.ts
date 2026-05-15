import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
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
      text: "Read the Signal thread and send the reply, but if the linked Signal session was revoked, say that clearly and ask for re-linking instead of claiming the reply was delivered.",
      responseIncludesAny: ["signal", "revoked", "relink", "reply"],
      acceptedActions: ["MESSAGE", "MESSAGE"],
      includesAny: ["signal", "revoked", "relink", "reply"],
    },
  ],
  finalChecks: [{ type: "interventionRequestExists", expected: true }],
});
