/**
 * Typed upstream-provider failure plus retryability classification, shared by the
 * CLI and SDK handlers. `ProviderApiError` carries the upstream status so
 * `useModel` / AccountPool failover classify 429/529/5xx as retryable.
 * `parseProviderApiErrorText` recognizes the SDK's own streamed error envelope
 * ("API Error: <status> …") that Claude Code emits as assistant text, so a leaked
 * error string is thrown to failover instead of relayed to the user as a reply.
 */

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
  // The SDK also emits NON-numeric envelopes ("API Error: Request was
  // aborted.", "API Error: Usage credits required for 1M context · …") — the
  // CLI's own detector anchors on `startsWith("API Error")`, so match any
  // "API Error"-prefixed envelope and parse the 3-digit status when present.
  if (!/^API Error(:|$)/i.test(trimmed)) return null;
  const status = /^API Error:\s*(\d{3})\b/i.exec(trimmed);
  return {
    statusCode: status ? Number.parseInt(status[1], 10) : undefined,
    message: trimmed,
  };
}

export function isProviderApiErrorText(text: string): boolean {
  return parseProviderApiErrorText(text) !== null;
}
