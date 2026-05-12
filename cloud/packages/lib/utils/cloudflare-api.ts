/**
 * Cloudflare API client helper.
 *
 * Wraps `fetch` with bearer auth + the standard cloudflare API base URL.
 * All cloudflare API calls in this codebase route through here so retries,
 * error envelopes, and auth handling live in one place.
 */

import { logger } from "@/lib/utils/logger";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

interface CloudflareErrorEntry {
  code: number;
  message: string;
}

interface CloudflareEnvelope<T> {
  success: boolean;
  errors: CloudflareErrorEntry[];
  messages: CloudflareErrorEntry[];
  result: T;
  result_info?: {
    page: number;
    per_page: number;
    total_count: number;
  };
}

export class CloudflareApiError extends Error {
  readonly status: number;
  readonly errors: CloudflareErrorEntry[];

  constructor(status: number, errors: CloudflareErrorEntry[], message?: string) {
    super(
      message ??
        `Cloudflare API error (status=${status}): ${errors
          .map((e) => `[${e.code}] ${e.message}`)
          .join("; ")}`,
    );
    this.name = "CloudflareApiError";
    this.status = status;
    this.errors = errors;
  }
}

/**
 * Make an authenticated request to the Cloudflare REST API and unwrap the
 * standard `{ success, errors, result }` envelope. Throws `CloudflareApiError`
 * when `success` is false or the HTTP status is non-2xx.
 */
export async function cloudflareApiRequest<T>(
  path: string,
  token: string,
  options: RequestInit = {},
): Promise<T> {
  const url = path.startsWith("http") ? path : `${CLOUDFLARE_API_BASE}${path}`;

  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (!headers.has("Content-Type") && options.body) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(url, { ...options, headers });
  const text = await response.text();

  let envelope: CloudflareEnvelope<T> | null = null;
  if (text.length > 0) {
    try {
      envelope = JSON.parse(text) as CloudflareEnvelope<T>;
    } catch {
      // fall through; treated as non-envelope response below
    }
  }

  if (!response.ok || (envelope && envelope.success === false)) {
    const errors = envelope?.errors ?? [
      { code: response.status, message: text || response.statusText },
    ];
    logger.warn("[Cloudflare API] request failed", {
      path,
      status: response.status,
      errors,
    });
    throw new CloudflareApiError(response.status, errors);
  }

  if (!envelope) {
    throw new CloudflareApiError(response.status, [
      { code: response.status, message: "empty or non-JSON response from cloudflare" },
    ]);
  }

  return envelope.result;
}
