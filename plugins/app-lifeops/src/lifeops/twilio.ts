import { createIntegrationTelemetrySpan } from "@elizaos/agent";
import { logger } from "@elizaos/core";

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
  fromPhoneNumber: string;
}

export interface TwilioSmsBillingBreakdown {
  segments: number;
  rawCost: number;
  markup: number;
  billedCost: number;
  markupRate: number;
  costPerSegment: number;
}

const TWILIO_SMS_MARKUP_RATE = 0.2;

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function calculateTwilioSmsBilling(
  body: string,
  costPerSegmentUsd: number,
): TwilioSmsBillingBreakdown {
  const segments = Math.max(1, Math.ceil(body.length / 160));
  const rawCost = roundCurrency(segments * costPerSegmentUsd);
  const markup = roundCurrency(rawCost * TWILIO_SMS_MARKUP_RATE);
  return {
    segments,
    rawCost,
    markup,
    billedCost: roundCurrency(rawCost + markup),
    markupRate: TWILIO_SMS_MARKUP_RATE,
    costPerSegment: costPerSegmentUsd,
  };
}

export interface TwilioDeliveryResult {
  ok: boolean;
  status: number | null;
  sid?: string;
  error?: string;
  /** Number of retries attempted before the final result (0 = first attempt succeeded or failed permanently). */
  retryCount?: number;
  billing?: TwilioSmsBillingBreakdown;
}

function encodeBasicAuth(accountSid: string, authToken: string): string {
  return Buffer.from(`${accountSid}:${authToken}`).toString("base64");
}

function twilioOperation(path: string): string {
  return path.includes("/Calls.") ? "twilio_voice" : "twilio_sms";
}

const DEFAULT_SMS_COST_PER_SEGMENT_USD = 0.0075;

function resolveSmsCostPerSegment(): number {
  const raw = process.env.TWILIO_SMS_COST_PER_SEGMENT_USD;
  if (!raw) return DEFAULT_SMS_COST_PER_SEGMENT_USD;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    logger.warn(
      {
        raw,
      },
      "[lifeops] Invalid TWILIO_SMS_COST_PER_SEGMENT_USD; falling back to default",
    );
    return DEFAULT_SMS_COST_PER_SEGMENT_USD;
  }
  return parsed;
}

export function readTwilioCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TwilioCredentials | null {
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  const fromPhoneNumber = env.TWILIO_PHONE_NUMBER?.trim();
  if (!accountSid || !authToken || !fromPhoneNumber) {
    return null;
  }
  return {
    accountSid,
    authToken,
    fromPhoneNumber,
  };
}

function getTwilioBaseUrl(): string {
  return process.env.ELIZA_MOCK_TWILIO_BASE ?? "https://api.twilio.com";
}

/** Maximum number of retries for transient (5xx / network) failures. */
const MAX_RETRIES = 2;
/** Base delay in ms for exponential backoff between retries. */
const BASE_DELAY_MS = 1_000;

/** Returns true when a failed result represents a transient error worth retrying. */
function isTransientFailure(result: TwilioDeliveryResult): boolean {
  // 4xx errors are permanent (auth, bad number, etc.) — never retry.
  if (result.status !== null && result.status >= 400 && result.status < 500) {
    return false;
  }
  // 5xx or network error (status === null) — retry.
  return true;
}

async function sendTwilioRequest(args: {
  credentials: TwilioCredentials;
  path: string;
  payload: URLSearchParams;
}): Promise<TwilioDeliveryResult> {
  const { credentials, path, payload } = args;
  const url = `${getTwilioBaseUrl()}/2010-04-01/Accounts/${encodeURIComponent(
    credentials.accountSid,
  )}${path}`;
  const operation = twilioOperation(path);

  let lastResult: TwilioDeliveryResult | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delayMs = BASE_DELAY_MS * 2 ** (attempt - 1);
      logger.warn(
        {
          boundary: "lifeops",
          integration: "twilio",
          operation,
          attempt,
          delayMs,
        },
        `[lifeops] Twilio request retry ${attempt}/${MAX_RETRIES} after ${delayMs}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    const span = createIntegrationTelemetrySpan({
      boundary: "lifeops",
      operation,
      timeoutMs: 12_000,
    });

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${encodeBasicAuth(
            credentials.accountSid,
            credentials.authToken,
          )}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: payload.toString(),
        signal: AbortSignal.timeout(12_000),
      });
      const data = (await response.json().catch(() => ({}))) as {
        sid?: string;
        message?: string;
        code?: number;
      };
      if (!response.ok) {
        const errorMsg = data.message ?? `HTTP ${response.status}`;
        logger.warn(
          {
            boundary: "lifeops",
            integration: "twilio",
            operation,
            statusCode: response.status,
          },
          `[lifeops] Twilio request failed: ${errorMsg}`,
        );
        span.failure({
          statusCode: response.status,
          errorKind: "http_error",
        });
        lastResult = {
          ok: false,
          status: response.status,
          error: errorMsg,
          retryCount: attempt,
        };
        if (!isTransientFailure(lastResult)) {
          return lastResult;
        }
        continue;
      }
      span.success({
        statusCode: response.status,
      });
      return {
        ok: true,
        status: response.status,
        sid: data.sid,
        retryCount: attempt,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(
        {
          boundary: "lifeops",
          integration: "twilio",
          operation,
          err: error instanceof Error ? error : undefined,
        },
        `[lifeops] Twilio request failed: ${errorMsg}`,
      );
      span.failure({
        error,
        errorKind: "network_error",
      });
      lastResult = {
        ok: false,
        status: null,
        error: errorMsg,
        retryCount: attempt,
      };
    }
  }

  // All attempts exhausted — return last failure.
  // Safety: lastResult is always set after at least one loop iteration.
  return lastResult as TwilioDeliveryResult;
}

export async function sendTwilioSms(args: {
  credentials: TwilioCredentials;
  to: string;
  body: string;
}): Promise<TwilioDeliveryResult> {
  const { credentials, to, body } = args;
  const result = await sendTwilioRequest({
    credentials,
    path: "/Messages.json",
    payload: new URLSearchParams({
      To: to,
      From: credentials.fromPhoneNumber,
      Body: body,
    }),
  });

  if (!result.ok) {
    return result;
  }

  return {
    ...result,
    billing: calculateTwilioSmsBilling(body, resolveSmsCostPerSegment()),
  };
}

/** Escape special XML characters to prevent TwiML injection. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function sendTwilioVoiceCall(args: {
  credentials: TwilioCredentials;
  to: string;
  message: string;
}): Promise<TwilioDeliveryResult> {
  const { credentials, to, message } = args;
  return sendTwilioRequest({
    credentials,
    path: "/Calls.json",
    payload: new URLSearchParams({
      To: to,
      From: credentials.fromPhoneNumber,
      Twiml: `<Response><Say>${escapeXml(message)}</Say></Response>`,
    }),
  });
}
