/** Delivery transport selected for a provider-managed phone OTP challenge. */
import { logger } from "@elizaos/logger";
export type ManagedOtpDeliveryChannel = "sms" | "whatsapp";

/**
 * Pluggable SMS provider interface. Implementations send a short text body
 * to an E.164-formatted phone number.
 */
export interface SmsProvider {
  /** Defaults to SMS-only; test doubles may explicitly emulate other channels. */
  readonly otpDeliveryChannels?: readonly ManagedOtpDeliveryChannel[];
  send(to: string, body: string): Promise<void>;
}

/**
 * Provider-managed SMS OTP lifecycle. Unlike {@link SmsProvider}, the remote
 * provider owns code generation and verification as one bounded challenge.
 */
export interface ManagedSmsOtpProvider {
  /** Provider-side lifetime of an active OTP challenge. */
  readonly challengeTtlMs: number;
  /**
   * Lifetime of the per-phone operation lock. It must cover one bounded
   * provider request plus clock skew so sends and checks cannot overlap.
   */
  readonly operationLockTtlMs: number;
  /**
   * Pre-send purpose-reservation TTL. It must cover provider validity, both a
   * bounded send and a bounded check window, and clock skew.
   */
  readonly reservationTtlMs: number;
  /** Starts or resends a challenge on the explicit transport. */
  send(
    to: string,
    channel: ManagedOtpDeliveryChannel,
  ): Promise<{ expiresAt: Date }>;
  verify(to: string, code: string): Promise<boolean>;
}

/**
 * Typed delivery failure raised by SMS providers. Deliberately generic: the
 * raw provider error body can carry account/phone metadata and must never
 * propagate into thrown errors, logs, or API responses (SEC-061).
 */
export class SmsDeliveryError extends Error {
  constructor(message = "SMS delivery failed") {
    super(message);
    this.name = "SmsDeliveryError";
  }
}

/** Generic verification failure that never carries provider response data. */
export class SmsVerificationError extends Error {
  constructor(message = "SMS verification failed") {
    super(message);
    this.name = "SmsVerificationError";
  }
}

/**
 * Verification could not reach the provider-check boundary. API callers may
 * safely roll back a claim-first invalid-attempt slot for this disposition.
 */
export class SmsVerificationNotAttemptedError extends SmsVerificationError {
  constructor() {
    super();
    this.name = "SmsVerificationNotAttemptedError";
  }
}

export class ConsoleSmsProvider implements SmsProvider {
  async send(to: string, body: string): Promise<void> {
    logger.info(
      {
        details: [
          [
            "─────────────────────────────────────────",
            `[ConsoleSmsProvider] SMS`,
            `To: ${to}`,
            "",
            body,
            "─────────────────────────────────────────",
          ].join("\n"),
        ],
      },
      "[Login:sms-provider] info",
    );
  }
}

export interface TwilioSmsProviderConfig {
  accountSid: string;
  authToken: string;
  /** Sender — phone number, alphanumeric ID, or Messaging Service SID (MGxxxx). */
  from: string;
}

export class TwilioSmsProvider implements SmsProvider {
  private accountSid: string;
  private authToken: string;
  private from: string;

  constructor(config: TwilioSmsProviderConfig) {
    if (!config.accountSid || !config.authToken || !config.from) {
      throw new Error(
        "TwilioSmsProvider: accountSid, authToken, and from are required",
      );
    }
    this.accountSid = config.accountSid;
    this.authToken = config.authToken;
    this.from = config.from;
  }

  async send(to: string, body: string): Promise<void> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    const params = new URLSearchParams({ To: to, Body: body });
    if (this.from.startsWith("MG")) {
      params.set("MessagingServiceSid", this.from);
    } else {
      params.set("From", this.from);
    }
    const auth = btoa(`${this.accountSid}:${this.authToken}`);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    if (!res.ok) {
      // Discard the provider error body — it can carry account/phone metadata.
      // Only the status code is logged server-side.
      logger.warn(
        {
          details: [
            `[steward:auth] Twilio SMS send failed with status ${res.status}`,
          ],
        },
        "[Login:sms-provider] warn",
      );
      throw new SmsDeliveryError();
    }
  }
}

export interface TwilioVerifyProviderConfig {
  accountSid: string;
  authToken: string;
  /** Verify v2 Service SID (VAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx). */
  serviceSid: string;
  /**
   * Exact token validity configured on the Verify Service, in seconds. Twilio
   * allows 120 through 86400. This must not be guessed locally because Verify
   * reuses the same code for the configured validity window.
   */
  tokenTtlSeconds: number;
  /** Request timeout override for tests and constrained runtimes. Default: 15 seconds. */
  requestTimeoutMs?: number;
}

const TWILIO_VERIFY_MIN_TOKEN_TTL_SECONDS = 120;
const TWILIO_VERIFY_MAX_TOKEN_TTL_SECONDS = 24 * 60 * 60;
const TWILIO_VERIFY_DEFAULT_REQUEST_TIMEOUT_MS = 15 * 1000;
const TWILIO_VERIFY_MAX_REQUEST_TIMEOUT_MS = 60 * 1000;
const TWILIO_VERIFY_CLOCK_SKEW_MS = 5 * 1000;

type TwilioVerifyResponse = {
  status?: unknown;
  date_created?: unknown;
};

async function readTwilioVerifyResponse(
  response: Response,
): Promise<TwilioVerifyResponse | null> {
  try {
    return (await response.json()) as TwilioVerifyResponse;
  } catch {
    return null;
  }
}

/**
 * Twilio Verify v2 adapter. Verify owns the OTP and compliant delivery route;
 * Steward retains the local auth-purpose binding in {@link PhoneAuth}.
 */
export class TwilioVerifyProvider implements ManagedSmsOtpProvider {
  readonly challengeTtlMs: number;
  readonly operationLockTtlMs: number;
  readonly reservationTtlMs: number;
  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly serviceSid: string;
  private readonly requestTimeoutMs: number;

  constructor(config: TwilioVerifyProviderConfig) {
    if (!config.accountSid || !config.authToken) {
      throw new Error(
        "TwilioVerifyProvider: accountSid and authToken are required",
      );
    }
    if (!/^VA[0-9a-fA-F]{32}$/.test(config.serviceSid)) {
      throw new Error(
        "TwilioVerifyProvider: a valid Verify Service SID is required",
      );
    }
    if (
      !Number.isSafeInteger(config.tokenTtlSeconds) ||
      config.tokenTtlSeconds < TWILIO_VERIFY_MIN_TOKEN_TTL_SECONDS ||
      config.tokenTtlSeconds > TWILIO_VERIFY_MAX_TOKEN_TTL_SECONDS
    ) {
      throw new Error(
        "TwilioVerifyProvider: tokenTtlSeconds must be between 120 and 86400",
      );
    }
    const requestTimeoutMs =
      config.requestTimeoutMs ?? TWILIO_VERIFY_DEFAULT_REQUEST_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(requestTimeoutMs) ||
      requestTimeoutMs <= 0 ||
      requestTimeoutMs > TWILIO_VERIFY_MAX_REQUEST_TIMEOUT_MS
    ) {
      throw new Error(
        "TwilioVerifyProvider: requestTimeoutMs must be between 1 and 60000",
      );
    }
    this.accountSid = config.accountSid;
    this.authToken = config.authToken;
    this.serviceSid = config.serviceSid;
    this.requestTimeoutMs = requestTimeoutMs;
    this.challengeTtlMs = config.tokenTtlSeconds * 1000;
    this.operationLockTtlMs =
      this.requestTimeoutMs + TWILIO_VERIFY_CLOCK_SKEW_MS;
    // The purpose reservation begins before delivery and can also be read by a
    // check that starts at the provider-expiry boundary. Keep it live across
    // both bounded network windows plus provider/local clock skew.
    this.reservationTtlMs = this.challengeTtlMs + 2 * this.operationLockTtlMs;
  }

  async send(
    to: string,
    channel: ManagedOtpDeliveryChannel,
  ): Promise<{ expiresAt: Date }> {
    let response: Response;
    try {
      response = await fetch(
        `https://verify.twilio.com/v2/Services/${this.serviceSid}/Verifications`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${btoa(`${this.accountSid}:${this.authToken}`)}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ To: to, Channel: channel }).toString(),
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        },
      );
    } catch {
      logger.warn(
        { details: ["[steward:auth] Twilio Verify send request failed"] },
        "[Login:sms-provider] warn",
      );
      throw new SmsDeliveryError();
    }
    if (!response.ok) {
      logger.warn(
        {
          details: [
            `[steward:auth] Twilio Verify send failed with status ${response.status}`,
          ],
        },
        "[Login:sms-provider] warn",
      );
      throw new SmsDeliveryError();
    }

    const payload = await readTwilioVerifyResponse(response);
    const createdAtMs =
      typeof payload?.date_created === "string"
        ? Date.parse(payload.date_created)
        : Number.NaN;
    if (
      payload?.status !== "pending" ||
      !Number.isFinite(createdAtMs) ||
      createdAtMs > Date.now() + TWILIO_VERIFY_CLOCK_SKEW_MS
    ) {
      logger.warn(
        {
          details: [
            "[steward:auth] Twilio Verify send returned an unexpected response",
          ],
        },
        "[Login:sms-provider] warn",
      );
      throw new SmsDeliveryError();
    }
    const expiresAtMs = createdAtMs + this.challengeTtlMs;
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= Date.now()) {
      logger.warn(
        {
          details: [
            "[steward:auth] Twilio Verify send returned an expired challenge",
          ],
        },
        "[Login:sms-provider] warn",
      );
      throw new SmsDeliveryError();
    }
    return { expiresAt: new Date(expiresAtMs) };
  }

  async verify(to: string, code: string): Promise<boolean> {
    let response: Response;
    try {
      response = await fetch(
        `https://verify.twilio.com/v2/Services/${this.serviceSid}/VerificationCheck`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${btoa(`${this.accountSid}:${this.authToken}`)}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ To: to, Code: code }).toString(),
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        },
      );
    } catch {
      logger.warn(
        { details: ["[steward:auth] Twilio Verify check request failed"] },
        "[Login:sms-provider] warn",
      );
      throw new SmsVerificationError();
    }

    // Verify removes expired, canceled, and max-attempt challenges. They are
    // indistinguishable to the caller and remain an ordinary invalid OTP.
    if (response.status === 404) return false;
    if (!response.ok) {
      logger.warn(
        {
          details: [
            `[steward:auth] Twilio Verify check failed with status ${response.status}`,
          ],
        },
        "[Login:sms-provider] warn",
      );
      throw new SmsVerificationError();
    }

    const payload = await readTwilioVerifyResponse(response);
    if (!payload || typeof payload.status !== "string") {
      logger.warn(
        {
          details: [
            "[steward:auth] Twilio Verify check returned an unexpected response",
          ],
        },
        "[Login:sms-provider] warn",
      );
      throw new SmsVerificationError();
    }
    return payload.status === "approved";
  }
}

export interface MockSmsMessage {
  to: string;
  body: string;
  sentAt: Date;
  code?: string;
}

const OTP_RE = /\b(\d{6,8})\b/;

class MockSmsInboxRegistry {
  private byPhone = new Map<string, MockSmsMessage[]>();
  push(msg: MockSmsMessage): void {
    const list = this.byPhone.get(msg.to) ?? [];
    list.push(msg);
    this.byPhone.set(msg.to, list);
  }
  last(phone: string): MockSmsMessage | undefined {
    const list = this.byPhone.get(phone);
    return list?.[list.length - 1];
  }
  all(phone: string): MockSmsMessage[] {
    return [...(this.byPhone.get(phone) ?? [])];
  }
  clear(phone?: string): void {
    if (phone) this.byPhone.delete(phone);
    else this.byPhone.clear();
  }
}

export const MockSmsInbox = new MockSmsInboxRegistry();

export class MockSmsProvider implements SmsProvider {
  readonly otpDeliveryChannels = ["sms", "whatsapp"] as const;

  async send(to: string, body: string): Promise<void> {
    MockSmsInbox.push({
      to,
      body,
      sentAt: new Date(),
      code: body.match(OTP_RE)?.[1],
    });
  }
}
