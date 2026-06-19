/**
 * InboxUnsubscribeService — the email-unsubscribe back-end.
 *
 * Standalone successor to PA's `service-mixin-email-unsubscribe.ts` (a
 * `this.`-bound `LifeOpsService` mixin). It scans Gmail for promotional senders,
 * performs the List-Unsubscribe flow (HTTP one-click / GET / mailto), optionally
 * creates a block filter and trashes existing threads, and records the outcome.
 *
 * Dependencies are resolved through seams so this plugin carries no
 * `@elizaos/plugin-personal-assistant` dependency:
 *   - Gmail access via {@link createInboxGmailGateway} (the `@elizaos/plugin-google`
 *     runtime service).
 *   - Persistence via {@link InboxUnsubscribeRepository} (raw SQL over the
 *     `app_inbox.life_email_unsubscribes` table PA registers).
 *
 * Authorization: `unsubscribeEmailSender` requires `userAuthorization === true`.
 * The two-phase confirmation gate (`requireConfirmation`) lives in the PA route
 * layer that owns the HTTP surface; this service trusts the pre-confirmed flag.
 */

import crypto from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import {
  fail,
  type LifeOpsGmailMessageSummary,
  normalizeOptionalString,
  requireNonEmptyString,
} from "@elizaos/shared";
import type {
  EmailSubscriptionScanResult,
  EmailSubscriptionSender,
  EmailUnsubscribeMethod,
  EmailUnsubscribeRecord,
  EmailUnsubscribeRequest,
  EmailUnsubscribeResult,
  EmailUnsubscribeScanRequest,
  EmailUnsubscribeStatus,
} from "./email-unsubscribe-types.ts";
import {
  createInboxGmailGateway,
  type InboxGmailGateway,
} from "./google-gmail-seam.ts";
import { InboxUnsubscribeRepository } from "./unsubscribe-repository.ts";

const DEFAULT_SCAN_MAX_MESSAGES = 200;
const MAX_SENDERS_RETURNED = 200;

function headerValue(
  headers: Record<string, unknown> | undefined,
  key: string,
): string | null {
  if (!headers) return null;
  const exact = headers[key];
  if (typeof exact === "string" && exact.trim()) return exact.trim();
  const lowered = key.toLowerCase();
  for (const [candidate, value] of Object.entries(headers)) {
    if (candidate.toLowerCase() === lowered && typeof value === "string") {
      return value.trim() || null;
    }
  }
  return null;
}

function senderDomain(email: string | null): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase() : null;
}

function listUnsubscribeEntries(value: string | null): string[] {
  if (!value) return [];
  const bracketed = [...value.matchAll(/<([^>]+)>/g)]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
  if (bracketed.length > 0) {
    return bracketed;
  }
  return value
    .split(",")
    .map((entry) => entry.trim().replace(/^<|>$/g, ""))
    .filter(Boolean);
}

function listUnsubscribeOptions(value: string | null): {
  httpUrl: string | null;
  mailto: string | null;
} {
  let httpUrl: string | null = null;
  let mailto: string | null = null;
  for (const entry of listUnsubscribeEntries(value)) {
    if (!httpUrl && /^https?:\/\//i.test(entry)) {
      httpUrl = entry;
    }
    if (!mailto && /^mailto:/i.test(entry)) {
      mailto = entry;
    }
  }
  return { httpUrl, mailto };
}

function unsubscribeMethod(args: {
  listUnsubscribe: string | null;
  listUnsubscribePost: string | null;
}): EmailSubscriptionSender["unsubscribeMethod"] {
  const options = listUnsubscribeOptions(args.listUnsubscribe);
  if (options.mailto) return "mailto";
  if (!options.httpUrl) return "manual_only";
  if (/one-click/i.test(args.listUnsubscribePost ?? "")) {
    return "http_one_click";
  }
  return "http_get";
}

function parseMailtoUnsubscribe(value: string): {
  recipient: string;
  subject: string | null;
  body: string | null;
} | null {
  const trimmed = value.trim().replace(/^<|>$/g, "");
  if (!/^mailto:/i.test(trimmed)) {
    return null;
  }
  const rest = trimmed.slice("mailto:".length);
  const [addressPart, queryPart = ""] = rest.split("?", 2);
  const recipient = decodeURIComponent(addressPart.trim());
  if (!recipient) {
    return null;
  }
  const params = new URLSearchParams(queryPart);
  const subject = params.get("subject");
  const body = params.get("body");
  return {
    recipient,
    subject: subject?.trim() ? subject : null,
    body: body?.trim() ? body : null,
  };
}

async function performHttpUnsubscribe(args: {
  url: string;
  oneClick: boolean;
}): Promise<{
  ok: boolean;
  status: number;
  finalUrl: string;
  method: Extract<EmailUnsubscribeMethod, "http_one_click" | "http_get">;
}> {
  const parsed = new URL(args.url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    fail(400, "Unsubscribe URL must be http or https.");
  }
  const response = await fetch(parsed.toString(), {
    method: args.oneClick ? "POST" : "GET",
    headers: args.oneClick
      ? { "Content-Type": "application/x-www-form-urlencoded" }
      : undefined,
    body: args.oneClick ? "List-Unsubscribe=One-Click" : undefined,
    redirect: "follow",
  });
  return {
    ok: response.ok,
    status: response.status,
    finalUrl: response.url || parsed.toString(),
    method: args.oneClick ? "http_one_click" : "http_get",
  };
}

function headersOf(
  message: LifeOpsGmailMessageSummary,
): Record<string, unknown> | undefined {
  return message.metadata && typeof message.metadata === "object"
    ? (message.metadata.headers as Record<string, unknown> | undefined)
    : undefined;
}

export interface InboxUnsubscribeServiceDeps {
  /** Override the Gmail gateway (tests inject a mock; default resolves plugin-google). */
  gmail?: InboxGmailGateway;
  /** Override the persistence repository (tests inject a fake or PGlite-backed one). */
  repository?: InboxUnsubscribeRepository;
}

export class InboxUnsubscribeService {
  private readonly gmail: InboxGmailGateway;
  private readonly repository: InboxUnsubscribeRepository;

  constructor(
    private readonly runtime: IAgentRuntime,
    deps: InboxUnsubscribeServiceDeps = {},
  ) {
    this.gmail =
      deps.gmail ?? createInboxGmailGateway(runtime, runtime.agentId);
    this.repository =
      deps.repository ?? new InboxUnsubscribeRepository(runtime);
  }

  private get agentId(): string {
    return this.runtime.agentId;
  }

  async scanEmailSubscriptions(
    request: EmailUnsubscribeScanRequest = {},
  ): Promise<EmailSubscriptionScanResult> {
    const query =
      normalizeOptionalString(request.query) ??
      "(category:promotions OR category:updates OR unsubscribe) newer_than:180d";
    const maxMessages = Math.max(
      10,
      Math.min(
        1000,
        Number.isFinite(request.maxMessages)
          ? Math.trunc(request.maxMessages as number)
          : DEFAULT_SCAN_MAX_MESSAGES,
      ),
    );
    const grant = await this.gmail.requireGmailGrant();
    const search = await this.gmail.searchGmail({
      grant,
      query,
      maxResults: maxMessages,
      includeSpamTrash: true,
    });
    const senders = new Map<string, EmailSubscriptionSender>();
    for (const message of search.messages) {
      const headers = headersOf(message);
      const listUnsubscribe = headerValue(headers, "List-Unsubscribe");
      const listUnsubscribePost = headerValue(headers, "List-Unsubscribe-Post");
      if (!message.fromEmail && !listUnsubscribe) {
        continue;
      }
      const senderEmail = message.fromEmail ?? message.from;
      const existing = senders.get(senderEmail);
      const options = listUnsubscribeOptions(listUnsubscribe);
      const method = unsubscribeMethod({
        listUnsubscribe,
        listUnsubscribePost,
      });
      if (!existing) {
        senders.set(senderEmail, {
          senderEmail,
          senderDisplay: message.from,
          senderDomain: senderDomain(senderEmail),
          listId: headerValue(headers, "List-Id"),
          messageCount: 1,
          firstSeenAt: message.receivedAt,
          latestSeenAt: message.receivedAt,
          unsubscribeMethod: method,
          unsubscribeHttpUrl: options.httpUrl,
          unsubscribeMailto: options.mailto,
          listUnsubscribePost,
          sampleSubjects: [message.subject],
          latestMessageId: message.id,
          latestThreadId: message.threadId,
          allMessageIds: [message.id],
          allThreadIds: [message.threadId],
        });
        continue;
      }
      existing.messageCount += 1;
      existing.latestSeenAt = message.receivedAt;
      existing.latestMessageId = message.id;
      existing.latestThreadId = message.threadId;
      existing.allMessageIds.push(message.id);
      existing.allThreadIds.push(message.threadId);
      if (existing.sampleSubjects.length < 5) {
        existing.sampleSubjects.push(message.subject);
      }
    }
    const senderList = [...senders.values()]
      .sort((left, right) => right.messageCount - left.messageCount)
      .slice(0, MAX_SENDERS_RETURNED);
    return {
      syncedAt: search.syncedAt ?? new Date().toISOString(),
      query,
      summary: {
        scannedMessageCount: search.messages.length,
        uniqueSenderCount: senderList.length,
        oneClickEligibleCount: senderList.filter(
          (sender) => sender.unsubscribeMethod === "http_one_click",
        ).length,
        mailtoOnlyCount: senderList.filter(
          (sender) => sender.unsubscribeMethod === "mailto",
        ).length,
        manualOnlyCount: senderList.filter(
          (sender) => sender.unsubscribeMethod === "manual_only",
        ).length,
      },
      senders: senderList,
    };
  }

  async unsubscribeEmailSender(
    request: EmailUnsubscribeRequest,
  ): Promise<EmailUnsubscribeResult> {
    const senderEmail = requireNonEmptyString(
      request.senderEmail,
      "senderEmail",
    ).toLowerCase();
    if (request.userAuthorization !== true) {
      fail(
        409,
        "Email unsubscribe requires explicit user authorization (two-phase confirmation).",
      );
    }

    const grant = await this.gmail.requireGmailGrant();
    const accountId =
      grant.connectorAccountId ??
      fail(
        409,
        "Google connector account id is missing. Reconnect Google through connector account management.",
      );
    const scan = await this.scanEmailSubscriptions({
      query: `from:${senderEmail} (unsubscribe OR list:*) newer_than:365d`,
      maxMessages: 100,
    });
    const sender =
      scan.senders.find(
        (candidate) => candidate.senderEmail.toLowerCase() === senderEmail,
      ) ??
      ({
        senderEmail,
        senderDisplay: senderEmail,
        senderDomain: senderDomain(senderEmail),
        listId: normalizeOptionalString(request.listId) ?? null,
        messageCount: 0,
        firstSeenAt: new Date().toISOString(),
        latestSeenAt: new Date().toISOString(),
        unsubscribeMethod: "manual_only",
        unsubscribeHttpUrl: null,
        unsubscribeMailto: null,
        listUnsubscribePost: null,
        sampleSubjects: [],
        latestMessageId: "",
        latestThreadId: "",
        allMessageIds: [],
        allThreadIds: [],
      } satisfies EmailSubscriptionSender);

    let method: EmailUnsubscribeMethod = sender.unsubscribeMethod;
    let status: EmailUnsubscribeStatus = "manual_required";
    let httpStatusCode: number | null = null;
    let httpFinalUrl: string | null = null;
    let filterCreated = false;
    let filterId: string | null = null;
    let threadsTrashed = 0;
    let errorMessage: string | null = null;

    try {
      if (sender.unsubscribeHttpUrl) {
        const http = await performHttpUnsubscribe({
          url: sender.unsubscribeHttpUrl,
          oneClick: sender.unsubscribeMethod === "http_one_click",
        });
        method = http.method;
        httpStatusCode = http.status;
        httpFinalUrl = http.finalUrl;
        status = http.ok ? "succeeded" : "failed";
        if (!http.ok) {
          errorMessage = `HTTP unsubscribe returned ${http.status}.`;
        }
      } else if (sender.unsubscribeMailto) {
        const mailto = parseMailtoUnsubscribe(sender.unsubscribeMailto);
        if (!mailto) {
          fail(400, "List-Unsubscribe mailto target is invalid.");
        }
        await this.gmail.sendMailtoUnsubscribeEmail(accountId, mailto);
        method = "mailto";
        status = "succeeded";
      }

      if (request.blockAfter || request.trashExisting) {
        if (!grant.capabilities.includes("google.gmail.manage")) {
          fail(
            403,
            "Blocking or trashing subscription email requires Gmail manage access.",
          );
        }
      }

      if (request.blockAfter) {
        const filter = await this.gmail.createGmailFilterForSender(
          accountId,
          senderEmail,
        );
        filterCreated = true;
        filterId = filter.filterId;
        status = "succeeded";
      }

      if (request.trashExisting) {
        const threadIds = [...new Set(sender.allThreadIds.filter(Boolean))];
        for (const threadId of threadIds) {
          await this.gmail.trashGmailThread(accountId, threadId);
          threadsTrashed += 1;
        }
        if (threadIds.length > 0) {
          status = "succeeded";
        }
      }

      if (
        status === "manual_required" &&
        !sender.unsubscribeHttpUrl &&
        !sender.unsubscribeMailto &&
        !request.blockAfter &&
        !request.trashExisting
      ) {
        status = "blocked_no_mechanism";
      }
    } catch (cause) {
      status = "failed";
      errorMessage =
        cause instanceof Error && cause.message.trim()
          ? cause.message
          : String(cause);
    }

    const now = new Date().toISOString();
    const record: EmailUnsubscribeRecord = {
      id: crypto.randomUUID(),
      agentId: this.agentId,
      senderEmail,
      senderDisplay: sender.senderDisplay,
      senderDomain: sender.senderDomain,
      listId: normalizeOptionalString(request.listId) ?? sender.listId,
      method,
      status,
      httpStatusCode,
      httpFinalUrl,
      filterCreated,
      filterId,
      threadsTrashed,
      errorMessage,
      metadata: {
        connectorAccountId: accountId,
        grantId: grant.id,
        messageCount: sender.messageCount,
        latestMessageId: sender.latestMessageId,
        latestThreadId: sender.latestThreadId,
        blockAfter: request.blockAfter === true,
        trashExisting: request.trashExisting === true,
      },
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.createEmailUnsubscribe(record);
    return { record };
  }

  async listEmailUnsubscribes(limit = 100): Promise<EmailUnsubscribeRecord[]> {
    return this.repository.listEmailUnsubscribes({
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
      `Found ${result.summary.uniqueSenderCount} senders across ${result.summary.scannedMessageCount} messages.`,
      ...top,
    ].join("\n");
  }
}
