/**
 * Thin LifeOps delegation layer over `@elizaos/plugin-inbox`'s
 * {@link InboxUnsubscribeService}, which owns the email-unsubscribe back-end.
 * This domain keeps the `LifeOpsService` method surface stable (including the
 * `requestUrl` argument route callers pass) and forwards to the inbox service,
 * which resolves Gmail through the `@elizaos/plugin-google` runtime service and
 * persists to the `app_inbox.life_email_unsubscribes` table.
 *
 * The two-phase confirmation gate (`requireConfirmation`) stays in the PA route
 * layer; the inbox service trusts the pre-confirmed `userAuthorization` flag.
 */
import type {
  EmailSubscriptionScanResult,
  EmailUnsubscribeRecord,
  EmailUnsubscribeRequest,
  EmailUnsubscribeResult,
  EmailUnsubscribeScanRequest,
} from "@elizaos/plugin-inbox/inbox/email-unsubscribe-types";
import { InboxUnsubscribeService } from "@elizaos/plugin-inbox/inbox/unsubscribe-service";
import type { LifeOpsContext } from "../lifeops-context.js";
export class EmailUnsubscribeDomain {
  constructor(private readonly ctx: LifeOpsContext) {}

  async scanEmailSubscriptions(
    _requestUrl: URL,
    request: EmailUnsubscribeScanRequest = {},
  ): Promise<EmailSubscriptionScanResult> {
    return this.inboxUnsubscribeService().scanEmailSubscriptions(request);
  }

  async unsubscribeEmailSender(
    _requestUrl: URL,
    request: EmailUnsubscribeRequest,
  ): Promise<EmailUnsubscribeResult> {
    return this.inboxUnsubscribeService().unsubscribeEmailSender(request);
  }

  async listEmailUnsubscribes(limit = 100): Promise<EmailUnsubscribeRecord[]> {
    return this.inboxUnsubscribeService().listEmailUnsubscribes(limit);
  }

  summarizeEmailUnsubscribeScan(result: EmailSubscriptionScanResult): string {
    return this.inboxUnsubscribeService().summarizeEmailUnsubscribeScan(result);
  }

  private inboxUnsubscribeService(): InboxUnsubscribeService {
    return new InboxUnsubscribeService(this.ctx.runtime);
  }
}
