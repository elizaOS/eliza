/**
 * Discord API Utilities
 *
 * Shared constants and helpers for Discord API interactions.
 * Consolidates duplicate Discord API base URLs and request patterns.
 */

import { ElizaError } from "@elizaos/core";

import { logger } from "./logger";

export const DISCORD_API_BASE = "https://discord.com/api/v10";
export const DISCORD_REQUEST_TIMEOUT_MS = 25_000;
const DISCORD_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

async function bufferDiscordResponse(response: Response, signal: AbortSignal): Promise<Response> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength)) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > DISCORD_RESPONSE_MAX_BYTES) {
      const error = new ElizaError("Discord response exceeds the byte limit", {
        code: "DISCORD_RESPONSE_TOO_LARGE",
        context: { declaredBytes, maxBytes: DISCORD_RESPONSE_MAX_BYTES },
      });
      try {
        await response.body?.cancel(error);
      } catch (cause) {
        // error-policy:J6 The response is rejected; cancellation only releases transport.
        logger.debug("[Discord] Failed to cancel declared-oversize response body", { cause });
      }
      throw error;
    }
  }
  if (!response.body) return response;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  const onAbort = (): void => {
    reader.cancel(signal.reason).catch((cause: unknown) => {
      // error-policy:J6 The request failed; cancellation only releases transport.
      logger.debug("[Discord] Failed to cancel aborted response body", { cause });
    });
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      receivedBytes += next.value.byteLength;
      if (receivedBytes > DISCORD_RESPONSE_MAX_BYTES) {
        const error = new ElizaError("Discord response exceeds the byte limit", {
          code: "DISCORD_RESPONSE_TOO_LARGE",
          context: { receivedBytes, maxBytes: DISCORD_RESPONSE_MAX_BYTES },
        });
        try {
          await reader.cancel(error);
        } catch (cause) {
          // error-policy:J6 The bounded read failed; cancellation only releases transport.
          logger.debug("[Discord] Failed to cancel oversized response body", { cause });
        }
        throw error;
      }
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }

  const body = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body.buffer, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Bound every Discord REST hop while preserving caller cancellation.
 *
 * A caller signal is composed with the owned deadline rather than replacing
 * it, so a never-aborted caller signal cannot disable the operation bound.
 */
export async function discordFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs: number = DISCORD_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new ElizaError("Discord timeout must be a positive timer-safe integer", {
      code: "INVALID_DISCORD_TIMEOUT",
      context: { timeoutMs },
    });
  }

  const controller = new AbortController();
  let rejectAbort!: (reason: unknown) => void;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = (reason: unknown): void => {
    if (controller.signal.aborted) return;
    controller.abort(reason);
    rejectAbort(reason);
  };
  const onCallerAbort = (): void =>
    abort(init?.signal?.reason ?? new DOMException("Discord request aborted", "AbortError"));
  init?.signal?.addEventListener("abort", onCallerAbort, { once: true });
  if (init?.signal?.aborted) onCallerAbort();
  const timeoutId = setTimeout(
    () => abort(new DOMException("Discord API request timed out", "TimeoutError")),
    timeoutMs,
  );

  try {
    if (controller.signal.aborted) return await abortPromise;
    const response = await Promise.race([
      fetch(input, { ...init, signal: controller.signal }),
      abortPromise,
    ]);
    return await Promise.race([bufferDiscordResponse(response, controller.signal), abortPromise]);
  } finally {
    clearTimeout(timeoutId);
    init?.signal?.removeEventListener("abort", onCallerAbort);
  }
}

/**
 * Create Discord Bot authorization header
 */
export function discordBotAuthHeader(token: string): string {
  return `Bot ${token}`;
}

/**
 * Create Discord Bearer authorization header (for OAuth)
 */
export function discordBearerAuthHeader(token: string): string {
  return `Bearer ${token}`;
}

/**
 * Create Discord API request headers for bot requests
 */
export function discordBotHeaders(
  token: string,
  additionalHeaders?: Record<string, string>,
): HeadersInit {
  return {
    Authorization: discordBotAuthHeader(token),
    "Content-Type": "application/json",
    ...additionalHeaders,
  };
}

/**
 * Create Discord API request headers for OAuth requests
 */
export function discordBearerHeaders(
  token: string,
  additionalHeaders?: Record<string, string>,
): HeadersInit {
  return {
    Authorization: discordBearerAuthHeader(token),
    "Content-Type": "application/json",
    ...additionalHeaders,
  };
}

/**
 * Make a Discord API request with bot token
 */
export async function discordBotApiRequest<T>(
  endpoint: string,
  botToken: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await discordFetch(`${DISCORD_API_BASE}${endpoint}`, {
    ...options,
    headers: {
      ...discordBotHeaders(botToken),
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(
      `Discord Bot API error: ${response.status} - ${error.message || "Unknown error"}`,
    );
  }

  return response.json();
}

/**
 * Make a Discord API request with OAuth bearer token
 */
export async function discordBearerApiRequest<T>(
  endpoint: string,
  accessToken: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await discordFetch(`${DISCORD_API_BASE}${endpoint}`, {
    ...options,
    headers: {
      ...discordBearerHeaders(accessToken),
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(`Discord API error: ${response.status} - ${error.message || "Unknown error"}`);
  }

  return response.json();
}
