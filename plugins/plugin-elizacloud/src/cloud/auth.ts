/**
 * Eliza Cloud login flow — reuses the CLI auth session pattern:
 * create session, open browser, poll until authenticated, return API key.
 */

import crypto from "node:crypto";
import { isCliLoginSessionId } from "@elizaos/cloud-sdk";
import { logger } from "@elizaos/core";
import { normalizeCloudSiteUrl } from "./base-url.js";
import { validateCloudBaseUrl } from "./validate-url.js";

export interface CloudLoginResult {
  apiKey: string;
  keyPrefix: string;
  expiresAt: string | null;
}

export interface CloudLoginOptions {
  baseUrl?: string;
  timeoutMs?: number;
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
  onBrowserUrl?: (url: string) => void;
  onPollStatus?: (status: string) => void;
}

const DEFAULT_CLOUD_REQUEST_TIMEOUT_MS = 10_000;
const MAX_CONSECUTIVE_INVALID_POLL_RESPONSES = 5;
const INVALID_POLL_RESPONSE_MESSAGE =
  "Eliza Cloud returned invalid login poll responses";

interface CloudLoginPollData {
  status: string;
  apiKey?: string;
  keyPrefix?: string;
  expiresAt?: string;
}

function parseCloudLoginPollData(value: unknown): CloudLoginPollData {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Eliza Cloud login poll response must be an object");
  }

  const data = value as Record<string, unknown>;
  if (typeof data.status !== "string" || !data.status.trim()) {
    throw new TypeError("Eliza Cloud login poll response has no status");
  }
  const apiKey = data.apiKey;
  const keyPrefix = data.keyPrefix;
  const expiresAt = data.expiresAt;
  for (const [field, fieldValue] of [
    ["apiKey", apiKey],
    ["keyPrefix", keyPrefix],
    ["expiresAt", expiresAt],
  ] as const) {
    // Optional fields may be JSON null (e.g. a non-expiring key has
    // `expiresAt: null`); treat null as absent.
    if (
      fieldValue !== undefined &&
      fieldValue !== null &&
      typeof fieldValue !== "string"
    ) {
      throw new TypeError(`Eliza Cloud login poll response has an invalid ${field}`);
    }
  }

  return {
    status: data.status,
    ...(typeof apiKey === "string" ? { apiKey } : {}),
    ...(typeof keyPrefix === "string" ? { keyPrefix } : {}),
    ...(typeof expiresAt === "string" ? { expiresAt } : {}),
  };
}

function isRedirectResponse(response: Response): boolean {
  return response.status >= 300 && response.status < 400;
}

function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "TimeoutError" || err.name === "AbortError") return true;
  const msg = err.message.toLowerCase();
  return msg.includes("timed out") || msg.includes("timeout");
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  return fetch(input, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export async function cloudLogin(
  options: CloudLoginOptions = {},
): Promise<CloudLoginResult> {
  const baseUrl = normalizeCloudSiteUrl(options.baseUrl);
  const urlError = await validateCloudBaseUrl(baseUrl);
  if (urlError) {
    throw new Error(urlError);
  }
  const timeoutMs = options.timeoutMs ?? 300_000;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_CLOUD_REQUEST_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const requestSessionId = crypto.randomUUID();
  logger.info("[cloud-auth] Creating auth session...");

  let createResponse: Response;
  try {
    createResponse = await fetchWithTimeout(
      `${baseUrl}/api/auth/cli-session`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: requestSessionId }),
      },
      requestTimeoutMs,
    );
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new Error(
        `Cloud login request timed out while creating session (>${requestTimeoutMs}ms).`,
      );
    }
    throw new Error(`Failed to create auth session: ${String(err)}`);
  }

  if (!createResponse.ok) {
    if (isRedirectResponse(createResponse)) {
      throw new Error(
        "Cloud login request was redirected; redirects are not allowed.",
      );
    }
    const errorText = await createResponse.text();
    throw new Error(
      `Failed to create auth session (HTTP ${createResponse.status}): ${errorText}`,
    );
  }

  let createData: unknown;
  try {
    createData = await createResponse.json();
  } catch (err) {
    // error-policy:J2 preserve the malformed upstream response as the cause.
    throw new Error("Eliza Cloud returned an invalid login session response", {
      cause: err,
    });
  }
  const sessionId =
    typeof createData === "object" && createData !== null
      ? (createData as { sessionId?: unknown }).sessionId
      : undefined;
  if (!isCliLoginSessionId(sessionId)) {
    throw new Error("Eliza Cloud returned an invalid login session ID");
  }

  const browserUrl = `${baseUrl}/auth/cli-login?session=${encodeURIComponent(sessionId)}`;
  logger.info("[cloud-auth] Browser sign-in URL ready");
  options.onBrowserUrl?.(browserUrl);

  const deadline = Date.now() + timeoutMs;
  let consecutiveInvalidPollResponses = 0;
  let lastInvalidPollResponseError: unknown;

  while (Date.now() < deadline) {
    const remainingBeforeSleep = deadline - Date.now();
    if (remainingBeforeSleep <= 0) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(pollIntervalMs, remainingBeforeSleep)),
    );

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    let pollResponse: Response;
    try {
      pollResponse = await fetchWithTimeout(
        `${baseUrl}/api/auth/cli-session/${encodeURIComponent(sessionId)}`,
        {},
        Math.min(requestTimeoutMs, remaining),
      );
    } catch (err) {
      if (isTimeoutError(err)) {
        if (remaining <= requestTimeoutMs) {
          break;
        }
        throw new Error(
          `Cloud login polling request timed out (>${Math.min(requestTimeoutMs, remaining)}ms).`,
        );
      }
      throw new Error(`Cloud login polling failed: ${String(err)}`);
    }

    if (!pollResponse.ok) {
      if (isRedirectResponse(pollResponse)) {
        throw new Error(
          "Cloud login polling request was redirected; redirects are not allowed.",
        );
      }
      if (pollResponse.status === 404) {
        throw new Error("Auth session expired or not found. Please try again.");
      }
      options.onPollStatus?.("error");
      continue;
    }

    let data: CloudLoginPollData;
    try {
      data = parseCloudLoginPollData(await pollResponse.json());
    } catch (err) {
      // error-policy:J2 a 200 with invalid JSON or an invalid response shape
      // may be transient, so keep polling — but record it so a persistent
      // upstream failure surfaces as itself, not as a false timeout.
      consecutiveInvalidPollResponses += 1;
      lastInvalidPollResponseError = err;
      logger.warn(
        `[cloud-auth] Login poll returned an invalid body (HTTP ${pollResponse.status}, content-type: ${pollResponse.headers.get("content-type") ?? "none"}): ${err instanceof Error ? err.message : String(err)}`,
      );
      options.onPollStatus?.("error");
      if (
        consecutiveInvalidPollResponses >=
        MAX_CONSECUTIVE_INVALID_POLL_RESPONSES
      ) {
        throw new Error(INVALID_POLL_RESPONSE_MESSAGE, { cause: err });
      }
      continue;
    }
    consecutiveInvalidPollResponses = 0;
    lastInvalidPollResponseError = undefined;

    options.onPollStatus?.(data.status);

    if (data.status === "authenticated" && data.apiKey) {
      logger.info("[cloud-auth] Authentication complete");
      return {
        apiKey: data.apiKey,
        keyPrefix: data.keyPrefix ?? "",
        expiresAt: data.expiresAt ?? null,
      };
    }

    if (data.status === "authenticated" && !data.apiKey) {
      throw new Error(
        "Auth session was completed but the API key was already retrieved. Please try logging in again.",
      );
    }
  }

  if (lastInvalidPollResponseError !== undefined) {
    throw new Error(INVALID_POLL_RESPONSE_MESSAGE, {
      cause: lastInvalidPollResponseError,
    });
  }

  throw new Error(
    `Cloud login timed out. The browser login was not completed within ${Math.round(timeoutMs / 1000)} seconds.`,
  );
}
