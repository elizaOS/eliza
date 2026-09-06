import { randomUUID } from "node:crypto";
import { logger } from "@elizaos/logger";

import { Resend } from "resend";

/**
 * Redacted delivery acceptance receipt: proof that the underlying provider
 * ACCEPTED the message for delivery. Never carries the recipient, subject,
 * body, or any embedded token/code — safe to log as-is.
 */
export interface EmailDeliveryReceipt {
  /** Which provider accepted the message, e.g. "resend" | "console" | "mock". */
  provider: string;
  /** Provider-assigned message id, when the provider returns one. */
  id?: string;
}

/**
 * Typed failure raised when a provider rejects a send (or returns no
 * acceptance receipt). The message is deliberately generic — never the
 * recipient, token, code, or raw provider error text — so it can be logged
 * and surfaced without leaking secrets. The API layer maps this to 502.
 */
export class EmailDeliveryError extends Error {
  constructor(message = "Email delivery failed") {
    super(message);
    this.name = "EmailDeliveryError";
  }
}

/**
 * Typed failure raised when no delivery-capable email provider is configured
 * (e.g. the ConsoleProvider fallback in production). Raised BEFORE any
 * challenge state is created so a misconfigured deployment can never issue
 * an unredeemable-by-email challenge. The API layer maps this to 503.
 */
export class EmailDeliveryNotConfiguredError extends Error {
  constructor(message = "Email delivery is not configured") {
    super(message);
    this.name = "EmailDeliveryNotConfiguredError";
  }
}

/**
 * Pluggable email provider interface.
 * Swap implementations without touching EmailAuth logic.
 *
 * `send` must resolve with an acceptance receipt only after the underlying
 * provider accepted the message, and must THROW when it did not — resolving
 * without a receipt is treated as delivery failure by EmailAuth (fail closed).
 */
export interface EmailProvider {
  send(
    to: string,
    subject: string,
    text: string,
    html?: string,
    options?: { replyTo?: string },
  ): Promise<EmailDeliveryReceipt>;
}

// ---------------------------------------------------------------------------
// ResendProvider — production provider backed by resend.com
// ---------------------------------------------------------------------------

export interface ResendProviderConfig {
  apiKey: string;
  from: string; // e.g. "Steward <login@eliza.app>"
  replyTo?: string;
}

export class ResendProvider implements EmailProvider {
  private client: Resend;
  private from: string;
  private replyTo?: string;

  constructor(config: ResendProviderConfig) {
    this.client = new Resend(config.apiKey);
    this.from = config.from;
    this.replyTo = config.replyTo;
  }

  async send(
    to: string,
    subject: string,
    text: string,
    html?: string,
    options?: { replyTo?: string },
  ): Promise<EmailDeliveryReceipt> {
    const { data, error } = await this.client.emails.send({
      from: this.from,
      to,
      subject,
      text,
      ...(options?.replyTo || this.replyTo
        ? { replyTo: options?.replyTo || this.replyTo }
        : {}),
      ...(html ? { html } : {}),
    });

    if (error) {
      throw new Error(`Resend error: ${error.message}`);
    }
    if (!data || typeof data.id !== "string" || data.id.trim().length === 0) {
      throw new Error("Resend returned no delivery acceptance id");
    }

    return { provider: "resend", id: data.id };
  }
}

// ---------------------------------------------------------------------------
// ConsoleProvider — redacted development delivery receipt (never logs credentials)
// ---------------------------------------------------------------------------

export class ConsoleProvider implements EmailProvider {
  async send(
    to: string,
    subject: string,
    text: string,
    _html?: string,
    options?: { replyTo?: string },
  ): Promise<EmailDeliveryReceipt> {
    logger.info(
      {
        details: [
          [
            "─────────────────────────────────────────",
            `[ConsoleProvider] Magic link email`,
            `To:      [redacted]`,
            "",
            "─────────────────────────────────────────",
          ].join("\n"),
        ],
      },
      "[Login:email-provider] info",
    );
    return { provider: "console" };
  }
}

// ---------------------------------------------------------------------------
// MockEmailProvider — in-memory inbox for e2e testing.
//
// Stores every sent message in a process-wide registry keyed by recipient.
// A test harness can read the most recent message (or the embedded magic-link
// token) via `MockEmailInbox.last(email)` or the static helpers.
//
// NEVER enable in production. The wrapper in the API layer gates this behind
// an explicit `EMAIL_PROVIDER=mock` env var and NODE_ENV !== "production".
// ---------------------------------------------------------------------------

export interface MockEmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  sentAt: Date;
  /** Magic-link token extracted from the text body, if present. */
  token?: string;
  /** Full magic-link URL extracted from the text body, if present. */
  magicLink?: string;
}

function parseMagicLink(text: string): { magicLink?: string; token?: string } {
  let segmentStart = 0;
  while (segmentStart < text.length) {
    while (segmentStart < text.length && text[segmentStart].trim().length === 0)
      segmentStart += 1;
    let segmentEnd = segmentStart;
    while (segmentEnd < text.length && text[segmentEnd].trim().length !== 0)
      segmentEnd += 1;
    if (segmentEnd === segmentStart) break;

    let schemeStart = -1;
    for (let index = segmentStart; index < segmentEnd; index += 1) {
      if (
        text.startsWith("http://", index) ||
        text.startsWith("https://", index)
      ) {
        schemeStart = index;
        break;
      }
    }
    if (schemeStart !== -1) {
      let tokenStart = -1;
      let tokenEnd = -1;
      for (let index = schemeStart; index < segmentEnd; index += 1) {
        if (
          text.startsWith("?token=", index) ||
          text.startsWith("&token=", index)
        ) {
          const candidate = index + 7;
          const code = text.charCodeAt(candidate);
          if (
            (code >= 0x30 && code <= 0x39) ||
            (code >= 0x41 && code <= 0x5a) ||
            (code >= 0x61 && code <= 0x7a) ||
            code === 0x2d ||
            code === 0x5f
          ) {
            let candidateEnd = candidate;
            while (candidateEnd < segmentEnd) {
              const tokenCode = text.charCodeAt(candidateEnd);
              if (
                (tokenCode >= 0x30 && tokenCode <= 0x39) ||
                (tokenCode >= 0x41 && tokenCode <= 0x5a) ||
                (tokenCode >= 0x61 && tokenCode <= 0x7a) ||
                tokenCode === 0x2d ||
                tokenCode === 0x5f
              ) {
                candidateEnd += 1;
              } else {
                break;
              }
            }
            tokenStart = candidate;
            tokenEnd = candidateEnd;
          }
        }
      }
      if (tokenStart !== -1) {
        return {
          magicLink: text.slice(schemeStart, tokenEnd),
          token: text.slice(tokenStart, tokenEnd),
        };
      }
    }
    segmentStart = segmentEnd + 1;
  }
  return {};
}

class MockEmailInboxRegistry {
  private byEmail = new Map<string, MockEmailMessage[]>();

  push(msg: MockEmailMessage): void {
    const key = msg.to.toLowerCase();
    const existing = this.byEmail.get(key) ?? [];
    existing.push(msg);
    this.byEmail.set(key, existing);
  }

  last(email: string): MockEmailMessage | undefined {
    const list = this.byEmail.get(email.toLowerCase());
    return list?.[list.length - 1];
  }

  all(email: string): MockEmailMessage[] {
    return [...(this.byEmail.get(email.toLowerCase()) ?? [])];
  }

  clear(email?: string): void {
    if (email) this.byEmail.delete(email.toLowerCase());
    else this.byEmail.clear();
  }
}

export const MockEmailInbox = new MockEmailInboxRegistry();

export class MockEmailProvider implements EmailProvider {
  async send(
    to: string,
    subject: string,
    text: string,
    html?: string,
    options?: { replyTo?: string },
  ): Promise<EmailDeliveryReceipt> {
    MockEmailInbox.push({
      to,
      subject,
      text,
      ...(html ? { html } : {}),
      ...(options?.replyTo ? { replyTo: options.replyTo } : {}),
      sentAt: new Date(),
      ...parseMagicLink(text),
    });
    return { provider: "mock", id: randomUUID() };
  }
}
