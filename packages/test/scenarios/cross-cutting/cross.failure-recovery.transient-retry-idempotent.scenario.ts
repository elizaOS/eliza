/** Proves a real transient connector rejection, successful retry, and idempotent replay through the production MESSAGE action. */

import { buildStatefulMessageConnectorScenario } from "../connector-contracts/_stateful-message-connector.ts";

export default buildStatefulMessageConnectorScenario({
  evidenceScope: "connector-contract",
  id: "cross.failure-recovery.transient-retry-idempotent",
  title: "Transient delivery failure retries once without duplicate effect",
  domain: "cross-cutting",
  source: "scenario_retry",
  label: "scenario transient provider",
  recipientLabel: "Scenario Retry Recipient",
  inboundText: "The deterministic retry thread is ready.",
  outboundText: "Commit the retry-safe delivery exactly once.",
  replay: true,
  failFirstSend: true,
  additionalTags: ["cross-cutting", "failure-recovery", "retry", "idempotency"],
  description:
    "The stateful provider rejects the first production MESSAGE attempt before acceptance, accepts the retry under the same stable request identity, and returns the original receipt on replay. The fixture ledger and durable outbound memory must show exactly one provider-side effect.",
});
