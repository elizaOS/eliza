// @ts-nocheck — mixin: type safety is enforced on the composed class
import type {
  LifeOpsConnectorGrant,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
} from "@elizaos/shared/contracts/lifeops";
import crypto from "node:crypto";
import {
  createGmailFilterForSender,
  extractListUnsubscribeOptions,
  fetchGmailSubscriptionHeaders,
  parseMailtoUnsubscribe,
  performGmailHttpUnsubscribe,
  sendMailtoUnsubscribeEmail,
  trashGmailThread,
  type GmailSubscriptionMessageHeaders,
} from "./email-unsubscribe-gmail.js";
import type {
  EmailSubscriptionScanResult,
  EmailSubscriptionSender,
  EmailUnsubscribeMethod,
  EmailUnsubscribeRecord,
  EmailUnsubscribeRequest,
  EmailUnsubscribeResult,
  EmailUnsubscribeScanRequest,
  EmailUnsubscribeStatus,
} from "./email-unsubscribe-types.js";
import { ensureFreshGoogleAccessToken } from "./google-oauth.js";
import { hasGoogleGmailManageCapability } from "./service-normalize-calendar.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";
import {
  normalizeOptionalConnectorMode,
  normalizeOptionalConnectorSide,
} from "./service-normalize-connector.js";
import {
  fail,
  normalizeOptionalBoolean,
  normalizeOptionalString,
  requireNonEmptyString,
} from "./service-normalize.js";

const DEFAULT_SCAN_MAX_MESSAGES = 200;
const MAX_SENDERS_RETURNED = 200;
const MAX_SAMPLE_SUBJECTS = 5;

function pickUnsubscribeMethod(args: {
  httpUrl: string | null;
  mailto: string | null;
  oneClickPost: boolean;
}): EmailUnsubscribeMethod {
  if (args.httpUrl && args.oneClickPost) {
    return "http_one_click";
  }
  if (args.httpUrl) {
    return "http_post";
  }
  if (args.mailto) {
    return "mailto";
  }
  return "manual_only";
}

function deriveSenderDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) {
    return null;
  }
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain.length > 0 ? domain : null;
}

function aggregateSenders(
  headers: readonly GmailSubscriptionMessageHeaders[],
): EmailSubscriptionSender[] {
  const senders = new Map<string, EmailSubscriptionSender>();
  for (const header of headers) {
    if (!header.fromEmail) {
      continue;
    }
    const key = header.fromEmail;
    const existing = senders.get(key);
    const options = extractListUnsubscribeOptions(header);
    const method = pickUnsubscribeMethod(options);
    if (!existing) {
      senders.set(key, {
        senderEmail: header.fromEmail,
        senderDisplay: header.fromDisplay,
        senderDomain: deriveSenderDomain(header.fromEmail),
        listId: header.listId,
        messageCount: 1,
        firstSeenAt: header.receivedAt,
        latestSeenAt: header.receivedAt,
        unsubscribeMethod: method,
        unsubscribeHttpUrl: options.httpUrl,
        unsubscribeMailto: options.mailto,
        listUnsubscribePost: header.listUnsubscribePost,
        sampleSubjects: [header.subject],
        latestMessageId: header.messageId,
        latestThreadId: header.threadId,
        allMessageIds: [header.messageId],
        allThreadIds: [header.threadId],
      });
      continue;
    }
    existing.messageCount += 1;
    existing.allMessageIds.push(header.messageId);
    existing.allThreadIds.push(header.threadId);
    if (header.receivedAt < existing.firstSeenAt) {
      existing.firstSeenAt = header.receivedAt;
    }
    if (header.receivedAt > existing.latestSeenAt) {
      existing.latestSeenAt = header.receivedAt;
      existing.latestMessageId = header.messageId;
      existing.latestThreadId = header.threadId;
    }
    if (
      !existing.unsubscribeHttpUrl &&
      options.httpUrl
    ) {
      existing.unsubscribeHttpUrl = options.httpUrl;
    }
    if (!existing.unsubscribeMailto && options.mailto) {
      existing.unsubscribeMailto = options.mailto;
    }
    if (!existing.listUnsubscribePost && header.listUnsubscribePost) {
      existing.listUnsubscribePost = header.listUnsubscribePost;
    }
    const resolvedMethod = pickUnsubscribeMethod({
      httpUrl: existing.unsubscribeHttpUrl,
      mailto: existing.unsubscribeMailto,
      oneClickPost: /one-click/i.test(existing.listUnsubscribePost ?? ""),
    });
    existing.unsubscribeMethod = resolvedMethod;
    if (
      existing.sampleSubjects.length < MAX_SAMPLE_SUBJECTS &&
      !existing.sampleSubjects.includes(header.subject)
    ) {
      existing.sampleSubjects.push(header.subject);
    }
  }

  return Array.from(senders.values())
    .sort((a, b) => {
      if (a.messageCount !== b.messageCount) {
        return b.messageCount - a.messageCount;
      }
      return b.latestSeenAt.localeCompare(a.latestSeenAt);
    })
    .slice(0, MAX_SENDERS_RETURNED);
}

/** @internal */
export function withEmailUnsubscribe<
  TBase extends Constructor<LifeOpsServiceBase>,
>(Base: TBase) {
  class LifeOpsEmailUnsubscribeMixin extends Base {
    async requireGmailManageGrant(args: {
      requestUrl: URL;
      mode?: LifeOpsConnectorMode;
      side?: LifeOpsConnectorSide;
      grantId?: string;
    }): Promise<LifeOpsConnectorGrant> {
      const grant = await this.requireGoogleGmailGrant(
        args.requestUrl,
        args.mode,
        args.side,
        args.grantId,
      );
      if (!hasGoogleGmailManageCapability(grant)) {
        fail(
          403,
          "Gmail auto-unsubscribe requires gmail.modify + gmail.settings.basic access. Reconnect Google and grant the 'Manage subscriptions' capability.",
        );
      }
      return grant;
    }

    async accessTokenForGrant(
      grant: LifeOpsConnectorGrant,
    ): Promise<string> {
      const tokenRef =
        grant.tokenRef ?? fail(409, "Google Gmail token reference is missing.");
      const token = await ensureFreshGoogleAccessToken(tokenRef);
      return token.accessToken;
    }

    async scanEmailSubscriptions(
      requestUrl: URL,
      request: EmailUnsubscribeScanRequest = {},
    ): Promise<EmailSubscriptionScanResult> {
      const grant = await this.requireGoogleGmailGrant(
        requestUrl,
        undefined,
        undefined,
        undefined,
      );
      const accessToken = await this.accessTokenForGrant(grant);
      const query =
        normalizeOptionalString(request.query) ??
        "(category:promotions OR category:updates OR list:* OR unsubscribe) newer_than:180d";
      const maxMessages = Math.max(
        10,
        Math.min(
          1000,
          Number.isFinite(request.maxMessages)
            ? Math.trunc(request.maxMessages as number)
            : DEFAULT_SCAN_MAX_MESSAGES,
        ),
      );
      const headers = await fetchGmailSubscriptionHeaders({
        accessToken,
        query,
        maxMessages,
      });
      const senders = aggregateSenders(headers);
      const syncedAt = new Date().toISOString();
      return {
        syncedAt,
        query,
        summary: {
          scannedMessageCount: headers.length,
          uniqueSenderCount: senders.length,
          oneClickEligibleCount: senders.filter(
            (sender) => sender.unsubscribeMethod === "http_one_click",
          ).length,
          mailtoOnlyCount: senders.filter(
            (sender) => sender.unsubscribeMethod === "mailto",
          ).length,
          manualOnlyCount: senders.filter(
            (sender) => sender.unsubscribeMethod === "manual_only",
          ).length,
        },
        senders,
      };
    }

    async unsubscribeEmailSender(
      requestUrl: URL,
      request: EmailUnsubscribeRequest,
    ): Promise<EmailUnsubscribeResult> {
      const senderEmail = requireNonEmptyString(
        request.senderEmail,
        "senderEmail",
      )
        .trim()
        .toLowerCase();
      const confirmed =
        normalizeOptionalBoolean(request.confirmed, "confirmed") ?? false;
      if (!confirmed) {
        fail(409, "Email unsubscribe requires explicit confirmation.");
      }
      const blockAfter =
        normalizeOptionalBoolean(request.blockAfter, "blockAfter") ?? true;
      const trashExisting =
        normalizeOptionalBoolean(request.trashExisting, "trashExisting") ??
        false;

      const grant = await this.requireGmailManageGrant({ requestUrl });
      const accessToken = await this.accessTokenForGrant(grant);

      const headers = await fetchGmailSubscriptionHeaders({
        accessToken,
        query: `from:${senderEmail}`,
        maxMessages: 25,
      });
      const senderHeaders = headers.filter(
        (header) => header.fromEmail === senderEmail,
      );
      if (senderHeaders.length === 0) {
        fail(
          404,
          `No recent Gmail messages from ${senderEmail} were found to unsubscribe.`,
        );
      }
      const senders = aggregateSenders(senderHeaders);
      const sender = senders.find(
        (candidate) => candidate.senderEmail === senderEmail,
      );
      if (!sender) {
        fail(
          404,
          `Unable to resolve subscription details for ${senderEmail}.`,
        );
      }

      let status: EmailUnsubscribeStatus = "blocked_no_mechanism";
      let httpStatusCode: number | null = null;
      let httpFinalUrl: string | null = null;
      let errorMessage: string | null = null;
      let method: EmailUnsubscribeMethod = sender.unsubscribeMethod;

      if (sender.unsubscribeHttpUrl) {
        try {
          const result = await performGmailHttpUnsubscribe({
            url: sender.unsubscribeHttpUrl,
            preferOneClickPost: method === "http_one_click",
          });
          httpStatusCode = result.status;
          httpFinalUrl = result.finalUrl;
          status = result.ok ? "succeeded" : "failed";
          if (!result.ok) {
            errorMessage = `HTTP ${result.status} ${result.statusText}`;
          }
        } catch (error) {
          status = "failed";
          errorMessage =
            error instanceof Error ? error.message : String(error);
        }
      } else if (sender.unsubscribeMailto) {
        const parsed = parseMailtoUnsubscribe(sender.unsubscribeMailto);
        if (!parsed) {
          status = "failed";
          errorMessage = "Could not parse mailto: unsubscribe header.";
        } else {
          try {
            await sendMailtoUnsubscribeEmail({
              accessToken,
              mailto: parsed,
            });
            status = "succeeded";
            method = "mailto";
          } catch (error) {
            status = "failed";
            errorMessage =
              error instanceof Error ? error.message : String(error);
          }
        }
      } else {
        status = "manual_required";
        method = "manual_only";
        errorMessage =
          "No List-Unsubscribe header found. Manual unsubscribe required via the sender's website.";
      }

      let filterCreated = false;
      let filterId: string | null = null;
      if (blockAfter && (status === "succeeded" || status === "manual_required")) {
        try {
          const filterResult = await createGmailFilterForSender({
            accessToken,
            fromAddress: senderEmail,
            trash: true,
          });
          filterCreated = true;
          filterId = filterResult.filterId;
        } catch (error) {
          this.logLifeOpsWarn(
            "email_unsubscribe_filter",
            `Filter creation failed for ${senderEmail}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      let threadsTrashed = 0;
      if (trashExisting && (status === "succeeded" || filterCreated)) {
        const uniqueThreadIds = Array.from(new Set(sender.allThreadIds));
        for (const threadId of uniqueThreadIds) {
          try {
            await trashGmailThread({ accessToken, threadId });
            threadsTrashed += 1;
          } catch (error) {
            this.logLifeOpsWarn(
              "email_unsubscribe_trash",
              `Failed to trash thread ${threadId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      }

      const record: EmailUnsubscribeRecord = {
        id: crypto.randomUUID(),
        agentId: this.agentId(),
        senderEmail,
        senderDisplay: sender.senderDisplay,
        senderDomain: sender.senderDomain,
        listId: sender.listId ?? normalizeOptionalString(request.listId) ?? null,
        method,
        status,
        httpStatusCode,
        httpFinalUrl,
        filterCreated,
        filterId,
        threadsTrashed,
        errorMessage,
        metadata: {
          messageCount: sender.messageCount,
          sampleSubjects: sender.sampleSubjects,
          unsubscribeHttpUrl: sender.unsubscribeHttpUrl,
          unsubscribeMailto: sender.unsubscribeMailto,
          listUnsubscribePost: sender.listUnsubscribePost,
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await this.repository.createEmailUnsubscribe(record);
      return { record };
    }

    async listEmailUnsubscribes(
      limit = 100,
    ): Promise<EmailUnsubscribeRecord[]> {
      return this.repository.listEmailUnsubscribes(this.agentId(), {
        limit: Math.max(1, Math.min(500, limit)),
      });
    }

    summarizeEmailUnsubscribeScan(result: EmailSubscriptionScanResult): string {
      if (result.senders.length === 0) {
        return `No active promotional senders found in the last scan (${result.summary.scannedMessageCount} messages checked).`;
      }
      const top = result.senders.slice(0, 5).map((sender) => {
        return `- ${sender.senderDisplay} <${sender.senderEmail}>: ${sender.messageCount} msgs, ${sender.unsubscribeMethod}`;
      });
      return [
        `Found ${result.summary.uniqueSenderCount} subscription senders from ${result.summary.scannedMessageCount} messages.`,
        `${result.summary.oneClickEligibleCount} support one-click unsubscribe; ${result.summary.mailtoOnlyCount} need a mailto; ${result.summary.manualOnlyCount} require manual unsubscribe.`,
        ...top,
      ].join("\n");
    }

    summarizeEmailUnsubscribeResult(result: EmailUnsubscribeResult): string {
      const record = result.record;
      const blocked = record.filterCreated
        ? " Gmail filter created to auto-trash future mail from this sender."
        : "";
      const trashed =
        record.threadsTrashed > 0
          ? ` ${record.threadsTrashed} existing thread${record.threadsTrashed === 1 ? "" : "s"} trashed.`
          : "";
      switch (record.status) {
        case "succeeded":
          return `Unsubscribed from ${record.senderDisplay} via ${record.method}.${blocked}${trashed}`;
        case "manual_required":
          return `${record.senderDisplay} has no unsubscribe header. Manual unsubscribe is required via the sender's website.${blocked}${trashed}`;
        case "blocked_no_mechanism":
          return `Unsubscribe blocked for ${record.senderDisplay}: no unsubscribe mechanism available.`;
        case "failed":
        default:
          return `Unsubscribe from ${record.senderDisplay} failed${record.errorMessage ? `: ${record.errorMessage}` : "."}`;
      }
    }
  }

  return LifeOpsEmailUnsubscribeMixin;
}
