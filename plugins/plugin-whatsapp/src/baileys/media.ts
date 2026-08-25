/**
 * Authorizes, downloads, authenticates, and decrypts personal WhatsApp media.
 * Provider metadata is validated before the core DNS-pinned fetch boundary;
 * only integrity-checked plaintext bytes leave this module.
 */
import crypto from "node:crypto";
import {
  detectMime,
  ElizaError,
  type ElizaErrorSeverity,
  type FetchMediaOptions,
  fetchRemoteMedia,
} from "@elizaos/core";
import { getMediaKeys, getUrlFromDirectPath, type proto } from "@whiskeysockets/baileys";
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

const MAX_DECLARED_MIME_LENGTH = 127;
const MAX_PROVIDER_FILENAME_LENGTH = 240;
const MIME_TOKEN = /^[a-z0-9!#$%&'*+.^_`|~-]+\/[a-z0-9!#$%&'*+.^_`|~-]+$/;
const UNSAFE_FILENAME_CODEPOINT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function mediaError(
  code: string,
  message: string,
  context: Record<string, unknown>,
  cause?: unknown,
  severity: ElizaErrorSeverity = "ephemeral"
): ElizaError {
  return new ElizaError(message, { code, context, cause, severity });
}

function exactBytes(value: Uint8Array | null | undefined, length: number): Uint8Array | undefined {
  return value?.byteLength === length ? value : undefined;
}

function readFileLength(value: unknown): number | undefined {
  const numberValue = Number(value);
  return Number.isSafeInteger(numberValue) && numberValue > 0 ? numberValue : undefined;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function normalizeDeclaredMime(value: string | null | undefined): string | undefined {
  if (typeof value !== "string" || !isWellFormedUnicode(value)) return undefined;
  const mime = value.trim().toLowerCase();
  if (mime.length === 0 || mime.length > MAX_DECLARED_MIME_LENGTH || !MIME_TOKEN.test(mime)) {
    return undefined;
  }
  return mime;
}

function normalizeProviderFilename(
  value: string | null | undefined,
  kind: PersonalMediaKind
): string | undefined {
  if (value === null || value === undefined || value.length === 0) return undefined;
  if (!isWellFormedUnicode(value)) {
    throw mediaError(
      "WHATSAPP_PERSONAL_MEDIA_FILENAME_INVALID",
      "Personal WhatsApp media filename is malformed",
      { messageType: kind }
    );
  }
  const normalized = value.normalize("NFC").trim();
  if (
    normalized.length === 0 ||
    Buffer.byteLength(normalized, "utf8") > MAX_PROVIDER_FILENAME_LENGTH ||
    normalized === "." ||
    normalized === ".." ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    /^[a-z]:/iu.test(normalized) ||
    UNSAFE_FILENAME_CODEPOINT.test(normalized)
  ) {
    throw mediaError(
      "WHATSAPP_PERSONAL_MEDIA_FILENAME_INVALID",
      "Personal WhatsApp media filename is not a safe display name",
      { messageType: kind }
    );
  }
  return normalized;
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
  content: proto.IMessage
): PersonalMediaMetadata | undefined {
  const selected = mediaProtoForMessage(content);
  if (!selected) return undefined;

  const mediaKey = exactBytes(selected.media.mediaKey, 32);
  const fileSha256 = exactBytes(selected.media.fileSha256, 32);
  const fileEncSha256 = exactBytes(selected.media.fileEncSha256, 32);
  const fileLength = readFileLength(selected.media.fileLength);
  const mimeType = normalizeDeclaredMime(selected.media.mimetype);
  const fileName =
    selected.kind === "document"
      ? normalizeProviderFilename(
          (selected.media as proto.Message.IDocumentMessage).fileName,
          selected.kind
        )
      : undefined;
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
    ...(fileName ? { fileName } : {}),
  };
}

function extractUrlHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).host;
  } catch {
    // error-policy:J3 A malformed optional URL cannot supply a direct-path fallback host.
    return undefined;
  }
}

function authorizedDownloadUrl(metadata: PersonalMediaMetadata): string {
  let parsed: URL;
  try {
    const value = metadata.directPath
      ? getUrlFromDirectPath(metadata.directPath, extractUrlHost(metadata.url))
      : metadata.url;
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
    parsed.username !== "" ||
    parsed.password !== "" ||
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
