import type {
  EmailSubscriptionScanResult,
  EmailUnsubscribeRecord,
  EmailUnsubscribeRequest,
  EmailUnsubscribeResult,
  EmailUnsubscribeScanRequest,
} from "@elizaos/plugin-inbox/inbox/email-unsubscribe-types";
import { EmailUnsubscribeDomain } from "./domains/email-unsubscribe-service.js";
import type {
  Constructor,
  LifeOpsServiceBase,
  MixinClass,
} from "./service-mixin-core.js";

export interface LifeOpsEmailUnsubscribeService {
  scanEmailSubscriptions(
    requestUrl: URL,
    request?: EmailUnsubscribeScanRequest,
  ): Promise<EmailSubscriptionScanResult>;
  unsubscribeEmailSender(
    requestUrl: URL,
    request: EmailUnsubscribeRequest,
  ): Promise<EmailUnsubscribeResult>;
  listEmailUnsubscribes(limit?: number): Promise<EmailUnsubscribeRecord[]>;
  summarizeEmailUnsubscribeScan(result: EmailSubscriptionScanResult): string;
}

/**
 * Thin delegation layer over {@link EmailUnsubscribeDomain}. Preserves the
 * LifeOpsService method surface (including the `requestUrl` argument the route
 * callers pass) and forwards to the domain sub-service.
 *
 * @internal
 */
export function withEmailUnsubscribe<
  TBase extends Constructor<LifeOpsServiceBase>,
>(Base: TBase): MixinClass<TBase, LifeOpsEmailUnsubscribeService> {
  class LifeOpsEmailUnsubscribeMixin extends Base {
    // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
    // Public (not private) to avoid TS4094 on the re-exported mixin class.
    readonly emailUnsubscribeDomain = new EmailUnsubscribeDomain(this);

    async scanEmailSubscriptions(
      requestUrl: URL,
      request: EmailUnsubscribeScanRequest = {},
    ): Promise<EmailSubscriptionScanResult> {
      return this.emailUnsubscribeDomain.scanEmailSubscriptions(
        requestUrl,
        request,
      );
    }

    async unsubscribeEmailSender(
      requestUrl: URL,
      request: EmailUnsubscribeRequest,
    ): Promise<EmailUnsubscribeResult> {
      return this.emailUnsubscribeDomain.unsubscribeEmailSender(
        requestUrl,
        request,
      );
    }

    async listEmailUnsubscribes(
      limit = 100,
    ): Promise<EmailUnsubscribeRecord[]> {
      return this.emailUnsubscribeDomain.listEmailUnsubscribes(limit);
    }

    summarizeEmailUnsubscribeScan(result: EmailSubscriptionScanResult): string {
      return this.emailUnsubscribeDomain.summarizeEmailUnsubscribeScan(result);
    }
  }

  return LifeOpsEmailUnsubscribeMixin as unknown as MixinClass<
    TBase,
    LifeOpsEmailUnsubscribeService
  >;
}
