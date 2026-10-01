/** Account-bound managed Gmail attachment reads reuse the shared plugin's MIME decoder. */
import {
  decodeGmailAttachment,
  gmailAttachmentParts,
  MAX_GMAIL_ATTACHMENT_BYTES,
} from "@elizaos/plugin-google-workspace/gmail-attachments";
import type { GmailMimePartLike } from "@elizaos/plugin-google-workspace/gmail-mime-parts";
import type { OAuthConnectionRole } from "../oauth/types";
import {
  AgentGoogleConnectorError,
  fail,
  getManagedGoogleConnectorStatus,
  googleFetch,
} from "./shared";

export async function readManagedGoogleGmailAttachment(args: {
  organizationId: string;
  userId: string;
  side: OAuthConnectionRole;
  grantId: string;
  messageId: string;
  partId: string;
  maxBytes?: number;
}) {
  args = { ...args }; // Preserve the authenticated account/request across awaits.
  const maxBytes = args.maxBytes ?? 5 * 1024 * 1024;
  if (
    !args.grantId?.trim() ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(args.messageId) ||
    typeof args.partId !== "string" ||
    !/^[0-9.]{0,128}$/.test(args.partId) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_GMAIL_ATTACHMENT_BYTES
  )
    fail(400, "Invalid Gmail attachment request.");
  try {
    const requireCurrentGrant = async () => {
      const status = await getManagedGoogleConnectorStatus(args);
      if (
        !status.connected ||
        status.connectionId !== args.grantId ||
        !status.grantedScopes.some((scope) =>
          [
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/gmail.modify",
            "https://mail.google.com/",
          ].includes(scope),
        )
      )
        fail(409, "Google attachment read access is unavailable.");
    };
    await requireCurrentGrant();
    const base = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(args.messageId)}`;
    const maxResponseBytes = Math.ceil(maxBytes / 3) * 4 + 65536;
    const response = await googleFetch({
      ...args,
      url: `${base}?format=full`,
      // Full message metadata/body is independent of the selected attachment's limit.
      maxResponseBytes: Math.ceil(MAX_GMAIL_ATTACHMENT_BYTES / 3) * 4 + 65536,
    });
    const message = (await response.json()) as { id?: string; payload?: GmailMimePartLike };
    if (message.id !== args.messageId) fail(502, "Gmail attachment unavailable.");
    const part = gmailAttachmentParts(message.payload).find(
      (part) => part.descriptor.partId === args.partId,
    );
    if (!part || part.descriptor.size > maxBytes) fail(502, "Gmail attachment unavailable.");
    let data: unknown = part.inlineData,
      size: unknown = part.descriptor.size;
    if (part.descriptor.attachmentId) {
      // googleFetch resolves this exact grant again before each provider call.
      const attachment = await googleFetch({
        ...args,
        url: `${base}/attachments/${encodeURIComponent(part.descriptor.attachmentId)}`,
        maxResponseBytes,
      });
      const value = (await attachment.json()) as { data?: unknown; size?: unknown };
      data = value.data;
      size = value.size;
    }
    const decoded = decodeGmailAttachment(part.descriptor, args.messageId, data, size, maxBytes);
    await requireCurrentGrant();
    return {
      ...decoded,
      data: Buffer.from(decoded.data).toString("base64url"),
      encoding: "base64url" as const,
      grantId: args.grantId,
    };
  } catch (error) {
    // error-policy:J1 Avoid exposing provider bodies or account credentials through attachment errors.
    if (error instanceof AgentGoogleConnectorError && [400, 404, 409].includes(error.status))
      fail(error.status, "Google attachment read access is unavailable.");
    fail(502, "Gmail attachment unavailable.");
  }
}
