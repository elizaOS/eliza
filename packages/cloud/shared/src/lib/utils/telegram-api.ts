/**
 * Sends bounded Telegram Bot API requests through the fixed Telegram origin.
 *
 * The transport deadline remains active through response-body consumption,
 * and every response is streamed under a byte cap before JSON parsing.
 */
import { ElizaError } from "@elizaos/core";

export const TELEGRAM_API_BASE = "https://api.telegram.org";

const TELEGRAM_REQUEST_TIMEOUT_MS = 30_000;
const TELEGRAM_REQUEST_BODY_MAX_BYTES = 1_000_000;
const TELEGRAM_RESPONSE_BODY_MAX_BYTES = 1_000_000;
const TELEGRAM_GET_URL_MAX_CHARS = 16_384;
const TELEGRAM_METHOD_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const TELEGRAM_TOKEN_RE = /^[A-Za-z0-9:_-]+$/;

export interface TelegramApiRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface BoundedTelegramResponse {
  response: Response;
  releaseDeadline: () => void;
}

function telegramError(
  message: string,
  code: string,
  context: Record<string, unknown>,
  cause?: unknown,
): ElizaError {
  return new ElizaError(message, {
    code,
    context,
    severity: "ephemeral",
    ...(cause === undefined ? {} : { cause }),
  });
}

function assertTelegramEndpoint(input: string | URL): string {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.toString()) : new URL(input);
  } catch (cause) {
    // error-policy:J3 invalid outbound input is rejected before transport.
    throw telegramError("Telegram API URL is invalid", "TELEGRAM_API_URL_INVALID", {}, cause);
  }
  if (
    url.origin !== TELEGRAM_API_BASE ||
    url.username !== "" ||
    url.password !== "" ||
    !url.pathname.startsWith("/bot")
  ) {
    throw telegramError(
      "Telegram API URL must use the canonical Telegram Bot API origin",
      "TELEGRAM_API_URL_FORBIDDEN",
      { origin: url.origin },
    );
  }
  return url.toString();
}

function telegramMethodUrl(botToken: string, method: string): string {
  if (!TELEGRAM_TOKEN_RE.test(botToken)) {
    throw telegramError(
      "Telegram bot token has an invalid path format",
      "TELEGRAM_BOT_TOKEN_INVALID",
      {},
    );
  }
  if (!TELEGRAM_METHOD_RE.test(method)) {
    throw telegramError(
      "Telegram Bot API method has an invalid path format",
      "TELEGRAM_API_METHOD_INVALID",
      { method },
    );
  }
  return `${TELEGRAM_API_BASE}/bot${botToken}/${method}`;
}

function cancelResponseBody(response: Response, reason?: unknown): void {
  try {
    void response.body?.cancel(reason).catch(() => {
      // error-policy:J6 authoritative failure is already known; response-body
      // cancellation is best-effort connection teardown.
    });
  } catch {
    // error-policy:J6 synchronous response cancellation is best-effort teardown.
  }
}

/**
 * Executes one bounded Telegram hop. Caller cancellation and the hop deadline
 * are composed, and redirects are rejected so bot tokens and POST bodies never
 * leave the allowlisted Telegram origin.
 */
async function telegramApiFetch(
  input: string | URL,
  init?: RequestInit,
  timeoutMs: number = TELEGRAM_REQUEST_TIMEOUT_MS,
): Promise<BoundedTelegramResponse> {
  const url = assertTelegramEndpoint(input);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw telegramError(
      "Telegram API timeout must be a positive 32-bit safe integer",
      "TELEGRAM_API_TIMEOUT_INVALID",
      { timeoutMs },
    );
  }

  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(new DOMException("Telegram API request timed out", "TimeoutError"));
  }, timeoutMs);
  const signal = init?.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;

  try {
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal,
    });
    return {
      response,
      releaseDeadline: () => clearTimeout(timer),
    };
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

function serializeTelegramParams(params: Record<string, unknown>): string {
  let body: string;
  try {
    body = JSON.stringify(params);
  } catch (cause) {
    // error-policy:J3 invalid caller parameters fail before any network side effect.
    throw telegramError(
      "Telegram API parameters are not JSON-serializable",
      "TELEGRAM_API_PARAMS_INVALID",
      {},
      cause,
    );
  }
  const byteLength = new TextEncoder().encode(body).byteLength;
  if (byteLength > TELEGRAM_REQUEST_BODY_MAX_BYTES) {
    throw telegramError(
      "Telegram API request body exceeds the byte limit",
      "TELEGRAM_API_REQUEST_TOO_LARGE",
      { byteLength, maxBytes: TELEGRAM_REQUEST_BODY_MAX_BYTES },
    );
  }
  return body;
}

async function readTelegramResponse<T>(
  boundedResponse: BoundedTelegramResponse,
  method: string,
): Promise<T> {
  const { response, releaseDeadline } = boundedResponse;
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > TELEGRAM_RESPONSE_BODY_MAX_BYTES) {
    cancelResponseBody(response);
    releaseDeadline();
    throw telegramError(
      "Telegram API response exceeds the byte limit",
      "TELEGRAM_API_RESPONSE_TOO_LARGE",
      { method, declaredBytes: declaredLength, maxBytes: TELEGRAM_RESPONSE_BODY_MAX_BYTES },
    );
  }

  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        receivedBytes += value.byteLength;
        if (receivedBytes > TELEGRAM_RESPONSE_BODY_MAX_BYTES) {
          void reader.cancel().catch(() => {
            // error-policy:J6 oversize failure is authoritative; reader cleanup is best-effort.
          });
          throw telegramError(
            "Telegram API response exceeds the byte limit",
            "TELEGRAM_API_RESPONSE_TOO_LARGE",
            { method, receivedBytes, maxBytes: TELEGRAM_RESPONSE_BODY_MAX_BYTES },
          );
        }
        chunks.push(value);
      }
    }
  } catch (error) {
    try {
      await reader?.cancel(error);
    } catch {
      // error-policy:J6 the read failure remains authoritative; reader
      // cancellation is best-effort connection teardown.
    }
    throw error;
  } finally {
    releaseDeadline();
  }

  const bytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (cause) {
    // error-policy:J1 malformed upstream data becomes a typed transport failure.
    throw telegramError(
      "Telegram API returned invalid JSON",
      "TELEGRAM_API_RESPONSE_INVALID",
      { method, status: response.status },
      cause,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw telegramError(
      "Telegram API returned an invalid response envelope",
      "TELEGRAM_API_RESPONSE_INVALID",
      { method, status: response.status },
    );
  }
  const data = parsed as TelegramApiResponse<T>;
  if (!response.ok || data.ok !== true) {
    throw telegramError(
      data.description ?? "Telegram API request failed",
      "TELEGRAM_API_REQUEST_FAILED",
      { method, status: response.status, errorCode: data.error_code },
    );
  }
  return data.result as T;
}

/** Makes a bounded Telegram Bot API POST request. */
export async function telegramBotApiRequest<T>(
  botToken: string,
  method: string,
  params?: Record<string, unknown>,
  options: TelegramApiRequestOptions = {},
): Promise<T> {
  const boundedResponse = await telegramApiFetch(
    telegramMethodUrl(botToken, method),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: params ? serializeTelegramParams(params) : undefined,
      signal: options.signal,
    },
    options.timeoutMs,
  );
  return readTelegramResponse<T>(boundedResponse, method);
}

/** Makes a bounded Telegram Bot API GET request for small query payloads. */
export async function telegramBotApiGet<T>(
  botToken: string,
  method: string,
  params?: Record<string, string | number | boolean>,
  options: TelegramApiRequestOptions = {},
): Promise<T> {
  const url = new URL(telegramMethodUrl(botToken, method));
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, String(value));
  }
  if (url.toString().length > TELEGRAM_GET_URL_MAX_CHARS) {
    throw telegramError(
      "Telegram API GET URL exceeds the character limit",
      "TELEGRAM_API_REQUEST_TOO_LARGE",
      { method, maxChars: TELEGRAM_GET_URL_MAX_CHARS },
    );
  }
  const boundedResponse = await telegramApiFetch(
    url,
    { signal: options.signal },
    options.timeoutMs,
  );
  return readTelegramResponse<T>(boundedResponse, method);
}
