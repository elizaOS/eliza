/**
 * Telegram API Utilities
 *
 * Shared constants and helpers for Telegram Bot API interactions.
 */

export const TELEGRAM_API_BASE = "https://api.telegram.org";

export const TELEGRAM_API_TIMEOUT_MS = 15_000;

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
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<T> {
  const url = `${TELEGRAM_API_BASE}/bot${botToken}/${method}`;

  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: params ? JSON.stringify(params) : undefined,
    signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS),
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
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<T> {
  const url = new URL(`${TELEGRAM_API_BASE}/bot${botToken}/${method}`);

  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, String(value));
    });
  }

  const response = await fetchImpl(url.toString(), {
    signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS),
  });
  const data = (await response.json()) as TelegramApiResponse<T>;

  if (!data.ok) {
    throw new Error(
      data.description ?? `Telegram API error: ${data.error_code ?? response.status}`,
    );
  }

  return data.result as T;
}
