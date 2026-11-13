import { createHash } from "node:crypto";
import { NativeCloudServiceError } from "./errors.mjs";

const unavailable = () =>
  new NativeCloudServiceError("Managed Google task reads unavailable");
const id = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
export const isStringList = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
/**
 * The two read fields that sit beside bodyText. A server without them reads as
 * no links and no authentication result, so a client treats the sender as not
 * checked. `links` are inert http(s) anchors from the connector. A client must
 * review a link before it opens it. `authenticationResults` are raw header
 * values, topmost first, and a sender can write them. Do not reorder them, and
 * keep them on the host. Returns null for any other shape.
 */
export const readDetailFields = (value) => {
  const links = value.links ?? [];
  const authenticationResults = value.authenticationResults ?? [];
  if (
    !Array.isArray(links) ||
    !links.every(
      (link) => typeof link?.href === "string" && typeof link.text === "string",
    ) ||
    !isStringList(authenticationResults)
  )
    return null;
  return {
    links: links.map(({ href, text }) => ({ href, text })),
    authenticationResults: [...authenticationResults],
  };
};
/**
 * Host-only adapter: request owns credentials, account lifetime and bounded
 * JSON transport. With `accountId`, every read must name that grant. Without
 * it, each read names the grant its task is bound to.
 */
export function createManagedGoogleReadPort({ accountId, request }) {
  if (
    (accountId !== undefined && !id(accountId)) ||
    typeof request !== "function"
  )
    throw unavailable();
  const grant = (input) => {
    if (!id(input?.accountId) || (accountId && input.accountId !== accountId))
      throw unavailable();
    return input.accountId;
  };
  const query = (input, extra) =>
    new URLSearchParams({ side: "owner", grantId: grant(input), ...extra });
  const message = (value) => {
    if (
      !value ||
      !id(value.externalId) ||
      !id(value.threadId) ||
      // The connector contract allows a null sender address when no address
      // can be parsed from the From header; pass it through as null.
      !(typeof value.fromEmail === "string" || value.fromEmail === null) ||
      !isStringList(value.to) ||
      !isStringList(value.cc) ||
      !(typeof value.replyTo === "string" || value.replyTo === null) ||
      typeof value.isUnread !== "boolean" ||
      typeof value.subject !== "string" ||
      typeof value.receivedAt !== "string"
    )
      throw unavailable();
    return {
      externalId: value.externalId,
      threadId: value.threadId,
      fromEmail: value.fromEmail,
      to: [...value.to],
      cc: [...value.cc],
      replyTo: value.replyTo,
      unread: value.isUnread,
      subject: value.subject,
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
        input.accountId,
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
        input.accountId,
      );
      if (
        value?.message?.externalId !== input.messageId ||
        typeof value.bodyText !== "string" ||
        !Array.isArray(value.attachments) ||
        value.attachments.length > 100
      )
        throw unavailable();
      const fields = readDetailFields(value);
      if (!fields) throw unavailable();
      return {
        message: message(value.message),
        bodyText: value.bodyText,
        attachments: value.attachments.map(descriptor),
        ...fields,
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
        input.accountId,
      );
      if (
        value?.grantId !== input.accountId ||
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
