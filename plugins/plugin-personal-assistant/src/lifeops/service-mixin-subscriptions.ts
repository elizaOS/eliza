/**
 * LifeOps subscriptions mixin — thin delegation to the finances back-end.
 *
 * The subscription audit / cancellation logic moved to
 * `@elizaos/plugin-finances` (`SubscriptionsService`), which owns the finance
 * tables and reaches Gmail + the browser bridge through runtime-service seams.
 * This mixin keeps the LifeOps service surface stable for the existing route +
 * action call sites by forwarding each method to a `SubscriptionsService`
 * constructed against the same runtime + owner. The legacy
 * `auditSubscriptions(requestUrl, request)` signature is preserved; the
 * `requestUrl` argument is no longer needed (the finances Gmail seam resolves
 * the connector account directly) and is ignored.
 */

import {
  type LifeOpsSubscriptionAuditSummary,
  type LifeOpsSubscriptionCancellationRequest,
  type LifeOpsSubscriptionCancellationSummary,
  type LifeOpsSubscriptionDiscoveryRequest,
  type LifeOpsSubscriptionExecutor,
  type LifeOpsSubscriptionPlaybook,
  SubscriptionsService,
} from "@elizaos/plugin-finances";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";

function subscriptionsServiceFor(
  service: LifeOpsServiceBase,
): SubscriptionsService {
  return new SubscriptionsService(service.runtime, {
    ownerEntityId: service.explicitOwnerEntityIdValue,
  });
}

/** @internal */
export function withSubscriptions<
  TBase extends Constructor<LifeOpsServiceBase>,
>(Base: TBase) {
  class LifeOpsSubscriptionsServiceMixin extends Base {
    async listSubscriptionPlaybooks(): Promise<LifeOpsSubscriptionPlaybook[]> {
      return subscriptionsServiceFor(this).listSubscriptionPlaybooks();
    }

    findSubscriptionPlaybookForMerchant(merchant: string): {
      key: string;
      serviceName: string;
      managementUrl: string;
      executorPreference: LifeOpsSubscriptionPlaybook["executorPreference"];
    } | null {
      return subscriptionsServiceFor(this).findSubscriptionPlaybookForMerchant(
        merchant,
      );
    }

    async getLatestSubscriptionAudit(): Promise<LifeOpsSubscriptionAuditSummary | null> {
      return subscriptionsServiceFor(this).getLatestSubscriptionAudit();
    }

    async auditSubscriptions(
      _requestUrl: URL,
      request: LifeOpsSubscriptionDiscoveryRequest = {},
    ): Promise<LifeOpsSubscriptionAuditSummary> {
      return subscriptionsServiceFor(this).auditSubscriptions(request);
    }

    async getSubscriptionCancellationStatus(args: {
      cancellationId?: string | null;
      serviceName?: string | null;
      serviceSlug?: string | null;
    }): Promise<LifeOpsSubscriptionCancellationSummary | null> {
      return subscriptionsServiceFor(this).getSubscriptionCancellationStatus(
        args,
      );
    }

    async cancelSubscription(
      request: LifeOpsSubscriptionCancellationRequest,
    ): Promise<LifeOpsSubscriptionCancellationSummary> {
      return subscriptionsServiceFor(this).cancelSubscription(request);
    }

    summarizeSubscriptionAudit(
      summary: LifeOpsSubscriptionAuditSummary,
    ): string {
      return subscriptionsServiceFor(this).summarizeSubscriptionAudit(summary);
    }

    summarizeSubscriptionCancellation(
      summary: LifeOpsSubscriptionCancellationSummary,
    ): string {
      return subscriptionsServiceFor(this).summarizeSubscriptionCancellation(
        summary,
      );
    }

    resolveSubscriptionIntent(text: string): {
      mode: "audit" | "cancel" | "status" | null;
      serviceName?: string;
      serviceSlug?: string;
      executor?: LifeOpsSubscriptionExecutor;
    } {
      return subscriptionsServiceFor(this).resolveSubscriptionIntent(text);
    }
  }

  return LifeOpsSubscriptionsServiceMixin;
}
