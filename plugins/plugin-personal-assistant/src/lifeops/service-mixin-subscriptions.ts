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
  LifeOpsSubscriptionExecutor,
} from "@elizaos/plugin-finances/subscriptions-types";
import { SubscriptionsDomain } from "./domains/subscriptions-service.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";

/** @internal */
export function withSubscriptions<
  TBase extends Constructor<LifeOpsServiceBase>,
>(Base: TBase) {
  class LifeOpsSubscriptionsServiceMixin extends Base {
    // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
    // Public (not private) to avoid TS4094 on the re-exported mixin class.
    readonly subscriptionsDomain = new SubscriptionsDomain(this);

    async listSubscriptionPlaybooks(): Promise<LifeOpsSubscriptionPlaybook[]> {
      return this.subscriptionsDomain.listSubscriptionPlaybooks();
    }

    findSubscriptionPlaybookForMerchant(merchant: string): {
      key: string;
      serviceName: string;
      managementUrl: string;
      executorPreference: LifeOpsSubscriptionPlaybook["executorPreference"];
    } | null {
      return this.subscriptionsDomain.findSubscriptionPlaybookForMerchant(
        merchant,
      );
    }

    async getLatestSubscriptionAudit(): Promise<LifeOpsSubscriptionAuditSummary | null> {
      return this.subscriptionsDomain.getLatestSubscriptionAudit();
    }

    async auditSubscriptions(
      requestUrl: URL,
      request: LifeOpsSubscriptionDiscoveryRequest = {},
    ): Promise<LifeOpsSubscriptionAuditSummary> {
      return this.subscriptionsDomain.auditSubscriptions(requestUrl, request);
    }

    async getSubscriptionCancellationStatus(args: {
      cancellationId?: string | null;
      serviceName?: string | null;
      serviceSlug?: string | null;
    }): Promise<LifeOpsSubscriptionCancellationSummary | null> {
      return this.subscriptionsDomain.getSubscriptionCancellationStatus(args);
    }

    async cancelSubscription(
      request: LifeOpsSubscriptionCancellationRequest,
    ): Promise<LifeOpsSubscriptionCancellationSummary> {
      return this.subscriptionsDomain.cancelSubscription(request);
    }

    summarizeSubscriptionAudit(
      summary: LifeOpsSubscriptionAuditSummary,
    ): string {
      return this.subscriptionsDomain.summarizeSubscriptionAudit(summary);
    }

    summarizeSubscriptionCancellation(
      summary: LifeOpsSubscriptionCancellationSummary,
    ): string {
      return this.subscriptionsDomain.summarizeSubscriptionCancellation(
        summary,
      );
    }

    resolveSubscriptionIntent(text: string): {
      mode: "audit" | "cancel" | "status" | null;
      serviceName?: string;
      serviceSlug?: string;
      executor?: LifeOpsSubscriptionExecutor;
    } {
      return this.subscriptionsDomain.resolveSubscriptionIntent(text);
    }
  }

  return LifeOpsSubscriptionsServiceMixin;
}

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
