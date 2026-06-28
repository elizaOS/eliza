/**
 * LifeOps subscriptions mixin — thin delegation to {@link SubscriptionsDomain}.
 *
 * Keeps the LifeOps service surface stable for the existing route + action call
 * sites by forwarding each method to the domain sub-service. The legacy
 * `auditSubscriptions(requestUrl, request)` signature is preserved.
 */

import type { LifeOpsSubscriptionPlaybook } from "@elizaos/plugin-finances/subscriptions-playbooks";
import type {
  LifeOpsSubscriptionAuditSummary,
  LifeOpsSubscriptionCancellationRequest,
  LifeOpsSubscriptionCancellationSummary,
  LifeOpsSubscriptionDiscoveryRequest,
} from "@elizaos/plugin-finances/subscriptions-types";

/** Public surface added by {@link withSubscriptions} (a thin shim forwarding to
 * SubscriptionsDomain); listed on the LifeOpsService declaration-merge (mixin
 * composition exceeds TS inference depth). Type-only. */
export interface LifeOpsSubscriptionService {
  listSubscriptionPlaybooks(): Promise<LifeOpsSubscriptionPlaybook[]>;
  findSubscriptionPlaybookForMerchant(merchant: string): {
    key: string;
    serviceName: string;
    managementUrl: string;
    executorPreference: LifeOpsSubscriptionPlaybook["executorPreference"];
  } | null;
  getLatestSubscriptionAudit(): Promise<LifeOpsSubscriptionAuditSummary | null>;
  auditSubscriptions(
    requestUrl: URL,
    request?: LifeOpsSubscriptionDiscoveryRequest,
  ): Promise<LifeOpsSubscriptionAuditSummary>;
  getSubscriptionCancellationStatus(args: {
    cancellationId?: string | null;
    serviceName?: string | null;
    serviceSlug?: string | null;
  }): Promise<LifeOpsSubscriptionCancellationSummary | null>;
  cancelSubscription(
    request: LifeOpsSubscriptionCancellationRequest,
  ): Promise<LifeOpsSubscriptionCancellationSummary>;
  summarizeSubscriptionAudit(summary: LifeOpsSubscriptionAuditSummary): string;
  summarizeSubscriptionCancellation(
    summary: LifeOpsSubscriptionCancellationSummary,
  ): string;
}
