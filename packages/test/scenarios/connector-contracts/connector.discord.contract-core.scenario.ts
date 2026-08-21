/** Exercises Discord thread read and reply through the production MESSAGE action. */
import { buildStatefulMessageConnectorScenario } from "./_stateful-message-connector.ts";
export default buildStatefulMessageConnectorScenario({
  evidenceScope: "connector-contract",
  id: "connector.discord.contract-core",
  title: "Discord thread read and exact-context reply contract",
  source: "discord",
  label: "Discord",
  recipientLabel: "Product Team thread",
  inboundText: "Can you confirm the launch checklist is complete?",
  outboundText: "Confirmed — the launch checklist is complete.",
});
