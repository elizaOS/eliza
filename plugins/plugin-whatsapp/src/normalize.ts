/**
 * Phone/JID normalization and outbound-text chunking for the WhatsApp connector.
 * Parses E.164 numbers, recognizes user JIDs and LIDs, detects chat type, and
 * normalizes send targets into a canonical form both transports agree on. Shared
 * by the runtime service, message adapters, and account resolution.
 */

import { truncateWellFormed } from "@elizaos/core";
import { stripWhatsAppTargetPrefixes } from "./whatsapp-target-prefix";

/**
 * WhatsApp text chunk limit
 */
export const WHATSAPP_TEXT_CHUNK_LIMIT = 4096;

/**
 * Regex for WhatsApp user JID (e.g., "41796666864:0@s.whatsapp.net")
 */
const WHATSAPP_USER_JID_RE = /^(\d+)(?::\d+)?@s\.whatsapp\.net$/i;

/**
 * Regex for WhatsApp LID (e.g., "123@lid")
 */
const WHATSAPP_LID_RE = /^(\d+)@lid$/i;

/**
 * Normalizes a phone number to E.164 format
 */
export function normalizeE164(input: string): string {
  const candidate = input.trim();
  if (!candidate || /[^\d+\s\-().]/.test(candidate)) {
    return "";
  }
  const stripped = candidate.replace(/[\s\-().]+/g, "");
  if (
    (stripped.match(/\+/g) ?? []).length > 1 ||
    (stripped.includes("+") && !stripped.startsWith("+"))
  ) {
    return "";
  }
  const digitsOnly = stripped.replace(/[^\d+]/g, "");

  if (!digitsOnly || digitsOnly === "+") {
    return "";
  }

  // If it starts with +, keep as-is (already E.164)
  if (digitsOnly.startsWith("+")) {
    return /^\+[1-9]\d{1,14}$/.test(digitsOnly) ? digitsOnly : "";
  }

  // If it starts with 00, replace with +
  if (digitsOnly.startsWith("00")) {
    const international = `+${digitsOnly.slice(2)}`;
    return /^\+[1-9]\d{1,14}$/.test(international) ? international : "";
  }

  // Assume it's a full number without the +
  if (digitsOnly.length >= 10) {
    return /^[1-9]\d{9,14}$/.test(digitsOnly) ? `+${digitsOnly}` : "";
  }

  // Return as-is if too short
  return digitsOnly;
}

/**
 * Checks if a value is a WhatsApp group JID (e.g., "123456789-987654321@g.us")
 */
export function isWhatsAppGroupJid(value: string): boolean {
  const candidate = stripWhatsAppTargetPrefixes(value);
  const lower = candidate.toLowerCase();
  if (!lower.endsWith("@g.us")) {
    return false;
  }
  const localPart = candidate.slice(0, candidate.length - "@g.us".length);
  if (!localPart || localPart.includes("@")) {
    return false;
  }
  return /^[0-9]+(-[0-9]+)*$/.test(localPart);
}

/**
 * Checks if a value looks like a WhatsApp user target
 * (e.g., "41796666864:0@s.whatsapp.net" or "123@lid")
 */
export function isWhatsAppUserTarget(value: string): boolean {
  const candidate = stripWhatsAppTargetPrefixes(value);
  return WHATSAPP_USER_JID_RE.test(candidate) || WHATSAPP_LID_RE.test(candidate);
}

/**
 * Extracts the phone number from a WhatsApp user JID
 * "41796666864:0@s.whatsapp.net" -> "41796666864"
 * "123456@lid" -> "123456"
 */
function extractUserJidPhone(jid: string): string | null {
  const userMatch = jid.match(WHATSAPP_USER_JID_RE);
  if (userMatch) {
    return userMatch[1];
  }
  const lidMatch = jid.match(WHATSAPP_LID_RE);
  if (lidMatch) {
    return lidMatch[1];
  }
  return null;
}

/**
 * Normalizes a WhatsApp target (phone number, user JID, or group JID)
 * Returns null if the target is invalid
 */
export function normalizeWhatsAppTarget(value: string): string | null {
  const candidate = stripWhatsAppTargetPrefixes(value);
  if (!candidate) {
    return null;
  }

  // Handle group JIDs
  if (isWhatsAppGroupJid(candidate)) {
    const localPart = candidate.slice(0, candidate.length - "@g.us".length);
    return `${localPart}@g.us`;
  }

  // Handle user JIDs (e.g., "41796666864:0@s.whatsapp.net")
  if (isWhatsAppUserTarget(candidate)) {
    const phone = extractUserJidPhone(candidate);
    if (!phone) {
      return null;
    }
    const normalized = normalizeE164(phone);
    return normalized.length > 1 ? normalized : null;
  }

  // If the caller passed a JID-ish string that we don't understand, fail fast.
  // Otherwise normalizeE164 would happily treat "group:120@g.us" as a phone number.
  if (candidate.includes("@")) {
    return null;
  }

  // Treat as a phone number
  const normalized = normalizeE164(candidate);
  return normalized.length > 1 ? normalized : null;
}

/**
 * Formats a WhatsApp ID for display
 */
export function formatWhatsAppId(id: string): string {
  if (isWhatsAppGroupJid(id)) {
    return `group:${id}`;
  }
  const normalized = normalizeWhatsAppTarget(id);
  return normalized || id;
}

/**
 * Checks if a WhatsApp ID is a group
 */
export function isWhatsAppGroup(id: string): boolean {
  return isWhatsAppGroupJid(id);
}

/**
 * Gets the chat type from a WhatsApp ID
 */
export function getWhatsAppChatType(id: string): "group" | "user" {
  return isWhatsAppGroupJid(id) ? "group" : "user";
}

/**
 * Builds a WhatsApp JID from a phone number
 */
export function buildWhatsAppUserJid(phoneNumber: string): string {
  const normalized = normalizeE164(phoneNumber);
  const digits = normalized.replace(/^\+/, "");
  return `${digits}@s.whatsapp.net`;
}

/**
 * Resolves an outbound Baileys target while preserving transport-native user
 * and group identifiers, including LIDs that are not phone numbers.
 */
export function normalizeBaileysSendTarget(target: string): string {
  if (isWhatsAppGroupJid(target) || isWhatsAppUserTarget(target)) {
    return target;
  }
  const normalized = normalizeWhatsAppTarget(target);
  if (!normalized) {
    throw new Error("WhatsApp send target must be a valid phone number or WhatsApp JID.");
  }
  return buildWhatsAppUserJid(normalized);
}

/**
 * Resolves an outbound Cloud API target to canonical E.164. Cloud sends do not
 * accept Baileys group or LID identifiers, and short local numbers are unsafe
 * because the Cloud API requires an explicit country code.
 */
export function normalizeCloudApiSendTarget(target: string): string {
  const candidate = stripWhatsAppTargetPrefixes(target);
  if (isWhatsAppGroupJid(candidate) || WHATSAPP_LID_RE.test(candidate)) {
    throw new Error("WhatsApp Cloud API send target must be a valid E.164 phone number.");
  }
  const normalized = normalizeWhatsAppTarget(candidate);
  if (!normalized || !/^\+[1-9]\d{1,14}$/.test(normalized)) {
    throw new Error("WhatsApp Cloud API send target must be a valid E.164 phone number.");
  }
  return normalized;
}

/**
 * Options for text chunking
 */
export interface ChunkWhatsAppTextOpts {
  limit?: number;
}

/**
 * Splits text at the last safe break point within the limit
 */
function splitAtBreakPoint(text: string, limit: number): { chunk: string; remainder: string } {
  if (text.length <= limit) {
    return { chunk: text, remainder: "" };
  }

  const searchArea = text.slice(0, limit);

  // Prefer double newlines (paragraph breaks)
  const doubleNewline = searchArea.lastIndexOf("\n\n");
  if (doubleNewline > limit * 0.5) {
    return {
      chunk: text.slice(0, doubleNewline).trimEnd(),
      remainder: text.slice(doubleNewline + 2).trimStart(),
    };
  }

  // Try single newlines
  const singleNewline = searchArea.lastIndexOf("\n");
  if (singleNewline > limit * 0.5) {
    return {
      chunk: text.slice(0, singleNewline).trimEnd(),
      remainder: text.slice(singleNewline + 1).trimStart(),
    };
  }

  // Try sentence boundaries
  const sentenceEnd = Math.max(
    searchArea.lastIndexOf(". "),
    searchArea.lastIndexOf("! "),
    searchArea.lastIndexOf("? ")
  );
  if (sentenceEnd > limit * 0.5) {
    return {
      chunk: text.slice(0, sentenceEnd + 1).trimEnd(),
      remainder: text.slice(sentenceEnd + 2).trimStart(),
    };
  }

  // Try word boundaries
  const space = searchArea.lastIndexOf(" ");
  if (space > limit * 0.5) {
    return {
      chunk: text.slice(0, space).trimEnd(),
      remainder: text.slice(space + 1).trimStart(),
    };
  }

  // Hard break at limit -- truncateWellFormed backs off one unit instead of
  // slicing through a surrogate pair (e.g. a long emoji run with no
  // whitespace/newline/sentence break inside the search area).
  const chunk = truncateWellFormed(text, limit);
  return {
    chunk,
    remainder: text.slice(chunk.length),
  };
}

// The hard-break fallback backs a cut off by one code unit when it would
// split a surrogate pair (see truncateWellFormed). At limit 1 that backoff
// has nowhere to go -- a single code unit can never hold half of an astral
// character -- so it returns "" and the loop makes no progress. Below this,
// no limit can guarantee a non-empty well-formed chunk on every text.
const MIN_CHUNK_LIMIT = 2;

/**
 * Chunks text for WhatsApp messages
 */
export function chunkWhatsAppText(text: string, opts: ChunkWhatsAppTextOpts = {}): string[] {
  const limit = opts.limit ?? WHATSAPP_TEXT_CHUNK_LIMIT;

  if (!Number.isFinite(limit) || limit < MIN_CHUNK_LIMIT) {
    throw new Error(
      `chunkWhatsAppText: limit must be a finite number >= ${MIN_CHUNK_LIMIT} (got ${limit}) -- ` +
        "a one-code-unit bound cannot both preserve an astral character and satisfy the limit."
    );
  }

  if (!text.trim()) {
    return [];
  }

  const normalizedText = text.trim();
  if (normalizedText.length <= limit) {
    return [normalizedText];
  }

  const chunks: string[] = [];
  let remaining = normalizedText;

  while (remaining.length > 0) {
    const { chunk, remainder } = splitAtBreakPoint(remaining, limit);
    if (remainder.length >= remaining.length) {
      // Invariant: every iteration must strictly shrink `remaining`, or this
      // loop never terminates. limit >= MIN_CHUNK_LIMIT rules this out for
      // any text reachable above; this is a fail-closed backstop, not an
      // expected path.
      throw new Error("chunkWhatsAppText: failed to make progress splitting text.");
    }
    if (chunk) {
      chunks.push(chunk);
    }
    remaining = remainder;
  }

  return chunks.filter((c) => c.length > 0);
}

/**
 * Truncates text to a maximum length with ellipsis
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  if (maxLength <= 3) {
    return "...".slice(0, maxLength);
  }
  return `${truncateWellFormed(text, maxLength - 3)}...`;
}

/**
 * Resolves the system location string for logging
 */
export function resolveWhatsAppSystemLocation(params: {
  chatType: "group" | "user";
  chatId: string;
  chatName?: string;
}): string {
  const { chatType, chatId, chatName } = params;
  const name = chatName || chatId.slice(0, 8);
  return `WhatsApp ${chatType}:${name}`;
}

/**
 * Validates a WhatsApp phone number
 */
export function isValidWhatsAppNumber(value: string): boolean {
  const normalized = normalizeWhatsAppTarget(value);
  if (!normalized) {
    return false;
  }
  // Must be E.164 format with at least 10 digits
  if (!normalized.startsWith("+")) {
    return false;
  }
  const digits = normalized.replace(/^\+/, "");
  return /^\d{10,15}$/.test(digits);
}

/**
 * Formats a phone number for WhatsApp display
 */
export function formatWhatsAppPhoneNumber(phoneNumber: string): string {
  const normalized = normalizeE164(phoneNumber);
  if (!normalized) {
    return phoneNumber;
  }
  // Format as country code plus grouped local digits for display.
  const digits = normalized.replace(/^\+/, "");
  if (digits.length <= 10) {
    return normalized;
  }
  // Simple formatting: country code + rest
  const countryCode = digits.slice(0, digits.length - 10);
  const rest = digits.slice(-10);
  return `+${countryCode} ${rest.slice(0, 3)} ${rest.slice(3, 6)} ${rest.slice(6)}`;
}
