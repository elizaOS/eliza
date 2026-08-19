/** Exercises iMessage-thread read and reply persistence through the production MESSAGE action. */
import { buildStatefulMessageConnectorScenario } from "./_stateful-message-connector.ts";
export default buildStatefulMessageConnectorScenario({
  evidenceScope: "connector-contract",
  id: "connector.imessage.contract-core",
  title: "iMessage bridge read and exact-context reply contract",
  source: "imessage",
  label: "iMessage",
  recipientLabel: "Alex lunch thread",
  inboundText: "Are we still meeting for lunch at noon?",
  outboundText: "Yes — see you at noon.",
});
