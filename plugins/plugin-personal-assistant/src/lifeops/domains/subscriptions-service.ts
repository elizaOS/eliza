// Implements a LifeOps domain service behind the assistant orchestration layer.
import { SubscriptionsService } from "@elizaos/plugin-finances/services/subscriptions-service";
import type { LifeOpsSubscriptionPlaybook } from "@elizaos/plugin-finances/subscriptions-playbooks";
import type {
  LifeOpsSubscriptionAuditSummary,
  LifeOpsSubscriptionCancellationRequest,
  LifeOpsSubscriptionCancellationSummary,
  LifeOpsSubscriptionDiscoveryRequest,
  LifeOpsSubscriptionExecutor,
} from "@elizaos/plugin-finances/subscriptions-types";
import type { LifeOpsContext } from "../lifeops-context.js";

/**
 * Subscriptions audit / cancellation reads + mutations, delegated to
 * `@elizaos/plugin-finances` (`SubscriptionsService`), which owns the finance
 * tables and reaches Gmail + the browser bridge through runtime-service seams.
 * Keeps the LifeOps service surface stable for existing route + action call
 * sites. The legacy `auditSubscriptions(requestUrl, request)` signature is
 * preserved; the `requestUrl` argument is no longer needed (the finances Gmail
 * seam resolves the connector account directly) and is ignored.
 */
export class SubscriptionsDomain {
  constructor(private readonly ctx: LifeOpsContext) {}

  async listSubscriptionPlaybooks(): Promise<LifeOpsSubscriptionPlaybook[]> {
    return this.service().listSubscriptionPlaybooks();
  }

  findSubscriptionPlaybookForMerchant(merchant: string): {
    key: string;
    serviceName: string;
    managementUrl: string;
    executorPreference: LifeOpsSubscriptionPlaybook["executorPreference"];
  } | null {
    return this.service().findSubscriptionPlaybookForMerchant(merchant);
  }

  async getLatestSubscriptionAudit(): Promise<LifeOpsSubscriptionAuditSummary | null> {
    return this.service().getLatestSubscriptionAudit();
  }

  async auditSubscriptions(
    _requestUrl: URL,
    request: LifeOpsSubscriptionDiscoveryRequest = {},
  ): Promise<LifeOpsSubscriptionAuditSummary> {
    return this.service().auditSubscriptions(request);
  }

  async getSubscriptionCancellationStatus(args: {
    cancellationId?: string | null;
    serviceName?: string | null;
    serviceSlug?: string | null;
  }): Promise<LifeOpsSubscriptionCancellationSummary | null> {
    return this.service().getSubscriptionCancellationStatus(args);
  }

  async cancelSubscription(
    request: LifeOpsSubscriptionCancellationRequest,
  ): Promise<LifeOpsSubscriptionCancellationSummary> {
    return this.service().cancelSubscription(request);
  }

  summarizeSubscriptionAudit(summary: LifeOpsSubscriptionAuditSummary): string {
    return this.service().summarizeSubscriptionAudit(summary);
  }

  summarizeSubscriptionCancellation(
    summary: LifeOpsSubscriptionCancellationSummary,
  ): string {
    return this.service().summarizeSubscriptionCancellation(summary);
  }

  resolveSubscriptionIntent(text: string): {
    mode: "audit" | "cancel" | "status" | null;
    serviceName?: string;
    serviceSlug?: string;
    executor?: LifeOpsSubscriptionExecutor;
  } {
    return this.service().resolveSubscriptionIntent(text);
  }

  private service(): SubscriptionsService {
    return new SubscriptionsService(this.ctx.runtime, {
      ownerEntityId: this.ctx.explicitOwnerEntityIdValue,
    });
  }
}
