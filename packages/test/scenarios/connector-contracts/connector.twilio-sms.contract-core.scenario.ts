/** Exercises Twilio SMS read and exact-target delivery through the production MESSAGE action. */
import { buildStatefulMessageConnectorScenario } from "./_stateful-message-connector.ts";
export default buildStatefulMessageConnectorScenario({
  evidenceScope: "connector-contract",
  id: "connector.twilio-sms.contract-core",
  title: "Twilio SMS exact-target delivery contract",
  source: "sms",
  label: "Twilio SMS",
  recipientLabel: "+15555550101",
  inboundText: "Are you still on time for lunch?",
  outboundText: "Running 10 minutes late for lunch.",
});
