/** Cloudflare spend telemetry storage; never retries an uncertain write. */
import { ElizaError } from "@elizaos/core";

function configuration(): { url: URL; token: string } | undefined {
  const configuredUrl = process.env.STEWARD_SPEND_METRICS_URL?.trim();
  const token = process.env.STEWARD_SPEND_METRICS_TOKEN?.trim();
  if (!configuredUrl && !token) return undefined;
  if (!configuredUrl || !token) {
    throw new ElizaError(
      "Cloudflare spend metrics require both URL and token",
      {
        code: "LOGIN_SPEND_METRICS_CONFIG_INVALID",
      },
    );
  }
  let url: URL;
  try {
    url = new URL(configuredUrl);
  } catch {
    throw new ElizaError("Cloudflare spend metrics URL is invalid", {
      code: "LOGIN_SPEND_METRICS_CONFIG_INVALID",
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
    throw new ElizaError("Cloudflare spend metrics URL must use HTTPS", {
      code: "LOGIN_SPEND_METRICS_CONFIG_INVALID",
    });
  }
  return { url, token };
}

export function isCloudflareSpendMetricsConfigured(): boolean {
  return configuration() !== undefined;
}

async function requestSpendMetrics(
  operation: "record" | "read",
  input: unknown,
): Promise<unknown> {
  const configured = configuration();
  if (!configured) {
    throw new ElizaError("Cloudflare spend metrics are not configured", {
      code: "LOGIN_SPEND_METRICS_UNCONFIGURED",
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
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    });
  } catch (cause) {
    // error-policy:J2 retain transport failure while withholding credentials and response data.
    throw new ElizaError("Cloudflare spend metrics storage is unavailable", {
      code: "LOGIN_SPEND_METRICS_UNAVAILABLE",
      cause,
    });
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ElizaError("Cloudflare spend metrics storage was rejected", {
      code: "LOGIN_SPEND_METRICS_UNAVAILABLE",
    });
  }
  let result: unknown;
  try {
    result = await response.json();
  } catch (cause) {
    // error-policy:J2 preserve malformed provider responses as typed storage failures.
    throw new ElizaError(
      "Cloudflare returned an invalid spend metrics response",
      {
        code: "LOGIN_SPEND_METRICS_RESPONSE_INVALID",
        cause,
      },
    );
  }
  return result;
}

export async function recordCloudflareSpendMetrics(input: {
  buckets: Array<{ key: string; ttlSeconds: number }>;
  units: number;
  tenantId: string;
  host: string;
}): Promise<void> {
  const result = await requestSpendMetrics("record", input);
  if (
    !result ||
    typeof result !== "object" ||
    !("recorded" in result) ||
    result.recorded !== true
  ) {
    throw new ElizaError("Cloudflare did not acknowledge spend telemetry", {
      code: "LOGIN_SPEND_METRICS_RESPONSE_INVALID",
    });
  }
}

export async function readCloudflareSpendMetrics(
  key: string,
): Promise<{ total: number; hosts: Record<string, number> }> {
  const result = await requestSpendMetrics("read", { key });
  if (
    !result ||
    typeof result !== "object" ||
    !("total" in result) ||
    typeof result.total !== "number" ||
    !Number.isSafeInteger(result.total) ||
    result.total < 0 ||
    !("hosts" in result) ||
    !result.hosts ||
    typeof result.hosts !== "object" ||
    Array.isArray(result.hosts) ||
    !Object.values(result.hosts).every(
      (value: unknown) =>
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    )
  ) {
    throw new ElizaError("Cloudflare returned invalid spend telemetry", {
      code: "LOGIN_SPEND_METRICS_RESPONSE_INVALID",
    });
  }
  return { total: result.total, hosts: result.hosts as Record<string, number> };
}
