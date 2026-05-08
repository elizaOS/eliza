import type { gmail_v1 } from "googleapis";
import type { GoogleApiClientFactory } from "./client-factory.js";
import type {
  GoogleAccountRef,
  GoogleEmailAddress,
  GoogleMessageSummary,
  GoogleSendEmailInput,
} from "./types.js";

const MESSAGE_METADATA_HEADERS = ["Subject", "From", "To", "Date"];

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
}

function mapMessage(message: gmail_v1.Schema$Message, includeBody: boolean): GoogleMessageSummary {
  const headers = message.payload?.headers ?? [];
  const dateHeader = headerValue(headers, "Date");
  const body = includeBody ? collectMessageBody(message.payload) : {};

  return {
    id: message.id ?? "",
    threadId: message.threadId ?? undefined,
    subject: headerValue(headers, "Subject"),
    from: parseEmailAddresses(headerValue(headers, "From"))[0],
    to: parseEmailAddresses(headerValue(headers, "To")),
    snippet: message.snippet ?? undefined,
    receivedAt: dateHeader ? new Date(dateHeader).toISOString() : undefined,
    labelIds: message.labelIds ?? undefined,
    ...body,
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
