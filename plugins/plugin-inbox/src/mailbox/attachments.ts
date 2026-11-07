/** Outgoing attachment limits and opaque byte-copy review for the managed Gmail mailbox. */
import { AttachmentRefusedError } from "./failures.ts";

/** A file the user chose for an outgoing email, as base64 bytes. */
export interface OutgoingMailAttachment {
  name: string;
  mimeType: string;
  dataBase64: string;
}

/** The metadata a content review of one attachment reports (plugin-files `reviewMailAttachment`). */
export interface ReviewedMailAttachment {
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  text?: string;
}

/** Host content review of one outgoing attachment. It throws for a refused file. */
export type MailAttachmentReviewer = (
  file: OutgoingMailAttachment,
) => Promise<ReviewedMailAttachment>;

/**
 * Outgoing attachment limits shared by the composer and the operation check.
 * Servers without the multi-attachment policy publish maximumOutgoing 1.
 */
export const outgoingAttachmentLimits = {
  maximumFiles: 10,
  maximumTotalBytes: 5 * 1024 * 1024,
} as const;

export function attachmentBytes(file: { dataBase64: string }): number {
  const padding = file.dataBase64.endsWith("==")
    ? 2
    : file.dataBase64.endsWith("=")
      ? 1
      : 0;
  return Math.max(0, Math.floor((file.dataBase64.length * 3) / 4) - padding);
}

/** Validates an outgoing list: count, duplicate names and the combined byte cap. */
export function checkOutgoingAttachments(
  files: readonly { name: string; dataBase64: string }[],
  policy: { maximumOutgoing: number; maximumTotalBytes: number } = {
    maximumOutgoing: outgoingAttachmentLimits.maximumFiles,
    maximumTotalBytes: outgoingAttachmentLimits.maximumTotalBytes,
  },
): void {
  const maximum = Math.min(
    policy.maximumOutgoing,
    outgoingAttachmentLimits.maximumFiles,
  );
  if (files.length > maximum)
    throw new Error(
      maximum === 1
        ? "This account accepts one attachment per email."
        : `Attach at most ${maximum} files.`,
    );
  if (
    new Set(files.map((file) => file.name.toLowerCase())).size !== files.length
  )
    throw new Error("Two attachments have the same name.");
  const total = files.reduce((sum, file) => sum + attachmentBytes(file), 0);
  const cap = Math.min(
    policy.maximumTotalBytes,
    outgoingAttachmentLimits.maximumTotalBytes,
  );
  if (total > cap)
    throw new Error(
      `Attachments exceed ${Math.round(cap / 1048576)} MiB in total.`,
    );
}

export interface OpaqueMailAttachment {
  name: string;
  mimeType: string;
  dataBase64: string;
  size: number;
  sha256: string;
  opaque: true;
}

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

/**
 * Byte-copy review for a save of any type: the name and encoding are checked
 * and the bytes hashed. Content is never decoded, previewed or handed to a
 * viewer. A failed check is an AttachmentRefusedError.
 */
export async function reviewOpaqueAttachment(file: {
  name: string;
  mimeType: string;
  dataBase64: string;
}): Promise<OpaqueMailAttachment> {
  if (
    !file ||
    typeof file.name !== "string" ||
    !file.name.trim() ||
    file.name.length > 120 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control characters in untrusted names.
    /[\\/\x00-\x1f\x7f]/.test(file.name) ||
    file.name === "." ||
    file.name === ".." ||
    typeof file.dataBase64 !== "string" ||
    file.dataBase64.length > 7 * 1024 * 1024
  )
    throw new AttachmentRefusedError("Invalid attachment name or encoding");
  let raw: string;
  try {
    raw = atob(file.dataBase64);
  } catch {
    throw new AttachmentRefusedError("Invalid attachment name or encoding");
  }
  if (btoa(raw) !== file.dataBase64 || raw.length > 5 * 1024 * 1024)
    throw new AttachmentRefusedError("Attachment exceeds 5 MiB");
  const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
  const mimeType =
    typeof file.mimeType === "string" &&
    /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/i.test(
      file.mimeType,
    )
      ? file.mimeType.toLowerCase()
      : "application/octet-stream";
  return {
    name: file.name,
    mimeType,
    dataBase64: file.dataBase64,
    size: bytes.length,
    sha256,
    opaque: true,
  };
}

/**
 * Wraps a host content reviewer so its rejection is typed: the message is
 * unchanged and a refusal is never reported as Gmail being unavailable.
 */
export function refusingAttachmentReviewer(
  review: MailAttachmentReviewer,
): MailAttachmentReviewer {
  return async (file) => {
    try {
      return await review(file);
    } catch (error) {
      if (
        error instanceof AttachmentRefusedError ||
        (!!error &&
          typeof error === "object" &&
          (error as { name?: unknown }).name === "AttachmentRefusedError")
      )
        throw error;
      throw new AttachmentRefusedError(
        error instanceof Error ? error.message : undefined,
      );
    }
  };
}
