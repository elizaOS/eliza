/** Proves Twilio SMS replay suppression through the production MESSAGE action. */
import { buildStatefulMessageConnectorScenario } from "./_stateful-message-connector.ts";
export default buildStatefulMessageConnectorScenario({
  evidenceScope: "connector-contract",
  id: "connector.twilio-sms.contract-retry-idempotent",
  title: "Twilio SMS duplicate-replay suppression contract",
  source: "sms",
  label: "Twilio SMS",
  recipientLabel: "+15555550101",
  inboundText: "Are you still on time for lunch?",
  outboundText: "Running 10 minutes late for lunch.",
  replay: true,
  failFirstSend: true,
});
