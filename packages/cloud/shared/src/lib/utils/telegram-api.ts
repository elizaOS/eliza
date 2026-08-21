/**
 * Telegram API Utilities
 *
 * Shared constants and helpers for Telegram Bot API interactions.
 */

export const TELEGRAM_API_BASE = "https://api.telegram.org";

const TELEGRAM_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Bound every Telegram Bot API hop so a hung API cannot pin the caller
 * indefinitely. A caller-provided abort signal wins.
 */
export function telegramApiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs: number = TELEGRAM_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
  });
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

/**
 * Make a Telegram Bot API request
 */
export async function telegramBotApiRequest<T>(
  botToken: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const url = `${TELEGRAM_API_BASE}/bot${botToken}/${method}`;

  const response = await telegramApiFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: params ? JSON.stringify(params) : undefined,
  });

  const data = (await response.json()) as TelegramApiResponse<T>;

  if (!data.ok) {
    throw new Error(
      data.description ?? `Telegram API error: ${data.error_code ?? response.status}`,
    );
  }

  return data.result as T;
}

/**
 * Make a Telegram Bot API request with GET method (for simple queries)
 */
export async function telegramBotApiGet<T>(
  botToken: string,
  method: string,
  params?: Record<string, string | number | boolean>,
): Promise<T> {
  const url = new URL(`${TELEGRAM_API_BASE}/bot${botToken}/${method}`);

  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, String(value));
    });
  }

  const response = await telegramApiFetch(url.toString());
  const data = (await response.json()) as TelegramApiResponse<T>;

  if (!data.ok) {
    throw new Error(
      data.description ?? `Telegram API error: ${data.error_code ?? response.status}`,
    );
  }

  return data.result as T;
}
