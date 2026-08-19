/** Exercises Slack-thread read and reply persistence through the production MESSAGE action. */
import { buildStatefulMessageConnectorScenario } from "./_stateful-message-connector.ts";
export default buildStatefulMessageConnectorScenario({
  evidenceScope: "connector-contract",
  id: "connector.slack.contract-core",
  title: "Slack thread read and exact-context reply contract",
  source: "slack",
  label: "Slack",
  recipientLabel: "Launch channel thread",
  inboundText: "Who owns the final launch review?",
  outboundText: "I own the final launch review and will post the result here.",
});
