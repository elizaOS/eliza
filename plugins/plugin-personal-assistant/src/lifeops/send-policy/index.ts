/** Barrel for the send-policy registry: pluggable rules that decide whether an outbound message may be sent. */
export type {
  SendPolicyContext,
  SendPolicyContribution,
  SendPolicyDecision,
  SendPolicyRegistry,
  SendPolicyRegistryFilter,
} from "./contract.js";
export {
  __resetSendPolicyRegistryForTests,
  createSendPolicyRegistry,
  getSendPolicyRegistry,
  registerSendPolicyRegistry,
} from "./registry.js";
