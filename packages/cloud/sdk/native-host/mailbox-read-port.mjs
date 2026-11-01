import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { NativeCloudServiceError } from "./errors.mjs";
import { createManagedGoogleReadPort } from "./managed-google-read-port.mjs";

const reject = (status = 400) => {
  throw new NativeCloudServiceError("Mailbox read unavailable", { status });
};
const id = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const text = (value, max) => {
  if (typeof value !== "string" || value.length > max) reject(502);
  return value;
};
const attachmentTypes = new Set([
  "application/pdf",
  "text/plain",
  "image/png",
  "image/jpeg",
  "image/webp",
]);
/** Versioned host-only inbox projection, separate from task mail reads. The host
 * supplies a credential/owner/grant-fenced, size-bounded GET transport. Render all
 * strings as text, never HTML. No URLs, inline images or provider secrets leave
 * this port. Attaching it to a renderer requires its own explicit read authority. */
export function createMailboxReadPort({ accountId, request }) {
  if (!id(accountId) || typeof request !== "function") reject();
  const cursorKey = randomBytes(32);
  const signature = (value) =>
    createHmac("sha256", cursorKey).update(value).digest();
  const encodeCursor = (token, query, pageSize) => {
    const payload = Buffer.from(
      JSON.stringify({ token, query, pageSize, accountId }),
    ).toString("base64url");
    return `${payload}.${signature(payload).toString("base64url")}`;
  };
  const decodeCursor = (cursor, query, pageSize) => {
    try {
      const parts = cursor.split(".");
      if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0])) reject();
      const actual = Buffer.from(parts[1], "base64url"),
        expected = signature(parts[0]);
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        reject();
      const value = JSON.parse(
        Buffer.from(parts[0], "base64url").toString("utf8"),
      );
      if (
        value.accountId !== accountId ||
        value.query !== query ||
        value.pageSize !== pageSize
      )
        reject();
      return value.token;
    } catch {
      reject();
    }
  };
  const taskReads = createManagedGoogleReadPort({ accountId, request });
  const selected = (input) => {
    if (input?.accountId !== accountId) reject(409);
    return new URLSearchParams({ side: "owner", grantId: accountId });
  };
  const summary = (value) => {
    if (!id(value?.externalId) || !id(value.threadId)) reject(502);
    return {
      id: value.externalId,
      threadId: value.threadId,
      // Cloud retains the display From header when no address can be parsed.
      sender: text(
        value.fromEmail === null ? value.from : value.fromEmail,
        1024,
      ),
      subject: text(value.subject ?? "", 8192),
      receivedAt: text(value.receivedAt, 128),
      snippet: text(value.snippet ?? "", 16384),
    };
  };
  const port = {
    version: 1,
    async list(input) {
      const params = selected(input);
      if (
        !Number.isInteger(input.pageSize) ||
        input.pageSize < 1 ||
        input.pageSize > 50 ||
        typeof input.query !== "string" ||
        !input.query.trim() ||
        input.query.length > 1000 ||
        (input.pageToken !== undefined &&
          (typeof input.pageToken !== "string" ||
            !input.pageToken ||
            input.pageToken.length > 16384))
      )
        reject();
      params.set("query", input.query);
      params.set("maxResults", String(input.pageSize));
      if (input.pageToken !== undefined)
        params.set(
          "pageToken",
          decodeCursor(input.pageToken, input.query, input.pageSize),
        );
      const value = await request(
        `/api/v1/eliza/google/gmail/search?${params}`,
        2 * 1024 * 1024,
        accountId,
      );
      if (
        !Array.isArray(value?.messages) ||
        value.messages.length > input.pageSize ||
        !Object.hasOwn(value, "nextPageToken") ||
        (value.nextPageToken !== null &&
          (typeof value.nextPageToken !== "string" ||
            !value.nextPageToken ||
            value.nextPageToken.length > 4096))
      )
        reject(502);
      return {
        version: 1,
        accountId,
        messages: value.messages.map(summary),
        nextPageToken: value.nextPageToken
          ? encodeCursor(value.nextPageToken, input.query, input.pageSize)
          : null,
      };
    },
    async read(input) {
      const params = selected(input);
      if (!id(input.messageId)) reject();
      params.set("messageId", input.messageId);
      const value = await request(
        `/api/v1/eliza/google/gmail/read?${params}`,
        2 * 1024 * 1024,
        accountId,
      );
      if (
        value?.message?.externalId !== input.messageId ||
        !Array.isArray(value.attachments) ||
        value.attachments.length > 100
      )
        reject(502);
      const attachments = value.attachments.map((part) => {
        if (
          typeof part?.partId !== "string" ||
          !/^[0-9.]{0,128}$/.test(part.partId) ||
          !Number.isSafeInteger(part.size) ||
          part.size < 0
        )
          reject(502);
        const mimeType = text(part.mimeType, 200);
        return {
          partId: part.partId,
          filename: text(part.filename, 1024),
          mimeType,
          size: part.size,
          downloadable:
            attachmentTypes.has(mimeType) && part.size <= 5 * 1024 * 1024,
        };
      });
      // The mailbox state a reviewed change names: Gmail's historyId for this
      // message, and the labels that say whether it is unread, in the inbox
      // or in the trash. Labels are reduced to those three booleans.
      const labels = Array.isArray(value.message.labels)
        ? value.message.labels.filter((label) => typeof label === "string")
        : [];
      const historyId = value.message.metadata?.historyId;
      return {
        version: 1,
        accountId,
        message: summary(value.message),
        state: {
          historyId:
            typeof historyId === "string" && /^[0-9]{1,40}$/.test(historyId)
              ? historyId
              : null,
          unread: labels.includes("UNREAD"),
          inInbox: labels.includes("INBOX"),
          inTrash: labels.includes("TRASH"),
        },
        format: "text",
        remoteImages: false,
        bodyText: text(value.bodyText, 1024 * 1024),
        attachments,
      };
    },
    async attachment(input) {
      selected(input);
      // Re-read metadata under the same authority; a renderer cannot choose a
      // MIME type/size or reach an unlisted part by forging its descriptor.
      const detail = await port.read(input);
      const descriptor = detail.attachments.find(
        (part) => part.partId === input.partId,
      );
      if (!descriptor?.downloadable) reject(415);
      const result = await taskReads.getGmailAttachment({
        accountId,
        messageId: input.messageId,
        partId: input.partId,
        maxBytes: 5 * 1024 * 1024,
      });
      if (
        result.mimeType !== descriptor.mimeType ||
        result.size !== descriptor.size ||
        result.filename !== descriptor.filename
      )
        reject(409);
      return {
        version: 1,
        accountId,
        messageId: input.messageId,
        partId: result.partId,
        filename: result.filename,
        mimeType: result.mimeType,
        size: result.size,
        sha256: result.sha256,
        data: result.data,
      };
    },
  };
  return port;
}
