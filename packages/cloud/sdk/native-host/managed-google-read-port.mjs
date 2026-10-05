import { createHash } from "node:crypto";
import { NativeCloudServiceError } from "./errors.mjs";

const unavailable = () =>
  new NativeCloudServiceError("Managed Google task reads unavailable");
const id = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
/** Host-only adapter: request owns credentials, account lifetime and bounded JSON transport. */
export function createManagedGoogleReadPort({ accountId, request }) {
  if (!id(accountId) || typeof request !== "function") throw unavailable();
  const query = (input, extra) => {
    if (input?.accountId !== accountId) throw unavailable();
    return new URLSearchParams({ side: "owner", grantId: accountId, ...extra });
  };
  const message = (value) => {
    if (
      !value ||
      !id(value.externalId) ||
      !id(value.threadId) ||
      typeof value.fromEmail !== "string" ||
      !Array.isArray(value.to) ||
      !value.to.every((x) => typeof x === "string") ||
      typeof value.receivedAt !== "string"
    )
      throw unavailable();
    return {
      externalId: value.externalId,
      threadId: value.threadId,
      fromEmail: value.fromEmail,
      to: [...value.to],
      receivedAt: value.receivedAt,
      ...(typeof value.htmlLink === "string"
        ? { htmlLink: value.htmlLink }
        : {}),
    };
  };
  const descriptor = (value) => {
    if (
      !value ||
      typeof value.partId !== "string" ||
      !/^[0-9.]{0,128}$/.test(value.partId) ||
      typeof value.filename !== "string" ||
      value.filename.length > 1024 ||
      typeof value.mimeType !== "string" ||
      value.mimeType.length > 200 ||
      !Number.isSafeInteger(value.size) ||
      value.size < 0 ||
      !(value.attachmentId === null || typeof value.attachmentId === "string")
    )
      throw unavailable();
    return {
      partId: value.partId,
      filename: value.filename,
      mimeType: value.mimeType,
      size: value.size,
      attachmentId: value.attachmentId,
    };
  };
  return {
    async searchGmailMessagesPage(input) {
      if (
        !Number.isInteger(input?.pageSize) ||
        input.pageSize < 1 ||
        input.pageSize > 50 ||
        typeof input.query !== "string" ||
        !input.query.length ||
        input.query.length > 1000 ||
        (input.pageToken !== undefined &&
          (typeof input.pageToken !== "string" ||
            !input.pageToken.length ||
            input.pageToken.length > 4096))
      )
        throw unavailable();
      const params = query(input, {
        query: input.query,
        maxResults: String(input.pageSize),
        ...(input.pageToken ? { pageToken: input.pageToken } : {}),
      });
      const value = await request(
        `/api/v1/eliza/google/gmail/search?${params}`,
        1024 * 1024,
      );
      // An old server that silently truncates results is not a complete-search provider.
      if (
        !Array.isArray(value?.messages) ||
        value.messages.length > input.pageSize ||
        !Object.hasOwn(value, "nextPageToken") ||
        !(
          value.nextPageToken === null ||
          (typeof value.nextPageToken === "string" &&
            value.nextPageToken.length > 0 &&
            value.nextPageToken.length <= 4096)
        )
      )
        throw unavailable();
      return {
        messages: value.messages.map(message),
        nextPageToken: value.nextPageToken,
      };
    },
    async getGmailMessageDetail(input) {
      if (!id(input?.messageId)) throw unavailable();
      const value = await request(
        `/api/v1/eliza/google/gmail/read?${query(input, { messageId: input.messageId })}`,
        36 * 1024 * 1024,
      );
      if (
        value?.message?.externalId !== input.messageId ||
        typeof value.bodyText !== "string" ||
        !Array.isArray(value.attachments) ||
        value.attachments.length > 100
      )
        throw unavailable();
      return {
        message: message(value.message),
        bodyText: value.bodyText,
        attachments: value.attachments.map(descriptor),
      };
    },
    async getGmailAttachment(input) {
      if (
        !id(input?.messageId) ||
        typeof input.partId !== "string" ||
        !/^[0-9.]{0,128}$/.test(input.partId) ||
        !Number.isSafeInteger(input.maxBytes) ||
        input.maxBytes < 1 ||
        input.maxBytes > 25 * 1024 * 1024
      )
        throw unavailable();
      const params = query(input, {
        messageId: input.messageId,
        partId: input.partId,
        maxBytes: String(input.maxBytes),
      });
      const value = await request(
        `/api/v1/eliza/google/gmail/read?${params}`,
        Math.ceil(input.maxBytes / 3) * 4 + 65536,
      );
      if (
        value?.grantId !== accountId ||
        value.messageId !== input.messageId ||
        value.partId !== input.partId ||
        value.encoding !== "base64url" ||
        typeof value.data !== "string" ||
        value.data.length > Math.ceil(input.maxBytes / 3) * 4 ||
        !/^[A-Za-z0-9_-]*$/.test(value.data)
      )
        throw unavailable();
      const data = Buffer.from(value.data, "base64url");
      if (
        data.length > input.maxBytes ||
        data.length !== value.size ||
        data.toString("base64url") !== value.data ||
        createHash("sha256").update(data).digest("hex") !== value.sha256
      )
        throw unavailable();
      return {
        ...descriptor(value),
        messageId: value.messageId,
        sha256: value.sha256,
        data,
      };
    },
  };
}
