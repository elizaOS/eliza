import { logger } from "@feed/shared";
import { getNotificationEmailFromEnv } from "../env";

export interface ParsedEmailAddress {
  email: string;
  name?: string;
}

export function parseEmailAddress(rawValue: string): ParsedEmailAddress | null {
  const trimmed = rawValue.trim();

  const namedMatch = trimmed.match(
    /^(?<name>[^<>]+?)\s*<(?<email>[^<>\s@]+@[^<>\s@]+)>$/,
  );

  const namedEmail = namedMatch?.groups?.email?.trim().toLowerCase();
  if (namedEmail) {
    const rawName = namedMatch?.groups?.name?.trim();
    const normalizedName = rawName?.replace(/^"|"$/g, "");
    return normalizedName
      ? { email: namedEmail, name: normalizedName }
      : { email: namedEmail };
  }

  const isPlainEmail = /^[^<>\s@]+@[^<>\s@]+$/.test(trimmed);
  if (isPlainEmail) {
    return { email: trimmed.toLowerCase() };
  }

  return null;
}

export function normalizeEmail(
  rawEmail: string | null | undefined,
): string | null {
  if (!rawEmail) return null;
  const normalized = rawEmail.trim().toLowerCase();
  return /^[^<>\s@]+@[^<>\s@]+$/.test(normalized) ? normalized : null;
}

export interface SendGridEnvConfig {
  apiKey: string;
  from: ParsedEmailAddress;
}

/**
 * Resolves SendGrid configuration from environment variables.
 * Returns null (with appropriate logging) when the provider is not configured.
 */
export function resolveSendGridConfig(
  callerTag: string,
  logContext?: Record<string, unknown>,
): SendGridEnvConfig | null {
  const apiKey = process.env.SENDGRID_API_KEY?.trim();
  if (!apiKey) {
    logger.debug(
      `Skipping email: SENDGRID_API_KEY is not configured`,
      logContext ?? {},
      callerTag,
    );
    return null;
  }

  const fromAddress = getNotificationEmailFromEnv();
  if (!fromAddress) {
    logger.warn(
      `Skipping email: sender address is not configured`,
      logContext ?? {},
      callerTag,
    );
    return null;
  }

  const from = parseEmailAddress(fromAddress);
  if (!from) {
    logger.warn(
      `Skipping email: sender address format is invalid`,
      { ...logContext, fromAddress },
      callerTag,
    );
    return null;
  }

  return { apiKey, from };
}

export interface SendGridPayload {
  from: ParsedEmailAddress;
  personalizations: Array<{
    to: Array<{ email: string }>;
    /** Per-recipient subject (SendGrid v3). Omit when using top-level `subject`. */
    subject?: string;
  }>;
  /** Default subject when personalizations omit `subject`. */
  subject?: string;
  content: Array<{ type: string; value: string }>;
  headers?: Record<string, string>;
}

/**
 * Low-level SendGrid send. Returns a result object so callers can decide
 * how to handle failures without catching exceptions for expected errors.
 */
export async function sendViaSendGrid(
  apiKey: string,
  payload: SendGridPayload,
  callerTag: string,
  logContext?: Record<string, unknown>,
): Promise<{ sent: boolean; reason?: string }> {
  try {
    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const responseBody = await response.text().catch(() => "");
      logger.warn(
        "Email send failed",
        { ...logContext, status: response.status, responseBody },
        callerTag,
      );
      return { sent: false, reason: "provider_error" };
    }

    return { sent: true };
  } catch (error) {
    logger.error(
      "Email send request failed",
      { ...logContext, error: String(error) },
      callerTag,
    );
    return { sent: false, reason: "network_error" };
  }
}

// ---------------------------------------------------------------------------
// Recipient email resolution
// ---------------------------------------------------------------------------

export interface EmailRecipientRow {
  id: string;
  email: string | null;
  emailVerified: boolean;
  privyId: string | null;
}

/**
 * Resolves a verified email address for a recipient. Checks the profile email
 * first (only if verified), then falls back to Privy verified emails.
 * Returns null if no verified email can be found.
 */
export async function resolveRecipientEmail(
  recipient: EmailRecipientRow,
  callerTag = "EmailUtils",
): Promise<string | null> {
  const profileEmail = normalizeEmail(recipient.email);
  if (profileEmail && recipient.emailVerified) {
    return profileEmail;
  }

  // Phase 2: Privy user lookup removed. Email is now stored directly in Feed's
  // users.email column (populated by Steward at login time).
  // If we reach this point without an email, log and return null.
  if (!profileEmail) {
    logger.debug(
      "Could not resolve recipient email — no email in DB record",
      { userId: recipient.id },
      callerTag,
    );
  }

  return null;
}
