/**
 * Twilio transport helpers for outbound SMS and voice calls: reads credentials
 * from the environment, sends via the Twilio REST API with bounded retry, and
 * computes the segment-based SMS billing breakdown (raw cost + markup).
 *
 * These are standalone helpers held here for the future VOICE_CALL provider
 * migration; no action in this package wires them today — outbound dispatch is
 * owned by the PA-hosted VOICE_CALL action.
 */

import { randomUUID } from "node:crypto";
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

export interface TwilioDeliveryResult {
  ok: boolean;
  status: number | null;
  sid?: string;
  error?: string;
  retryCount?: number;
  billing?: TwilioSmsBillingBreakdown;
}

type TwilioTelemetrySpan = {
  success: (metadata?: Record<string, unknown>) => void;
  failure: (metadata?: Record<string, unknown>) => void;
};

const TWILIO_SMS_MARKUP_RATE = 0.2;
const DEFAULT_SMS_COST_PER_SEGMENT_USD = 0.0075;
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1_000;

function createTwilioTelemetrySpan(): TwilioTelemetrySpan {
  return {
    success: () => undefined,
    failure: () => undefined,
  };
}

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

function encodeBasicAuth(accountSid: string, authToken: string): string {
  return Buffer.from(`${accountSid}:${authToken}`).toString("base64");
}

function twilioOperation(path: string): string {
  return path.includes("/Calls.") ? "twilio_voice" : "twilio_sms";
}

function resolveSmsCostPerSegment(): number {
  const raw = process.env.TWILIO_SMS_COST_PER_SEGMENT_USD;
  if (!raw) return DEFAULT_SMS_COST_PER_SEGMENT_USD;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    logger.warn(
      { raw },
      "[phone] Invalid TWILIO_SMS_COST_PER_SEGMENT_USD; falling back to default",
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

function isTransientFailure(result: TwilioDeliveryResult): boolean {
  if (result.status !== null && result.status >= 400 && result.status < 500) {
    return false;
  }
  return true;
}

function validationFailure(error: string): TwilioDeliveryResult {
  return {
    ok: false,
    status: null,
    error,
    retryCount: 0,
  };
}

function nonEmptyTrimmed(value: string, field: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return `${field} must be a non-empty string`;
  }
  return null;
}

function validateTwilioRequestInputs(args: {
  credentials: TwilioCredentials;
  to: string;
  messageField: "body" | "message";
  message: string;
}): string | null {
  return (
    nonEmptyTrimmed(args.credentials.accountSid, "credentials.accountSid") ??
    nonEmptyTrimmed(args.credentials.authToken, "credentials.authToken") ??
    nonEmptyTrimmed(
      args.credentials.fromPhoneNumber,
      "credentials.fromPhoneNumber",
    ) ??
    nonEmptyTrimmed(args.to, "to") ??
    nonEmptyTrimmed(args.message, args.messageField)
  );
}

async function sendTwilioRequest(args: {
  credentials: TwilioCredentials;
  path: string;
  payload: URLSearchParams;
  idempotencyKey?: string;
}): Promise<TwilioDeliveryResult> {
  const { credentials, path, payload, idempotencyKey } = args;
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
          boundary: "plugin-phone",
          integration: "twilio",
          operation,
          attempt,
          delayMs,
        },
        `[phone] Twilio request retry ${attempt}/${MAX_RETRIES} after ${delayMs}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    const span = createTwilioTelemetrySpan();

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${encodeBasicAuth(
            credentials.accountSid,
            credentials.authToken,
          )}`,
          "Content-Type": "application/x-www-form-urlencoded",
          ...(idempotencyKey
            ? { "I-Twilio-Idempotency-Token": idempotencyKey }
            : {}),
        },
        body: payload.toString(),
        signal: AbortSignal.timeout(12_000),
      });
      let data: {
        sid?: string;
        message?: string;
        code?: number;
      };
      try {
        const parsed: unknown = await response.json();
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Twilio returned a non-object JSON response");
        }
        data = parsed as typeof data;
      } catch (error) {
        // error-policy:J3 A successful response without a valid receipt is
        // ambiguous; an error response remains an explicit HTTP failure.
        if (response.ok) {
          throw new Error(
            "Twilio accepted the request without a valid receipt",
            { cause: error },
          );
        }
        data = {};
      }
      if (!response.ok) {
        const errorMsg = data.message ?? `HTTP ${response.status}`;
        logger.warn(
          {
            boundary: "plugin-phone",
            integration: "twilio",
            operation,
            statusCode: response.status,
          },
          `[phone] Twilio request failed: ${errorMsg}`,
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
      span.success({ statusCode: response.status });
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
          boundary: "plugin-phone",
          integration: "twilio",
          operation,
          err: error instanceof Error ? error : undefined,
        },
        `[phone] Twilio request failed: ${errorMsg}`,
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

  return lastResult as TwilioDeliveryResult;
}

export async function sendTwilioSms(args: {
  credentials: TwilioCredentials;
  to: string;
  body: string;
  idempotencyKey?: string;
}): Promise<TwilioDeliveryResult> {
  const { credentials, to, body } = args;
  const validationError = validateTwilioRequestInputs({
    credentials,
    to,
    messageField: "body",
    message: body,
  });
  if (validationError) return validationFailure(validationError);

  // Twilio's /Messages.json is a non-idempotent create endpoint, but
  // sendTwilioRequest retries transient failures (network throw/timeout, 5xx).
  // Without a stable idempotency token a post-send timeout or retryable 5xx
  // after acceptance would re-POST and deliver a duplicate, doubly-billed SMS.
  // Default one token per logical send so every retry attempt deduplicates,
  // while distinct logical sends still get distinct tokens.
  const idempotencyKey = args.idempotencyKey ?? randomUUID();

  const result = await sendTwilioRequest({
    credentials,
    path: "/Messages.json",
    payload: new URLSearchParams({
      To: to,
      From: credentials.fromPhoneNumber,
      Body: body,
    }),
    idempotencyKey,
  });

  if (!result.ok) {
    return result;
  }

  return {
    ...result,
    billing: calculateTwilioSmsBilling(body, resolveSmsCostPerSegment()),
  };
}

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
  idempotencyKey?: string;
}): Promise<TwilioDeliveryResult> {
  const { credentials, to, message } = args;
  const validationError = validateTwilioRequestInputs({
    credentials,
    to,
    messageField: "message",
    message,
  });
  if (validationError) return validationFailure(validationError);

  // /Calls.json is a non-idempotent create endpoint under the same retrying
  // transport, so default an idempotency token to keep retries from placing a
  // duplicate, doubly-billed voice call. See sendTwilioSms for the rationale.
  const idempotencyKey = args.idempotencyKey ?? randomUUID();

  return sendTwilioRequest({
    credentials,
    path: "/Calls.json",
    payload: new URLSearchParams({
      To: to,
      From: credentials.fromPhoneNumber,
      Twiml: `<Response><Say>${escapeXml(message)}</Say></Response>`,
    }),
    idempotencyKey,
  });
}
