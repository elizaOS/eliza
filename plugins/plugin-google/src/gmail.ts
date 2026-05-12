import type { gmail_v1 } from "googleapis";
import type { GoogleApiClientFactory } from "./client-factory.js";
import type {
  GoogleAccountRef,
  GoogleEmailAddress,
  GoogleGmailBulkOperation,
  GoogleGmailFilterCreateResult,
  GoogleGmailMessageDetail,
  GoogleGmailMessageSummary,
  GoogleGmailSendResult,
  GoogleGmailSubscriptionMessageHeaders,
  GoogleGmailUnrespondedThread,
  GoogleMessageSummary,
  GoogleParsedMailto,
  GoogleSendEmailInput,
} from "./types.js";

const MESSAGE_METADATA_HEADERS = ["Subject", "From", "To", "Date"];
const GMAIL_METADATA_HEADERS = [
  "Subject",
  "From",
  "To",
  "Cc",
  "Date",
  "Reply-To",
  "Message-Id",
  "References",
  "List-Unsubscribe",
  "List-Unsubscribe-Post",
  "List-Id",
  "Precedence",
  "Auto-Submitted",
] as const;
const SUBSCRIPTION_SCAN_QUERY_DEFAULT =
  "(category:promotions OR category:updates OR list:* OR unsubscribe) newer_than:180d";
const GMAIL_LIST_PAGE_SIZE = 500;
const GMAIL_METADATA_CONCURRENCY = 25;
const MAX_GMAIL_RESULTS = 1000;

export class GoogleGmailClient {
  constructor(private readonly clientFactory: GoogleApiClientFactory) {}

  async searchMessages(
    params: GoogleAccountRef & { query: string; limit?: number }
  ): Promise<GoogleMessageSummary[]> {
    const gmail = await this.clientFactory.gmail(params, ["gmail.read"], "gmail.searchMessages");
    const response = await gmail.users.messages.list({
      userId: "me",
      q: params.query,
      maxResults: params.limit ?? 10,
    });

    const messages = response.data.messages ?? [];
    return Promise.all(
      messages
        .filter((message) => message.id)
        .map((message) =>
          this.getMessageWithClient(gmail, {
            accountId: params.accountId,
            messageId: message.id as string,
            includeBody: false,
          })
        )
    );
  }

  async getMessage(
    params: GoogleAccountRef & { messageId: string; includeBody?: boolean }
  ): Promise<GoogleMessageSummary> {
    const gmail = await this.clientFactory.gmail(params, ["gmail.read"], "gmail.getMessage");
    return this.getMessageWithClient(gmail, params);
  }

  async sendEmail(params: GoogleSendEmailInput): Promise<{ id: string; threadId?: string }> {
    const gmail = await this.clientFactory.gmail(params, ["gmail.send"], "gmail.sendEmail");
    const raw = encodeMessage(params);
    const response = await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw,
        threadId: params.threadId,
      },
    });

    return {
      id: response.data.id ?? "",
      threadId: response.data.threadId ?? undefined,
    };
  }

  async listGmailTriageMessages(
    params: GoogleAccountRef & { selfEmail?: string | null; maxResults?: number }
  ): Promise<GoogleGmailMessageSummary[]> {
    return this.searchGmailMessages({
      accountId: params.accountId,
      selfEmail: params.selfEmail,
      maxResults: params.maxResults,
      query: "in:inbox",
    });
  }

  async searchGmailMessages(
    params: GoogleAccountRef & {
      query: string;
      selfEmail?: string | null;
      maxResults?: number;
      includeSpamTrash?: boolean;
    }
  ): Promise<GoogleGmailMessageSummary[]> {
    const gmail = await this.clientFactory.gmail(
      params,
      ["gmail.read"],
      "gmail.searchGmailMessages"
    );
    const maxResults = normalizedLimit(params.maxResults, 20, MAX_GMAIL_RESULTS);
    const messages: GoogleGmailMessageSummary[] = [];
    let pageToken: string | undefined;

    while (messages.length < maxResults) {
      const response = await gmail.users.messages.list({
        userId: "me",
        q: params.query,
        includeSpamTrash: params.includeSpamTrash === true,
        maxResults: Math.min(GMAIL_LIST_PAGE_SIZE, maxResults - messages.length),
        pageToken,
      });
      const pageMessages = await mapWithConcurrency(
        response.data.messages ?? [],
        GMAIL_METADATA_CONCURRENCY,
        async (messageRef) => {
          const messageId = messageRef.id?.trim();
          if (!messageId) {
            return null;
          }
          return this.getRichMessageWithClient(gmail, {
            accountId: params.accountId,
            messageId,
            selfEmail: params.selfEmail,
          });
        }
      );
      for (const message of pageMessages) {
        if (message) {
          messages.push(message);
        }
      }
      const nextPageToken = response.data.nextPageToken?.trim();
      if (!nextPageToken || nextPageToken === pageToken) {
        break;
      }
      pageToken = nextPageToken;
    }

    return sortGmailMessages(messages).slice(0, maxResults);
  }

  async getGmailMessage(
    params: GoogleAccountRef & { messageId: string; selfEmail?: string | null }
  ): Promise<GoogleGmailMessageSummary | null> {
    const gmail = await this.clientFactory.gmail(params, ["gmail.read"], "gmail.getGmailMessage");
    return this.getRichMessageWithClient(gmail, params);
  }

  async getGmailMessageDetail(
    params: GoogleAccountRef & { messageId: string; selfEmail?: string | null }
  ): Promise<GoogleGmailMessageDetail | null> {
    const gmail = await this.clientFactory.gmail(
      params,
      ["gmail.read"],
      "gmail.getGmailMessageDetail"
    );
    const response = await gmail.users.messages.get({
      userId: "me",
      id: params.messageId,
      format: "full",
    });
    const message = mapRichMessage(response.data, params.selfEmail ?? null);
    if (!message) {
      return null;
    }
    return {
      message,
      bodyText: extractGoogleGmailBody(response.data.payload).trim() || message.snippet,
    };
  }

  async getGmailThread(
    params: GoogleAccountRef & { threadId: string; selfEmail?: string | null }
  ): Promise<GoogleGmailMessageSummary[]> {
    const gmail = await this.clientFactory.gmail(params, ["gmail.read"], "gmail.getGmailThread");
    const response = await gmail.users.threads.get({
      userId: "me",
      id: params.threadId,
      format: "metadata",
      metadataHeaders: [...GMAIL_METADATA_HEADERS],
    });
    return (response.data.messages ?? [])
      .map((message) => mapRichMessage(message, params.selfEmail ?? null))
      .filter((message): message is GoogleGmailMessageSummary => message !== null)
      .sort((left, right) => Date.parse(left.receivedAt) - Date.parse(right.receivedAt));
  }

  async listGmailUnrespondedThreads(
    params: GoogleAccountRef & {
      selfEmail?: string | null;
      olderThanDays?: number;
      maxResults?: number;
      now?: Date;
    }
  ): Promise<GoogleGmailUnrespondedThread[]> {
    const olderThanDays = normalizedLimit(params.olderThanDays, 3, 3650);
    const maxResults = normalizedLimit(params.maxResults, 20, 50);
    const selfEmail = params.selfEmail?.trim().toLowerCase() || null;
    const sentCandidates = await this.searchGmailMessages({
      accountId: params.accountId,
      selfEmail,
      maxResults: Math.min(Math.max(maxResults * 5, maxResults), 250),
      query: `in:sent older_than:${olderThanDays}d`,
    });
    const seenThreads = new Set<string>();
    const threads: GoogleGmailUnrespondedThread[] = [];
    const now = params.now ?? new Date();

    for (const sentMessage of sentCandidates) {
      if (seenThreads.has(sentMessage.threadId)) {
        continue;
      }
      seenThreads.add(sentMessage.threadId);
      const threadMessages = await this.getGmailThread({
        accountId: params.accountId,
        selfEmail,
        threadId: sentMessage.threadId,
      });
      const humanMessages = threadMessages.filter((message) => !isAutomatedMessage(message));
      const lastOutbound = [...humanMessages]
        .reverse()
        .find((message) => isMessageFromSelf(message, selfEmail));
      if (!lastOutbound) {
        continue;
      }
      const lastOutboundAtMs = Date.parse(lastOutbound.receivedAt);
      if (!Number.isFinite(lastOutboundAtMs)) {
        continue;
      }
      const hasLaterInbound = humanMessages.some(
        (message) =>
          !isMessageFromSelf(message, selfEmail) &&
          Date.parse(message.receivedAt) > lastOutboundAtMs
      );
      if (hasLaterInbound) {
        continue;
      }
      const ageMs = now.getTime() - lastOutboundAtMs;
      if (ageMs < olderThanDays * 24 * 60 * 60 * 1000) {
        continue;
      }
      const lastInbound = [...humanMessages]
        .reverse()
        .find((message) => !isMessageFromSelf(message, selfEmail));
      threads.push({
        threadId: lastOutbound.threadId,
        externalMessageId: lastOutbound.externalId,
        subject: lastOutbound.subject,
        to: lastOutbound.to,
        cc: lastOutbound.cc,
        lastOutboundAt: lastOutbound.receivedAt,
        lastInboundAt: lastInbound?.receivedAt ?? null,
        daysWaiting: Math.max(0, Math.floor(ageMs / (24 * 60 * 60 * 1000))),
        snippet: lastOutbound.snippet,
        labels: lastOutbound.labels,
        htmlLink: lastOutbound.htmlLink,
      });
    }

    return threads.sort((left, right) => right.daysWaiting - left.daysWaiting).slice(0, maxResults);
  }

  async modifyGmailMessages(
    params: GoogleAccountRef & {
      messageIds: readonly string[];
      operation: GoogleGmailBulkOperation;
      labelIds?: readonly string[];
    }
  ): Promise<void> {
    const gmail = await this.clientFactory.gmail(params, ["gmail.manage"], "gmail.modifyMessages");
    const ids = params.messageIds.map((messageId) => messageId.trim()).filter(Boolean);
    if (ids.length === 0) {
      throw new Error("Gmail operation requires message ids");
    }
    const labelIds = requireLabelIdsForOperation(params.operation, params.labelIds);

    if (params.operation === "trash") {
      await Promise.all(
        ids.map((id) => gmail.users.messages.trash({ userId: "me", id }).then(() => undefined))
      );
      return;
    }
    if (params.operation === "delete") {
      await gmail.users.messages.batchDelete({
        userId: "me",
        requestBody: { ids },
      });
      return;
    }

    const labelPatch = labelsForOperation(params.operation, labelIds);
    await gmail.users.messages.batchModify({
      userId: "me",
      requestBody: {
        ids,
        addLabelIds: labelPatch.addLabelIds,
        removeLabelIds: labelPatch.removeLabelIds,
      },
    });
  }

  async sendGmailReply(
    params: GoogleAccountRef & {
      to: string[];
      cc?: string[];
      subject: string;
      bodyText: string;
      inReplyTo?: string | null;
      references?: string | null;
    }
  ): Promise<GoogleGmailSendResult> {
    const raw = encodeRawGmailMessage([
      `To: ${params.to.join(", ")}`,
      ...(params.cc && params.cc.length > 0 ? [`Cc: ${params.cc.join(", ")}`] : []),
      `Subject: ${normalizeReplySubject(params.subject)}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      ...(params.inReplyTo ? [`In-Reply-To: ${params.inReplyTo}`] : []),
      ...(params.references ? [`References: ${params.references}`] : []),
      "",
      params.bodyText.replace(/\r?\n/g, "\r\n"),
    ]);
    return this.sendRawGmailMessage(params, raw, "gmail.sendGmailReply");
  }

  async sendGmailMessage(
    params: GoogleAccountRef & {
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject: string;
      bodyText: string;
    }
  ): Promise<GoogleGmailSendResult> {
    const raw = encodeRawGmailMessage([
      `To: ${params.to.join(", ")}`,
      ...(params.cc && params.cc.length > 0 ? [`Cc: ${params.cc.join(", ")}`] : []),
      ...(params.bcc && params.bcc.length > 0 ? [`Bcc: ${params.bcc.join(", ")}`] : []),
      `Subject: ${params.subject.trim() || "(no subject)"}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      params.bodyText.replace(/\r?\n/g, "\r\n"),
    ]);
    return this.sendRawGmailMessage(params, raw, "gmail.sendGmailMessage");
  }

  async getGmailSubscriptionHeaders(
    params: GoogleAccountRef & { query?: string; maxMessages?: number }
  ): Promise<GoogleGmailSubscriptionMessageHeaders[]> {
    const gmail = await this.clientFactory.gmail(
      params,
      ["gmail.read"],
      "gmail.getSubscriptionHeaders"
    );
    const query = params.query?.trim() || SUBSCRIPTION_SCAN_QUERY_DEFAULT;
    const maxMessages = normalizedLimit(params.maxMessages, 200, MAX_GMAIL_RESULTS);
    const results: GoogleGmailSubscriptionMessageHeaders[] = [];
    let pageToken: string | undefined;

    while (results.length < maxMessages) {
      const response = await gmail.users.messages.list({
        userId: "me",
        q: query,
        includeSpamTrash: false,
        maxResults: Math.min(100, maxMessages - results.length),
        pageToken,
      });
      const batch = await mapWithConcurrency(
        response.data.messages ?? [],
        GMAIL_METADATA_CONCURRENCY,
        async (messageRef) => {
          const messageId = messageRef.id?.trim();
          if (!messageId) {
            return null;
          }
          const rich = await this.getRichMessageWithClient(gmail, {
            accountId: params.accountId,
            messageId,
          });
          return rich ? mapSubscriptionHeaders(rich) : null;
        }
      );
      for (const headers of batch) {
        if (headers) {
          results.push(headers);
        }
      }
      const nextPageToken = response.data.nextPageToken?.trim();
      if (!nextPageToken || nextPageToken === pageToken) {
        break;
      }
      pageToken = nextPageToken;
    }

    return results;
  }

  async createGmailFilterForSender(
    params: GoogleAccountRef & { fromAddress: string; trash?: boolean }
  ): Promise<GoogleGmailFilterCreateResult> {
    const gmail = await this.clientFactory.gmail(
      params,
      ["gmail.manage"],
      "gmail.createFilterForSender"
    );
    const response = await gmail.users.settings.filters.create({
      userId: "me",
      requestBody: {
        criteria: { from: params.fromAddress },
        action: params.trash
          ? { removeLabelIds: ["INBOX"], addLabelIds: ["TRASH"] }
          : { addLabelIds: ["TRASH"], removeLabelIds: ["INBOX", "UNREAD"] },
      },
    });
    return {
      filterId: response.data.id ?? null,
      trashed: true,
    };
  }

  async trashGmailThread(params: GoogleAccountRef & { threadId: string }): Promise<void> {
    const gmail = await this.clientFactory.gmail(params, ["gmail.manage"], "gmail.trashThread");
    await gmail.users.threads.trash({
      userId: "me",
      id: params.threadId,
    });
  }

  async modifyGmailMessageLabels(
    params: GoogleAccountRef & {
      messageId: string;
      addLabelIds?: string[];
      removeLabelIds?: string[];
    }
  ): Promise<void> {
    const gmail = await this.clientFactory.gmail(
      params,
      ["gmail.manage"],
      "gmail.modifyMessageLabels"
    );
    await gmail.users.messages.modify({
      userId: "me",
      id: params.messageId,
      requestBody: {
        addLabelIds: params.addLabelIds ?? [],
        removeLabelIds: params.removeLabelIds ?? [],
      },
    });
  }

  async sendMailtoUnsubscribeEmail(
    params: GoogleAccountRef & { mailto: GoogleParsedMailto }
  ): Promise<void> {
    await this.sendGmailMessage({
      accountId: params.accountId,
      to: [params.mailto.recipient],
      subject: params.mailto.subject ?? "unsubscribe",
      bodyText: params.mailto.body ?? "unsubscribe",
    });
  }

  private async getMessageWithClient(
    gmail: gmail_v1.Gmail,
    params: GoogleAccountRef & { messageId: string; includeBody?: boolean }
  ): Promise<GoogleMessageSummary> {
    const response = await gmail.users.messages.get({
      userId: "me",
      id: params.messageId,
      format: params.includeBody ? "full" : "metadata",
      metadataHeaders: MESSAGE_METADATA_HEADERS,
    });

    return mapMessage(response.data, Boolean(params.includeBody));
  }

  private async getRichMessageWithClient(
    gmail: gmail_v1.Gmail,
    params: GoogleAccountRef & { messageId: string; selfEmail?: string | null }
  ): Promise<GoogleGmailMessageSummary | null> {
    try {
      const response = await gmail.users.messages.get({
        userId: "me",
        id: params.messageId,
        format: "metadata",
        metadataHeaders: [...GMAIL_METADATA_HEADERS],
      });
      return mapRichMessage(response.data, params.selfEmail ?? null);
    } catch (error) {
      if (googleErrorStatus(error) === 404) {
        return null;
      }
      throw error;
    }
  }

  private async sendRawGmailMessage(
    params: GoogleAccountRef,
    raw: string,
    reason: string
  ): Promise<GoogleGmailSendResult> {
    const gmail = await this.clientFactory.gmail(params, ["gmail.send"], reason);
    const response = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });
    return {
      messageId: response.data.id ?? null,
      threadId: response.data.threadId ?? null,
      labelIds: response.data.labelIds ?? [],
    };
  }
}

function mapMessage(message: gmail_v1.Schema$Message, includeBody: boolean): GoogleMessageSummary {
  const headers = message.payload?.headers ?? [];
  const dateHeader = headerValue(headers, "Date");
  const body = includeBody ? collectMessageBody(message.payload) : {};
  const headerMap = Object.fromEntries(
    headers
      .map((header) => [header.name?.trim() ?? "", header.value?.trim() ?? ""] as const)
      .filter(([name, value]) => name.length > 0 && value.length > 0)
  );

  return {
    id: message.id ?? "",
    threadId: message.threadId ?? undefined,
    subject: headerValue(headers, "Subject"),
    from: parseEmailAddresses(headerValue(headers, "From"))[0],
    replyTo: parseEmailAddresses(headerValue(headers, "Reply-To"))[0],
    to: parseEmailAddresses(headerValue(headers, "To")),
    cc: parseEmailAddresses(headerValue(headers, "Cc")),
    snippet: message.snippet ?? undefined,
    receivedAt: dateHeader ? new Date(dateHeader).toISOString() : undefined,
    labelIds: message.labelIds ?? undefined,
    headers: headerMap,
    ...body,
  };
}

function mapRichMessage(
  message: gmail_v1.Schema$Message,
  selfEmail: string | null
): GoogleGmailMessageSummary | null {
  const externalId = message.id?.trim();
  const threadId = message.threadId?.trim();
  if (!externalId || !threadId) {
    return null;
  }
  const headers = message.payload?.headers ?? [];
  const subject = decodeHtmlEntities(headerValue(headers, "Subject") || "") || "(no subject)";
  const from = parseMailbox(headerValue(headers, "From") || "Unknown sender");
  const replyTo = headerValue(headers, "Reply-To");
  const replyToMailbox = replyTo ? parseMailbox(replyTo) : null;
  const to = parseEmailAddresses(headerValue(headers, "To")).map(formatAddressValue);
  const cc = parseEmailAddresses(headerValue(headers, "Cc")).map(formatAddressValue);
  const labels = (message.labelIds ?? []).map((label) => label.trim()).filter(Boolean);
  const receivedAt = internalDateToIso(message.internalDate);
  const precedence = headerValue(headers, "Precedence");
  const listId = headerValue(headers, "List-Id");
  const autoSubmitted = headerValue(headers, "Auto-Submitted");
  const triage = classifyReplyNeed({
    labels,
    fromEmail: from.email,
    to,
    cc,
    selfEmail,
    precedence,
    listId,
    autoSubmitted,
  });

  return {
    externalId,
    threadId,
    subject,
    from: from.name || from.email || "Unknown sender",
    fromEmail: from.email ? from.email.toLowerCase() : null,
    replyTo: replyToMailbox?.email ?? replyToMailbox?.name ?? null,
    to,
    cc,
    snippet: normalizeSnippet(message.snippet),
    receivedAt,
    isUnread: labels.includes("UNREAD"),
    isImportant: triage.isImportant,
    likelyReplyNeeded: triage.likelyReplyNeeded,
    triageScore: triage.triageScore,
    triageReason: triage.triageReason,
    labels,
    htmlLink: deriveHtmlLink(threadId, selfEmail),
    metadata: {
      historyId: message.historyId?.trim() || null,
      sizeEstimate: typeof message.sizeEstimate === "number" ? message.sizeEstimate : null,
      dateHeader: headerValue(headers, "Date") || null,
      messageIdHeader: headerValue(headers, "Message-Id") || null,
      referencesHeader: headerValue(headers, "References") || null,
      listUnsubscribe: headerValue(headers, "List-Unsubscribe") || null,
      listUnsubscribePost: headerValue(headers, "List-Unsubscribe-Post") || null,
      listId: listId || null,
      precedence: precedence || null,
      autoSubmitted: autoSubmitted || null,
    },
  };
}

function headerValue(
  headers: gmail_v1.Schema$MessagePartHeader[],
  name: string
): string | undefined {
  return (
    headers.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined
  );
}

function parseEmailAddresses(value: string | undefined): GoogleEmailAddress[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/^(?:"?([^"<]*)"?\s*)?<([^>]+)>$/);
      if (!match) {
        return { email: part };
      }
      return {
        name: match[1]?.trim() || undefined,
        email: match[2].trim(),
      };
    });
}

function collectMessageBody(
  part: gmail_v1.Schema$MessagePart | undefined
): Pick<GoogleMessageSummary, "bodyHtml" | "bodyText"> {
  if (!part) {
    return {};
  }

  const body: Pick<GoogleMessageSummary, "bodyHtml" | "bodyText"> = {};
  collectMessagePart(part, body);
  return body;
}

function collectMessagePart(
  part: gmail_v1.Schema$MessagePart,
  body: Pick<GoogleMessageSummary, "bodyHtml" | "bodyText">
): void {
  const data = part.body?.data ? decodeBase64Url(part.body.data) : undefined;

  if (data && part.mimeType === "text/plain" && !body.bodyText) {
    body.bodyText = data;
  }
  if (data && part.mimeType === "text/html" && !body.bodyHtml) {
    body.bodyHtml = data;
  }

  for (const child of part.parts ?? []) {
    collectMessagePart(child, body);
  }
}

function encodeMessage(input: GoogleSendEmailInput): string {
  const headers = [
    `To: ${formatEmailAddresses(input.to)}`,
    input.cc?.length ? `Cc: ${formatEmailAddresses(input.cc)}` : undefined,
    input.bcc?.length ? `Bcc: ${formatEmailAddresses(input.bcc)}` : undefined,
    `Subject: ${input.subject}`,
    "MIME-Version: 1.0",
  ].filter(Boolean);

  const contentType = input.html ? "text/html; charset=utf-8" : "text/plain; charset=utf-8";
  const body = input.html ?? input.text ?? "";
  const message = [...headers, `Content-Type: ${contentType}`, "", body].join("\r\n");
  return Buffer.from(message).toString("base64url");
}

function formatEmailAddresses(addresses: readonly GoogleEmailAddress[]): string {
  return addresses
    .map((address) => (address.name ? `"${address.name}" <${address.email}>` : address.email))
    .join(", ");
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function normalizedLimit(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(Math.trunc(value), max);
}

async function mapWithConcurrency<T, TResult>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<TResult>
): Promise<TResult[]> {
  if (items.length === 0) {
    return [];
  }
  const results = new Array<TResult>(items.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await mapper(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

function sortGmailMessages(messages: GoogleGmailMessageSummary[]): GoogleGmailMessageSummary[] {
  return [...messages].sort((left, right) => {
    if (left.isImportant !== right.isImportant) {
      return right.isImportant ? 1 : -1;
    }
    if (left.likelyReplyNeeded !== right.likelyReplyNeeded) {
      return right.likelyReplyNeeded ? 1 : -1;
    }
    if (left.isUnread !== right.isUnread) {
      return right.isUnread ? 1 : -1;
    }
    return Date.parse(right.receivedAt) - Date.parse(left.receivedAt);
  });
}

function parseMailbox(value: string): GoogleEmailAddress {
  const trimmed = value.trim();
  const match = trimmed.match(/^(.*?)(?:<([^>]+)>)$/);
  if (match) {
    const name = (match[1] ?? "").trim().replace(/^"|"$/g, "");
    const email = (match[2] ?? "").trim();
    return { name: name || undefined, email };
  }
  return { email: trimmed };
}

function formatAddressValue(address: GoogleEmailAddress): string {
  return address.email || address.name || "";
}

function normalizeSnippet(value: string | null | undefined): string {
  return decodeHtmlEntities(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&");
}

function internalDateToIso(value: string | null | undefined): string {
  const ms = value ? Number(value) : Number.NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

function deriveHtmlLink(threadId: string, accountEmail: string | null): string {
  const accountSegment =
    accountEmail && accountEmail.trim().length > 0
      ? encodeURIComponent(accountEmail.trim().toLowerCase())
      : "0";
  return `https://mail.google.com/mail/u/${accountSegment}/#all/${encodeURIComponent(threadId)}`;
}

function classifyReplyNeed(args: {
  labels: string[];
  fromEmail: string | null | undefined;
  to: string[];
  cc: string[];
  selfEmail: string | null;
  precedence: string | undefined;
  listId: string | undefined;
  autoSubmitted: string | undefined;
}): {
  likelyReplyNeeded: boolean;
  isImportant: boolean;
  triageScore: number;
  triageReason: string;
} {
  const labels = new Set(args.labels.map((label) => label.trim().toUpperCase()));
  const isUnread = labels.has("UNREAD");
  const explicitlyImportant = labels.has("IMPORTANT");
  const selfEmail = args.selfEmail?.trim().toLowerCase() || null;
  const fromEmail = args.fromEmail?.trim().toLowerCase() || null;
  const directRecipients = [...args.to, ...args.cc].map((entry) => entry.trim().toLowerCase());
  const directlyAddressed = selfEmail ? directRecipients.includes(selfEmail) : false;
  const fromSelf = Boolean(selfEmail && fromEmail && selfEmail === fromEmail);
  const precedence = args.precedence?.trim().toLowerCase();
  const autoSubmitted = args.autoSubmitted?.trim().toLowerCase();
  const automated =
    Boolean(args.listId) ||
    precedence === "bulk" ||
    precedence === "list" ||
    precedence === "junk" ||
    precedence === "auto-reply" ||
    (autoSubmitted !== undefined && autoSubmitted !== "no");
  const likelyReplyNeeded = !automated && !fromSelf && isUnread && directlyAddressed;
  const isImportant = explicitlyImportant || likelyReplyNeeded;
  const triageSignals = [
    explicitlyImportant ? "gmail-important-label" : null,
    likelyReplyNeeded ? "direct-unread-reply-needed" : null,
    isUnread ? "unread" : null,
    automated ? "automated-header" : null,
    fromSelf ? "sent-by-self" : null,
  ].filter((signal): signal is string => Boolean(signal));

  return {
    likelyReplyNeeded,
    isImportant,
    triageScore: isImportant ? 2 : isUnread ? 1 : 0,
    triageReason: triageSignals.join(", ") || "recent inbox message",
  };
}

function isMessageFromSelf(message: GoogleGmailMessageSummary, selfEmail: string | null): boolean {
  const labels = new Set(message.labels.map((label) => label.toUpperCase()));
  if (labels.has("SENT")) {
    return true;
  }
  const fromEmail = message.fromEmail?.trim().toLowerCase() || null;
  return Boolean(selfEmail && fromEmail && fromEmail === selfEmail);
}

function isAutomatedMessage(message: GoogleGmailMessageSummary): boolean {
  const precedence =
    typeof message.metadata.precedence === "string"
      ? message.metadata.precedence.trim().toLowerCase()
      : "";
  const autoSubmitted =
    typeof message.metadata.autoSubmitted === "string"
      ? message.metadata.autoSubmitted.trim().toLowerCase()
      : "";
  return (
    Boolean(message.metadata.listId) ||
    precedence === "bulk" ||
    precedence === "list" ||
    precedence === "junk" ||
    precedence === "auto-reply" ||
    (autoSubmitted.length > 0 && autoSubmitted !== "no")
  );
}

function requireLabelIdsForOperation(
  operation: GoogleGmailBulkOperation,
  labelIds: readonly string[] | undefined
): string[] {
  const labels = (labelIds ?? []).map((labelId) => labelId.trim()).filter(Boolean);
  if ((operation === "apply_label" || operation === "remove_label") && labels.length === 0) {
    throw new Error(`${operation} requires at least one labelId`);
  }
  return labels;
}

function labelsForOperation(
  operation: GoogleGmailBulkOperation,
  labelIds: string[]
): { addLabelIds?: string[]; removeLabelIds?: string[] } {
  const labels: Record<
    GoogleGmailBulkOperation,
    { addLabelIds?: string[]; removeLabelIds?: string[] }
  > = {
    archive: { removeLabelIds: ["INBOX"] },
    trash: {},
    delete: {},
    report_spam: { addLabelIds: ["SPAM"], removeLabelIds: ["INBOX"] },
    mark_read: { removeLabelIds: ["UNREAD"] },
    mark_unread: { addLabelIds: ["UNREAD"] },
    apply_label: { addLabelIds: labelIds },
    remove_label: { removeLabelIds: labelIds },
  };
  return labels[operation];
}

function normalizeReplySubject(subject: string): string {
  const trimmed = subject.trim();
  if (trimmed.length === 0) {
    return "Re: your message";
  }
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

function encodeRawGmailMessage(lines: string[]): string {
  return Buffer.from(lines.join("\r\n"), "utf-8").toString("base64url");
}

function extractGoogleGmailBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  const plainText = extractGoogleGmailBodyByMime(payload, "text/plain");
  if (plainText) {
    return plainText;
  }
  const htmlText = extractGoogleGmailBodyByMime(payload, "text/html");
  if (htmlText) {
    return htmlText;
  }
  const directBody = payload?.body?.data;
  if (typeof directBody === "string") {
    const decoded = decodeBase64Url(directBody);
    return payload?.mimeType === "text/html" ? htmlToPlainText(decoded) : decoded.trim();
  }
  return "";
}

function extractGoogleGmailBodyByMime(
  payload: gmail_v1.Schema$MessagePart | undefined,
  mimeType: "text/plain" | "text/html"
): string {
  if (!payload) {
    return "";
  }
  const directBody = payload.body?.data;
  if (payload.mimeType === mimeType && typeof directBody === "string") {
    const decoded = decodeBase64Url(directBody);
    return mimeType === "text/html" ? htmlToPlainText(decoded) : decoded.trim();
  }
  for (const part of payload.parts ?? []) {
    const nested = extractGoogleGmailBodyByMime(part, mimeType);
    if (nested) {
      return nested;
    }
  }
  return "";
}

function htmlToPlainText(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, " ")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|section|article|li|tr|table|h[1-6])>/gi, "\n")
      .replace(/<(?:li)[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function mapSubscriptionHeaders(
  message: GoogleGmailMessageSummary
): GoogleGmailSubscriptionMessageHeaders {
  const listUnsubscribe =
    typeof message.metadata.listUnsubscribe === "string" ? message.metadata.listUnsubscribe : null;
  const listUnsubscribePost =
    typeof message.metadata.listUnsubscribePost === "string"
      ? message.metadata.listUnsubscribePost
      : null;
  const listId = typeof message.metadata.listId === "string" ? message.metadata.listId : null;
  return {
    messageId: message.externalId,
    threadId: message.threadId,
    receivedAt: message.receivedAt,
    subject: message.subject,
    fromDisplay: message.from,
    fromEmail: message.fromEmail,
    listId,
    listUnsubscribe,
    listUnsubscribePost,
    snippet: message.snippet,
    labels: message.labels,
  };
}

function googleErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const candidate = error as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  if (typeof candidate.code === "number") {
    return candidate.code;
  }
  if (typeof candidate.status === "number") {
    return candidate.status;
  }
  if (typeof candidate.response?.status === "number") {
    return candidate.response.status;
  }
  return undefined;
}
