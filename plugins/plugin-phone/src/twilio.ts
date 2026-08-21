/**
 * Twilio transport helpers for outbound SMS and voice calls: reads credentials
 * from the environment, sends via the Twilio REST API with retry only for
 * explicitly known-not-processed responses, and computes the segment-based SMS
 * billing breakdown (raw cost + markup).
 *
 * These are standalone helpers held here for the future VOICE_CALL provider
 * migration; no action in this package wires them today — outbound dispatch is
 * owned by the PA-hosted VOICE_CALL action.
 */

import { createHash } from "node:crypto";
import { ElizaError, logger } from "@elizaos/core";

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

export type TwilioProviderResourceKind = "message" | "call";

export interface TwilioProviderResourceReadback {
  resourceKind: TwilioProviderResourceKind;
  resourceSid: string;
  accountSid: string;
  status: string;
  from: string | null;
  to: string | null;
  direction: string | null;
  body: string | null;
  rawResponseSha256: string;
}

export type TwilioProviderCleanupResult =
  | {
      disposition: "deleted" | "already-absent";
      resourceKind: TwilioProviderResourceKind;
      resourceSid: string;
    }
  | {
      disposition: "reconciliation-required";
      resourceKind: TwilioProviderResourceKind;
      resourceSid: string;
      reason:
        | "read-failed"
        | "resource-not-terminal"
        | "delete-ambiguous"
        | "delete-rejected"
        | "deletion-unverified";
      providerStatus?: string;
      httpStatus?: number;
    };

export type TwilioFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type TwilioTelemetrySpan = {
  success: (metadata?: Record<string, unknown>) => void;
  failure: (metadata?: Record<string, unknown>) => void;
};

const TWILIO_SMS_MARKUP_RATE = 0.2;
const DEFAULT_SMS_COST_PER_SEGMENT_USD = 0.0075;
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1_000;
const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;
const ACCOUNT_SID_PATTERN = /^AC[0-9a-fA-F]{32}$/;
const MESSAGE_SID_PATTERN = /^(?:SM|MM)[0-9a-fA-F]{32}$/;
const CALL_SID_PATTERN = /^CA[0-9a-fA-F]{32}$/;
const TERMINAL_MESSAGE_STATUSES = new Set([
  "canceled",
  "delivered",
  "failed",
  "read",
  "received",
  "undelivered",
]);
const TERMINAL_CALL_STATUSES = new Set([
  "busy",
  "canceled",
  "completed",
  "failed",
  "no-answer",
]);

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

function isSafeToRetry(result: TwilioDeliveryResult): boolean {
  // Twilio documents 429 as not processed and therefore safe to retry. Network
  // errors, malformed success receipts, and 5xx outcomes are ambiguous for the
  // non-idempotent Messages/Calls create endpoints and must not be replayed.
  return result.status === 429;
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

function validateStatusCallbackUrl(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (value.length === 0 || value !== value.trim()) {
    return "statusCallbackUrl must be an exact non-empty HTTPS URL";
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // error-policy:J3 malformed caller input becomes an explicit validation failure.
    return "statusCallbackUrl must be an exact non-empty HTTPS URL";
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== "" ||
    parsed.hostname.length === 0 ||
    !/^[A-Za-z0-9.-]+$/.test(parsed.hostname) ||
    parsed.toString() !== value
  ) {
    return "statusCallbackUrl must be an exact HTTPS URL with a valid hostname and no credentials or fragment";
  }
  return null;
}

function validateTwilioRequestInputs(args: {
  credentials: TwilioCredentials;
  to: string;
  messageField: "body" | "message";
  message: string;
  statusCallbackUrl?: string;
}): string | null {
  return (
    nonEmptyTrimmed(args.credentials.accountSid, "credentials.accountSid") ??
    nonEmptyTrimmed(args.credentials.authToken, "credentials.authToken") ??
    nonEmptyTrimmed(
      args.credentials.fromPhoneNumber,
      "credentials.fromPhoneNumber",
    ) ??
    nonEmptyTrimmed(args.to, "to") ??
    nonEmptyTrimmed(args.message, args.messageField) ??
    validateStatusCallbackUrl(args.statusCallbackUrl)
  );
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
        if (!isSafeToRetry(lastResult)) {
          return lastResult;
        }
        continue;
      }
      const receiptSid = typeof data.sid === "string" ? data.sid.trim() : "";
      if (receiptSid.length === 0) {
        // error-policy:J3 A 2xx create without a usable resource identifier is
        // an ambiguous success. Do not report success or replay the POST.
        throw new Error("Twilio accepted the request without a valid receipt");
      }
      span.success({ statusCode: response.status });
      return {
        ok: true,
        status: response.status,
        sid: receiptSid,
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
      // A transport failure can happen after Twilio accepted the create. The
      // provider exposes no documented client idempotency key for these
      // endpoints, so replaying here could duplicate delivery and billing.
      break;
    }
  }

  return lastResult as TwilioDeliveryResult;
}

export async function sendTwilioSms(args: {
  credentials: TwilioCredentials;
  to: string;
  body: string;
  /** Exact manifest-bound URL for Twilio delivery status callbacks. */
  statusCallbackUrl?: string;
  /** @deprecated Twilio Messages does not document a client idempotency key. */
  idempotencyKey?: string;
}): Promise<TwilioDeliveryResult> {
  const { credentials, to, body, statusCallbackUrl } = args;
  const validationError = validateTwilioRequestInputs({
    credentials,
    to,
    messageField: "body",
    message: body,
    statusCallbackUrl,
  });
  if (validationError) return validationFailure(validationError);

  const result = await sendTwilioRequest({
    credentials,
    path: "/Messages.json",
    payload: new URLSearchParams({
      To: to,
      From: credentials.fromPhoneNumber,
      Body: body,
      ...(statusCallbackUrl === undefined
        ? {}
        : { StatusCallback: statusCallbackUrl }),
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
  /** Exact manifest-bound URL for the terminal completed progress event. */
  statusCallbackUrl?: string;
  /** @deprecated Twilio Calls does not document a client idempotency key. */
  idempotencyKey?: string;
}): Promise<TwilioDeliveryResult> {
  const { credentials, to, message, statusCallbackUrl } = args;
  const validationError = validateTwilioRequestInputs({
    credentials,
    to,
    messageField: "message",
    message,
    statusCallbackUrl,
  });
  if (validationError) return validationFailure(validationError);

  return sendTwilioRequest({
    credentials,
    path: "/Calls.json",
    payload: new URLSearchParams({
      To: to,
      From: credentials.fromPhoneNumber,
      Twiml: `<Response><Say>${escapeXml(message)}</Say></Response>`,
      ...(statusCallbackUrl === undefined
        ? {}
        : {
            StatusCallback: statusCallbackUrl,
            StatusCallbackMethod: "POST",
            StatusCallbackEvent: "completed",
          }),
    }),
  });
}

function resourcePath(input: {
  credentials: TwilioCredentials;
  resourceKind: TwilioProviderResourceKind;
  resourceSid: string;
}): string {
  if (!ACCOUNT_SID_PATTERN.test(input.credentials.accountSid)) {
    throw new ElizaError("Twilio provider boundary requires an Account SID", {
      code: "TWILIO_PROVIDER_INVALID_ACCOUNT_SID",
    });
  }
  const sidPattern =
    input.resourceKind === "message" ? MESSAGE_SID_PATTERN : CALL_SID_PATTERN;
  if (!sidPattern.test(input.resourceSid)) {
    throw new ElizaError(
      "Twilio provider boundary requires a matching resource SID",
      {
        code: "TWILIO_PROVIDER_INVALID_RESOURCE_SID",
        context: { resourceKind: input.resourceKind },
      },
    );
  }
  if (input.credentials.authToken.trim().length === 0) {
    throw new ElizaError("Twilio provider boundary requires an Auth Token", {
      code: "TWILIO_PROVIDER_INVALID_AUTH_TOKEN",
    });
  }
  const collection = input.resourceKind === "message" ? "Messages" : "Calls";
  return `/2010-04-01/Accounts/${encodeURIComponent(
    input.credentials.accountSid,
  )}/${collection}/${encodeURIComponent(input.resourceSid)}.json`;
}

async function providerFetch(input: {
  credentials: TwilioCredentials;
  resourceKind: TwilioProviderResourceKind;
  resourceSid: string;
  method: "GET" | "DELETE";
  fetchImpl: TwilioFetch;
}): Promise<Response> {
  const path = resourcePath(input);
  return input.fetchImpl(`${getTwilioBaseUrl()}${path}`, {
    method: input.method,
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${encodeBasicAuth(
        input.credentials.accountSid,
        input.credentials.authToken,
      )}`,
    },
    redirect: "error",
    signal: AbortSignal.timeout(12_000),
  });
}

/**
 * Read one exact Twilio Message or Call with credentials supplied by the
 * calling role. A 404 is the only absence proof; every other provider or
 * transport failure is explicit.
 */
export async function readTwilioProviderResource(input: {
  credentials: TwilioCredentials;
  resourceKind: TwilioProviderResourceKind;
  resourceSid: string;
  fetchImpl?: TwilioFetch;
}): Promise<TwilioProviderResourceReadback | null> {
  let response: Response;
  try {
    response = await providerFetch({
      ...input,
      method: "GET",
      fetchImpl: input.fetchImpl ?? fetch,
    });
  } catch (error) {
    // error-policy:J2 retain the ambiguous provider-read cause without credentials.
    throw new ElizaError("Twilio provider resource read failed", {
      code: "TWILIO_PROVIDER_READ_FAILED",
      context: {
        resourceKind: input.resourceKind,
        resourceSid: input.resourceSid,
      },
      cause: error,
    });
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new ElizaError("Twilio provider resource read was rejected", {
      code: "TWILIO_PROVIDER_READ_REJECTED",
      context: {
        resourceKind: input.resourceKind,
        resourceSid: input.resourceSid,
        statusCode: response.status,
      },
    });
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_PROVIDER_RESPONSE_BYTES
  ) {
    throw new ElizaError("Twilio provider resource response is too large", {
      code: "TWILIO_PROVIDER_RESPONSE_TOO_LARGE",
    });
  }
  let raw: string;
  try {
    raw = await response.text();
  } catch (error) {
    // error-policy:J2 provider body transport failures remain explicit and typed.
    throw new ElizaError(
      "Twilio provider resource response could not be read",
      {
        code: "TWILIO_PROVIDER_INVALID_RESPONSE",
        cause: error,
      },
    );
  }
  if (Buffer.byteLength(raw) > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new ElizaError("Twilio provider resource response is too large", {
      code: "TWILIO_PROVIDER_RESPONSE_TOO_LARGE",
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // error-policy:J2 retain malformed provider material as a typed boundary failure.
    throw new ElizaError("Twilio provider resource response is not JSON", {
      code: "TWILIO_PROVIDER_INVALID_RESPONSE",
      cause: error,
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ElizaError("Twilio provider resource response is not an object", {
      code: "TWILIO_PROVIDER_INVALID_RESPONSE",
    });
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.sid !== input.resourceSid ||
    value.account_sid !== input.credentials.accountSid ||
    typeof value.status !== "string" ||
    value.status.length === 0
  ) {
    throw new ElizaError(
      "Twilio provider resource response is not correlated",
      {
        code: "TWILIO_PROVIDER_RESPONSE_MISMATCH",
        context: {
          resourceKind: input.resourceKind,
          resourceSid: input.resourceSid,
        },
      },
    );
  }
  const nullableString = (field: string): string | null =>
    typeof value[field] === "string" ? value[field] : null;
  return Object.freeze({
    resourceKind: input.resourceKind,
    resourceSid: input.resourceSid,
    accountSid: input.credentials.accountSid,
    status: value.status,
    from: nullableString("from"),
    to: nullableString("to"),
    direction: nullableString("direction"),
    body: input.resourceKind === "message" ? nullableString("body") : null,
    rawResponseSha256: createHash("sha256").update(raw).digest("hex"),
  });
}

function terminalResource(readback: TwilioProviderResourceReadback): boolean {
  return (
    readback.resourceKind === "message"
      ? TERMINAL_MESSAGE_STATUSES
      : TERMINAL_CALL_STATUSES
  ).has(readback.status);
}

/**
 * Delete one terminal Twilio provider record and prove it absent with a second
 * GET. Transport ambiguity, active resources, rejected deletion, and failed
 * verification return reconciliation-required instead of fabricated cleanup.
 */
export async function cleanupTwilioProviderResource(input: {
  credentials: TwilioCredentials;
  resourceKind: TwilioProviderResourceKind;
  resourceSid: string;
  fetchImpl?: TwilioFetch;
}): Promise<TwilioProviderCleanupResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let before: TwilioProviderResourceReadback | null;
  try {
    before = await readTwilioProviderResource({ ...input, fetchImpl });
  } catch {
    // error-policy:J1 cleanup is the role boundary; unresolved reads reconcile.
    return {
      disposition: "reconciliation-required",
      resourceKind: input.resourceKind,
      resourceSid: input.resourceSid,
      reason: "read-failed",
    };
  }
  if (!before) {
    return {
      disposition: "already-absent",
      resourceKind: input.resourceKind,
      resourceSid: input.resourceSid,
    };
  }
  if (!terminalResource(before)) {
    return {
      disposition: "reconciliation-required",
      resourceKind: input.resourceKind,
      resourceSid: input.resourceSid,
      reason: "resource-not-terminal",
      providerStatus: before.status,
    };
  }
  let deletion: Response;
  try {
    deletion = await providerFetch({
      ...input,
      method: "DELETE",
      fetchImpl,
    });
  } catch {
    // error-policy:J1 DELETE transport failure may follow provider consumption.
    return {
      disposition: "reconciliation-required",
      resourceKind: input.resourceKind,
      resourceSid: input.resourceSid,
      reason: "delete-ambiguous",
    };
  }
  if (deletion.status === 404) {
    return {
      disposition: "already-absent",
      resourceKind: input.resourceKind,
      resourceSid: input.resourceSid,
    };
  }
  if (deletion.status !== 204) {
    return {
      disposition: "reconciliation-required",
      resourceKind: input.resourceKind,
      resourceSid: input.resourceSid,
      reason: "delete-rejected",
      httpStatus: deletion.status,
    };
  }
  try {
    const after = await readTwilioProviderResource({ ...input, fetchImpl });
    if (after) {
      return {
        disposition: "reconciliation-required",
        resourceKind: input.resourceKind,
        resourceSid: input.resourceSid,
        reason: "deletion-unverified",
        providerStatus: after.status,
      };
    }
  } catch {
    // error-policy:J1 only a provider 404 proves cleanup after DELETE.
    return {
      disposition: "reconciliation-required",
      resourceKind: input.resourceKind,
      resourceSid: input.resourceSid,
      reason: "deletion-unverified",
    };
  }
  return {
    disposition: "deleted",
    resourceKind: input.resourceKind,
    resourceSid: input.resourceSid,
  };
}
