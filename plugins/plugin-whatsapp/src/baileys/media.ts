/**
 * Authorizes, downloads, authenticates, and decrypts personal WhatsApp media.
 * Provider metadata is validated before the core DNS-pinned fetch boundary;
 * only integrity-checked plaintext bytes leave this module.
 */
import crypto from "node:crypto";
import { detectMime, ElizaError, type FetchMediaOptions, fetchRemoteMedia } from "@elizaos/core";
import {
  extractMessageContent,
  getMediaKeys,
  getUrlFromDirectPath,
  type proto,
} from "@whiskeysockets/baileys";
import type { PersonalMediaMetadata } from "../types";

export type PersonalMediaKind = "image" | "audio" | "video" | "document";

export interface VerifiedPersonalMedia {
  bytes: Buffer;
  mimeType: string;
  fileName?: string;
}

type MediaProto =
  | proto.Message.IImageMessage
  | proto.Message.IAudioMessage
  | proto.Message.IVideoMessage
  | proto.Message.IDocumentMessage;

function mediaError(
  code: string,
  message: string,
  context: Record<string, unknown>,
  cause?: unknown
): ElizaError {
  return new ElizaError(message, { code, context, cause, severity: "fatal" });
}

function exactBytes(value: Uint8Array | null | undefined, length: number): Uint8Array | undefined {
  return value?.byteLength === length ? value : undefined;
}

function readFileLength(value: unknown): number | undefined {
  const numberValue = Number(value);
  return Number.isSafeInteger(numberValue) && numberValue > 0 ? numberValue : undefined;
}

function normalizeDeclaredMime(value: string | null | undefined): string | undefined {
  const mime = value?.split(";")[0]?.trim().toLowerCase();
  return mime || undefined;
}

function mimeMatchesKind(mimeType: string | undefined, kind: PersonalMediaKind): boolean {
  if (mimeType === undefined) return false;
  return mimeType.startsWith(`${kind}/`);
}

function mediaProtoForMessage(message: proto.IMessage): {
  kind: PersonalMediaKind;
  media: MediaProto;
} | null {
  if (message.imageMessage) return { kind: "image", media: message.imageMessage };
  if (message.audioMessage) return { kind: "audio", media: message.audioMessage };
  if (message.videoMessage) return { kind: "video", media: message.videoMessage };
  if (message.documentMessage) return { kind: "document", media: message.documentMessage };
  return null;
}

/** Extract and structurally authorize provider media metadata without network I/O. */
export function extractPersonalMediaMetadata(
  message: proto.IWebMessageInfo
): PersonalMediaMetadata | undefined {
  const content = extractMessageContent(message.message);
  const selected = content ? mediaProtoForMessage(content) : null;
  if (!selected) return undefined;

  const mediaKey = exactBytes(selected.media.mediaKey, 32);
  const fileSha256 = exactBytes(selected.media.fileSha256, 32);
  const fileEncSha256 = exactBytes(selected.media.fileEncSha256, 32);
  const fileLength = readFileLength(selected.media.fileLength);
  const mimeType = normalizeDeclaredMime(selected.media.mimetype);
  const directPath = selected.media.directPath?.trim() || undefined;
  const url = selected.media.url?.trim() || undefined;

  if (!mediaKey || !fileSha256 || !fileEncSha256 || !fileLength || !mimeType) {
    throw mediaError(
      "WHATSAPP_PERSONAL_MEDIA_METADATA_INVALID",
      "Personal WhatsApp media metadata is incomplete or malformed",
      { messageType: selected.kind }
    );
  }
  if (!directPath && !url) {
    throw mediaError(
      "WHATSAPP_PERSONAL_MEDIA_LOCATION_MISSING",
      "Personal WhatsApp media has no provider download location",
      { messageType: selected.kind }
    );
  }
  if (directPath && (!directPath.startsWith("/") || directPath.startsWith("//"))) {
    throw mediaError(
      "WHATSAPP_PERSONAL_MEDIA_LOCATION_INVALID",
      "Personal WhatsApp media direct path is invalid",
      { messageType: selected.kind }
    );
  }
  if (selected.kind !== "document" && !mimeType.startsWith(`${selected.kind}/`)) {
    throw mediaError(
      "WHATSAPP_PERSONAL_MEDIA_TYPE_MISMATCH",
      "Personal WhatsApp media type does not match its message envelope",
      { messageType: selected.kind, mimeType }
    );
  }

  return {
    kind: selected.kind,
    mediaKey,
    fileSha256,
    fileEncSha256,
    fileLength,
    mimeType,
    ...(directPath ? { directPath } : {}),
    ...(url ? { url } : {}),
    ...(selected.kind === "document" && (selected.media as proto.Message.IDocumentMessage).fileName
      ? { fileName: (selected.media as proto.Message.IDocumentMessage).fileName ?? undefined }
      : {}),
  };
}

function authorizedDownloadUrl(metadata: PersonalMediaMetadata): string {
  let parsed: URL;
  try {
    const value = metadata.directPath ? getUrlFromDirectPath(metadata.directPath) : metadata.url;
    parsed = new URL(value ?? "");
  } catch (error) {
    // error-policy:J2 Provider locations are untrusted and retain their parse cause.
    throw mediaError(
      "WHATSAPP_PERSONAL_MEDIA_LOCATION_INVALID",
      "Personal WhatsApp media location is not a valid URL",
      { messageType: metadata.kind },
      error
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    !(host === "whatsapp.net" || host.endsWith(".whatsapp.net") || host.endsWith(".fbcdn.net"))
  ) {
    throw mediaError(
      "WHATSAPP_PERSONAL_MEDIA_LOCATION_DENIED",
      "Personal WhatsApp media must use an authorized HTTPS provider host",
      { messageType: metadata.kind, protocol: parsed.protocol, hostname: host }
    );
  }
  return parsed.toString();
}

function digest(bytes: Uint8Array): Buffer {
  return crypto.createHash("sha256").update(bytes).digest();
}

function assertEqualDigest(
  actual: Uint8Array,
  expected: Uint8Array,
  code: string,
  kind: PersonalMediaKind
): void {
  if (actual.byteLength !== expected.byteLength || !crypto.timingSafeEqual(actual, expected)) {
    throw mediaError(code, "Personal WhatsApp media failed provider integrity verification", {
      messageType: kind,
    });
  }
}

function decryptAuthenticatedMedia(metadata: PersonalMediaMetadata, encrypted: Buffer): Buffer {
  if (encrypted.length < 26) {
    throw mediaError(
      "WHATSAPP_PERSONAL_MEDIA_RESPONSE_CORRUPT",
      "Personal WhatsApp media response is too short",
      { messageType: metadata.kind, encryptedBytes: encrypted.length }
    );
  }
  assertEqualDigest(
    digest(encrypted),
    metadata.fileEncSha256,
    "WHATSAPP_PERSONAL_MEDIA_ENCRYPTED_HASH_MISMATCH",
    metadata.kind
  );

  return Buffer.from(encrypted);
}

export async function fetchVerifiedPersonalMedia(
  metadata: PersonalMediaMetadata,
  maxBytes: number,
  fetchOptions: Pick<
    FetchMediaOptions,
    "fetchImpl" | "lookupFn" | "pinnedFetchImpl" | "ssrfPolicy" | "timeoutMs"
  > = {}
): Promise<VerifiedPersonalMedia> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || metadata.fileLength > maxBytes) {
    throw mediaError(
      "WHATSAPP_PERSONAL_MEDIA_SIZE_DENIED",
      "Personal WhatsApp media exceeds the configured byte limit",
      { messageType: metadata.kind, declaredBytes: metadata.fileLength, maxBytes }
    );
  }
  const url = authorizedDownloadUrl(metadata);
  let encrypted: Buffer;
  try {
    const result = await fetchRemoteMedia({
      url,
      maxBytes: maxBytes + 32,
      maxRedirects: 0,
      timeoutMs: fetchOptions.timeoutMs ?? 15_000,
      rejectContentEncoding: true,
      ...fetchOptions,
    });
    encrypted = decryptAuthenticatedMedia(metadata, result.buffer);
  } catch (error) {
    if (error instanceof ElizaError) throw error;
    // error-policy:J2 Guarded transport failures are classified for the connector boundary.
    throw mediaError(
      "WHATSAPP_PERSONAL_MEDIA_FETCH_FAILED",
      "Personal WhatsApp media could not be fetched through the guarded transport",
      { messageType: metadata.kind },
      error
    );
  }

  const { cipherKey, iv, macKey } = await getMediaKeys(metadata.mediaKey, metadata.kind);
  if (!cipherKey || !iv || !macKey) {
    throw mediaError(
      "WHATSAPP_PERSONAL_MEDIA_KEYS_INVALID",
      "Personal WhatsApp media key derivation returned incomplete material",
      { messageType: metadata.kind }
    );
  }
  const ciphertext = encrypted.subarray(0, -10);
  const receivedMac = encrypted.subarray(-10);
  const expectedMac = crypto
    .createHmac("sha256", macKey)
    .update(iv)
    .update(ciphertext)
    .digest()
    .subarray(0, 10);
  assertEqualDigest(
    receivedMac,
    expectedMac,
    "WHATSAPP_PERSONAL_MEDIA_MAC_MISMATCH",
    metadata.kind
  );

  let bytes: Buffer;
  try {
    const decipher = crypto.createDecipheriv("aes-256-cbc", cipherKey, iv);
    bytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    // error-policy:J2 Authenticated ciphertext that cannot decrypt remains a provider-integrity failure.
    throw mediaError(
      "WHATSAPP_PERSONAL_MEDIA_DECRYPT_FAILED",
      "Personal WhatsApp media could not be decrypted",
      { messageType: metadata.kind },
      error
    );
  }
  if (bytes.length !== metadata.fileLength || bytes.length > maxBytes) {
    throw mediaError(
      "WHATSAPP_PERSONAL_MEDIA_LENGTH_MISMATCH",
      "Personal WhatsApp media plaintext length does not match provider metadata",
      { messageType: metadata.kind, actualBytes: bytes.length, declaredBytes: metadata.fileLength }
    );
  }
  assertEqualDigest(
    digest(bytes),
    metadata.fileSha256,
    "WHATSAPP_PERSONAL_MEDIA_PLAINTEXT_HASH_MISMATCH",
    metadata.kind
  );

  const detectedMime = await detectMime({ buffer: bytes, headerMime: metadata.mimeType });
  if (metadata.kind !== "document" && !mimeMatchesKind(detectedMime, metadata.kind)) {
    throw mediaError(
      "WHATSAPP_PERSONAL_MEDIA_CONTENT_TYPE_MISMATCH",
      "Personal WhatsApp media bytes do not match the declared message type",
      {
        messageType: metadata.kind,
        declaredMimeType: metadata.mimeType,
        detectedMimeType: detectedMime,
      }
    );
  }

  return {
    bytes,
    mimeType: detectedMime ?? metadata.mimeType,
    ...(metadata.fileName ? { fileName: metadata.fileName } : {}),
  };
}
