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
 * Strips WhatsApp target prefixes from a value
 */
function stripWhatsAppTargetPrefixes(value: string): string {
  let candidate = value.trim();
  for (;;) {
    const before = candidate;
    candidate = candidate.replace(/^whatsapp:/i, "").trim();
    if (candidate === before) {
      return candidate;
    }
  }
}

/**
 * Normalizes a phone number to E.164 format
 */
export function normalizeE164(input: string): string {
  const stripped = input.replace(/[\s\-().]+/g, "");
  const digitsOnly = stripped.replace(/[^\d+]/g, "");

  if (!digitsOnly) {
    return "";
  }

  // If it starts with +, keep as-is (already E.164)
  if (digitsOnly.startsWith("+")) {
    return digitsOnly;
  }

  // If it starts with 00, replace with +
  if (digitsOnly.startsWith("00")) {
    return `+${digitsOnly.slice(2)}`;
  }

  // Assume it's a full number without the +
  if (digitsOnly.length >= 10) {
    return `+${digitsOnly}`;
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

  // Hard break at limit
  return {
    chunk: text.slice(0, limit),
    remainder: text.slice(limit),
  };
}

/**
 * Chunks text for WhatsApp messages
 */
export function chunkWhatsAppText(text: string, opts: ChunkWhatsAppTextOpts = {}): string[] {
  const limit = opts.limit ?? WHATSAPP_TEXT_CHUNK_LIMIT;

  if (!text?.trim()) {
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
  return `${text.slice(0, maxLength - 3)}...`;
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
  // Format as +XX XXX XXX XXXX for display
  const digits = normalized.replace(/^\+/, "");
  if (digits.length <= 10) {
    return normalized;
  }
  // Simple formatting: country code + rest
  const countryCode = digits.slice(0, digits.length - 10);
  const rest = digits.slice(-10);
  return `+${countryCode} ${rest.slice(0, 3)} ${rest.slice(3, 6)} ${rest.slice(6)}`;
}
