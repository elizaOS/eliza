/** Exposes transaction policy evaluation, aggregation and approval contracts for the identity service. */
export type {
  AuditHook,
  PolicyEngineOptions,
  PolicyEvaluatedEvent,
  PolicyEvaluationContext,
  PolicySimulationRequest,
  ProxySimulationRequest,
  TransactionSimulationRequest,
} from "./engine";
export { PolicyEngine } from "./engine";
export type { EvaluatorContext } from "./evaluators";
export { evaluatePolicy } from "./evaluators";
export type {
  AggregationEvaluatorContext,
  AggregationLookup,
  AggregationQuery,
  AggregationSnapshot,
} from "./evaluators/aggregation";
export {
  aggregationLookupFromMap,
  aggregationQueriesForPolicies,
  aggregationQueryKey,
  evaluateAggregation,
  NAMED_WINDOW_SECONDS,
  resolveScopeKey,
  resolveWindowSeconds,
} from "./evaluators/aggregation";
export type { LeverageCapContext } from "./evaluators/leverage-cap";
export { evaluateLeverageCap } from "./evaluators/leverage-cap";
export type { ReputationScalingConfig } from "./evaluators/reputation-scaling";
export {
  computeScaledLimit,
  evaluateReputationScaling,
} from "./evaluators/reputation-scaling";
export type { ReputationThresholdConfig } from "./evaluators/reputation-threshold";
export { evaluateReputationThreshold } from "./evaluators/reputation-threshold";
export type { VenueAllowlistContext } from "./evaluators/venue-allowlist";
export { evaluateVenueAllowlist } from "./evaluators/venue-allowlist";
export type { ManualApprovalSignal } from "./manual-approval";
export { resultRequiresManualApproval } from "./manual-approval";
export type { RegisteredPolicyEvaluator } from "./policy-rule-registry";
export {
  CORE_POLICY_RULE_TYPES,
  evaluateRegisteredPolicy,
  PolicyRuleRegistry,
  PolicyRuleRegistryError,
  policyRuleRegistry,
} from "./policy-rule-registry";
export type { ReputationInput } from "./reputation";
export { calculateInternalReputation } from "./reputation";
