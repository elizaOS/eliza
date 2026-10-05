/** Attachment inventory and bounded decoding; filenames are metadata, never filesystem paths. */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core/protocol";
import { type GmailMimePartLike, walkGmailMimeParts } from "./gmail-mime-parts.js";
import type { GoogleGmailAttachment, GoogleGmailAttachmentContent } from "./types.js";

export const MAX_GMAIL_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export function attachmentUnavailable(): ElizaError {
  return new ElizaError("The Gmail attachment could not be read safely.", {
    code: "GOOGLE_GMAIL_ATTACHMENT_UNAVAILABLE",
  });
}
export function gmailAttachmentParts(payload: GmailMimePartLike | undefined) {
  const result: { descriptor: GoogleGmailAttachment; inlineData: string | null }[] = [];
  const seen = new Set<string>();
  walkGmailMimeParts(payload, (part) => {
    if (!part.filename && !part.body?.attachmentId) return;
    const { partId, filename, mimeType } = part;
    const size = part.body?.size;
    const attachmentId = part.body?.attachmentId ?? null;
    if (
      typeof partId !== "string" ||
      !/^[0-9.]{0,128}$/.test(partId) ||
      seen.has(partId) ||
      typeof filename !== "string" ||
      filename.length > 1024 ||
      typeof mimeType !== "string" ||
      !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(mimeType) ||
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      (attachmentId !== null &&
        (typeof attachmentId !== "string" || !/^[A-Za-z0-9_-]{1,8192}$/.test(attachmentId)))
    )
      throw attachmentUnavailable();
    seen.add(partId);
    result.push({
      descriptor: { partId, filename, mimeType, size, attachmentId },
      inlineData: typeof part.body?.data === "string" ? part.body.data : null,
    });
  });
  return result;
}
export function decodeGmailAttachment(
  descriptor: GoogleGmailAttachment,
  messageId: string,
  data: unknown,
  reportedSize: unknown,
  maxBytes: number
): GoogleGmailAttachmentContent {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_GMAIL_ATTACHMENT_BYTES ||
    descriptor.size > maxBytes ||
    reportedSize !== descriptor.size ||
    typeof data !== "string" ||
    data.length > Math.ceil(maxBytes / 3) * 4 ||
    (data.includes("=") && data.length % 4 !== 0) ||
    !/^[A-Za-z0-9_-]*={0,2}$/.test(data)
  )
    throw attachmentUnavailable();
  const bytes = Buffer.from(data, "base64url");
  if (
    bytes.length !== descriptor.size ||
    bytes.length > maxBytes ||
    bytes.toString("base64url") !== data.replace(/=+$/, "")
  )
    throw attachmentUnavailable();
  return {
    ...descriptor,
    messageId,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    data: bytes,
  };
}
