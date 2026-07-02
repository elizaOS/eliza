export class ProviderApiError extends Error {
  readonly statusCode?: number;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { statusCode?: number; retryable?: boolean; cause?: unknown } = {}
  ) {
    super(message);
    this.name = "ProviderApiError";
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
    this.statusCode = options.statusCode;
    this.retryable = options.retryable ?? isRetryableProviderStatus(options.statusCode, message);
  }
}

export function isRetryableProviderStatus(statusCode: number | undefined, message = ""): boolean {
  if (statusCode === 429 || statusCode === 529) return true;
  if (statusCode !== undefined && [500, 502, 503, 504].includes(statusCode)) return true;
  const haystack = message.toLowerCase();
  return (
    haystack.includes("overloaded") ||
    haystack.includes("rate limit") ||
    haystack.includes("too many requests") ||
    haystack.includes("temporarily unavailable") ||
    haystack.includes("service unavailable") ||
    haystack.includes("timeout") ||
    haystack.includes("timed out")
  );
}

export function parseProviderApiErrorText(
  text: string
): { statusCode?: number; message: string } | null {
  const trimmed = text.trim();
  const match = /^API Error:\s*(\d{3})\b[\s:.-]*(.*)$/is.exec(trimmed);
  if (!match) return null;
  return {
    statusCode: Number.parseInt(match[1], 10),
    message: trimmed,
  };
}

export function isProviderApiErrorText(text: string): boolean {
  return parseProviderApiErrorText(text) !== null;
}
