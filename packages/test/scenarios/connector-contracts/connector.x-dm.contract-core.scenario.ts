/** Exercises X-DM read and reply persistence through the production MESSAGE action. */
import { buildStatefulMessageConnectorScenario } from "./_stateful-message-connector.ts";
export default buildStatefulMessageConnectorScenario({
  evidenceScope: "connector-contract",
  id: "connector.x-dm.contract-core",
  title: "X DM read and exact-context reply contract",
  source: "x-dm",
  label: "X DM",
  recipientLabel: "Partner announcement DM",
  inboundText: "Can we announce the partnership tomorrow?",
  outboundText: "Yes — tomorrow works for the partnership announcement.",
});
