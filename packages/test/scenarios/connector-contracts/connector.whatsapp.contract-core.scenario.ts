/** Exercises WhatsApp-thread read and reply persistence through the production MESSAGE action. */
import { buildStatefulMessageConnectorScenario } from "./_stateful-message-connector.ts";
export default buildStatefulMessageConnectorScenario({
  evidenceScope: "connector-contract",
  id: "connector.whatsapp.contract-core",
  title: "WhatsApp chat read and exact-context reply contract",
  source: "whatsapp",
  label: "WhatsApp",
  recipientLabel: "Contractor project chat",
  inboundText: "Can you approve the revised delivery date?",
  outboundText: "Approved — the revised delivery date works.",
});
