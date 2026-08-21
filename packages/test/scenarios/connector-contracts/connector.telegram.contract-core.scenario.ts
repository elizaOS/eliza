/** Exercises Telegram-thread read and reply persistence through the production MESSAGE action. */
import { buildStatefulMessageConnectorScenario } from "./_stateful-message-connector.ts";
export default buildStatefulMessageConnectorScenario({
  evidenceScope: "connector-contract",
  id: "connector.telegram.contract-core",
  title: "Telegram chat read and exact-context reply contract",
  source: "telegram",
  label: "Telegram",
  recipientLabel: "Family travel chat",
  inboundText: "What time does the flight land?",
  outboundText: "The flight lands at 6:40 PM local time.",
});
