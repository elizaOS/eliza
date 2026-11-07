/** Host-configured Cloudflare rate admission; never retries an uncertain reservation. */
import { ElizaError } from "@elizaos/core";
import type { RateLimitResult } from "./rate-limiter";

function configuration(): { url: URL; token: string } | undefined {
  const configuredUrl = process.env.STEWARD_RATE_LIMIT_URL?.trim();
  const token = process.env.STEWARD_RATE_LIMIT_TOKEN?.trim();
  if (!configuredUrl && !token) return undefined;
  if (!configuredUrl || !token) {
    throw new ElizaError("Cloudflare rate limits require both URL and token", {
      code: "LOGIN_RATE_LIMIT_CONFIG_INVALID",
    });
  }
  let url: URL;
  try {
    url = new URL(configuredUrl);
  } catch {
    throw new ElizaError("Cloudflare rate limit URL is invalid", {
      code: "LOGIN_RATE_LIMIT_CONFIG_INVALID",
    });
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        local &&
        url.protocol === "http:" &&
        process.env.NODE_ENV !== "production"
      ))
  ) {
    throw new ElizaError("Cloudflare rate limit URL must use HTTPS", {
      code: "LOGIN_RATE_LIMIT_CONFIG_INVALID",
    });
  }
  return { url, token };
}

export function isCloudflareRateLimitConfigured(): boolean {
  return configuration() !== undefined;
}

export async function cloudflareRateLimit(
  operation: "check" | "status",
  key: string,
  windowMs: number,
  maxRequests: number,
): Promise<RateLimitResult> {
  const configured = configuration();
  if (!configured) {
    throw new ElizaError("Cloudflare rate limits are not configured", {
      code: "LOGIN_RATE_LIMIT_UNCONFIGURED",
    });
  }
  const { url, token } = configured;
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${operation}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ key, windowMs, maxRequests }),
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    });
  } catch (cause) {
    // error-policy:J2 retain transport failure while withholding credentials and response data.
    throw new ElizaError("Cloudflare rate limit admission is unavailable", {
      code: "LOGIN_RATE_LIMIT_UNAVAILABLE",
      cause,
    });
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ElizaError("Cloudflare rate limit admission was rejected", {
      code: "LOGIN_RATE_LIMIT_UNAVAILABLE",
    });
  }
  let result: unknown;
  try {
    result = await response.json();
  } catch (cause) {
    // error-policy:J2 preserve malformed provider responses as typed admission failures.
    throw new ElizaError("Cloudflare returned an invalid rate limit decision", {
      code: "LOGIN_RATE_LIMIT_RESPONSE_INVALID",
      cause,
    });
  }
  if (
    !result ||
    typeof result !== "object" ||
    !("allowed" in result) ||
    typeof result.allowed !== "boolean" ||
    !("remaining" in result) ||
    !Number.isSafeInteger(result.remaining) ||
    Number(result.remaining) < 0 ||
    !("resetMs" in result) ||
    !Number.isSafeInteger(result.resetMs) ||
    Number(result.resetMs) < 0
  ) {
    throw new ElizaError("Cloudflare returned an invalid rate limit decision", {
      code: "LOGIN_RATE_LIMIT_RESPONSE_INVALID",
    });
  }
  return {
    allowed: result.allowed,
    remaining: Number(result.remaining),
    resetMs: Number(result.resetMs),
  };
}
