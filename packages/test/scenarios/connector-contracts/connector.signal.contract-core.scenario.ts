/** Exercises Signal-thread read and reply persistence through the production MESSAGE action. */
import { buildStatefulMessageConnectorScenario } from "./_stateful-message-connector.ts";
export default buildStatefulMessageConnectorScenario({
  evidenceScope: "connector-contract",
  id: "connector.signal.contract-core",
  title: "Signal thread read and exact-context reply contract",
  source: "signal",
  label: "Signal",
  recipientLabel: "Morgan travel thread",
  inboundText: "Did the hotel confirmation come through?",
  outboundText: "Yes — the hotel confirmation came through.",
});
