/**
 * Email-unsubscribe service mixin: declares the LifeOps unsubscribe service
 * surface and the mixin that composes the email-unsubscribe domain's scan and
 * unsubscribe methods onto the LifeOpsService base.
 */
import type {
  EmailSubscriptionScanResult,
  EmailUnsubscribeRecord,
  EmailUnsubscribeRequest,
  EmailUnsubscribeResult,
  EmailUnsubscribeScanRequest,
} from "@elizaos/plugin-inbox/inbox/email-unsubscribe-types";

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
