/** Exercises Gmail-thread read and reply persistence through the production MESSAGE action. */
import { buildStatefulMessageConnectorScenario } from "./_stateful-message-connector.ts";
export default buildStatefulMessageConnectorScenario({
  evidenceScope: "connector-contract",
  id: "connector.gmail.contract-core",
  title: "Gmail thread read and exact-context reply contract",
  source: "gmail",
  label: "Gmail",
  recipientLabel: "Sarah Lee product brief thread",
  inboundText: "Can you review the product brief by Friday afternoon?",
  outboundText: "Thanks, Sarah — I can review it Friday afternoon.",
});
