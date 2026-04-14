/**
 * Eliza Cloud login flow — reuses the CLI auth session pattern:
 * create session, open browser, poll until authenticated, return API key.
 */

import crypto from "node:crypto";
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
  const sessionId = crypto.randomUUID();

  logger.info("[cloud-auth] Creating auth session...");

  let createResponse: Response;
  try {
    createResponse = await fetchWithTimeout(
      `${baseUrl}/api/auth/cli-session`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
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

  const browserUrl = `${baseUrl}/auth/cli-login?session=${encodeURIComponent(sessionId)}`;
  logger.info(`[cloud-auth] Browser URL: ${browserUrl}`);
  options.onBrowserUrl?.(browserUrl);

  const deadline = Date.now() + timeoutMs;

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

    const data = (await pollResponse.json()) as {
      status: string;
      apiKey?: string;
      keyPrefix?: string;
      expiresAt?: string;
    };

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

  throw new Error(
    `Cloud login timed out. The browser login was not completed within ${Math.round(timeoutMs / 1000)} seconds.`,
  );
}
