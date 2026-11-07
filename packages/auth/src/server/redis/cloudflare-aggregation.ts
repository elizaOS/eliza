/** Cloudflare policy-event storage; never retries an uncertain write. */
import { ElizaError } from "@elizaos/core";

function configuration(): { url: URL; token: string } | undefined {
  const configuredUrl = process.env.STEWARD_AGGREGATION_URL?.trim();
  const token = process.env.STEWARD_AGGREGATION_TOKEN?.trim();
  if (!configuredUrl && !token) return undefined;
  if (!configuredUrl || !token) {
    throw new ElizaError("Cloudflare aggregations require both URL and token", {
      code: "LOGIN_AGGREGATION_CONFIG_INVALID",
    });
  }
  let url: URL;
  try {
    url = new URL(configuredUrl);
  } catch {
    throw new ElizaError("Cloudflare aggregation URL is invalid", {
      code: "LOGIN_AGGREGATION_CONFIG_INVALID",
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
    throw new ElizaError("Cloudflare aggregation URL must use HTTPS", {
      code: "LOGIN_AGGREGATION_CONFIG_INVALID",
    });
  }
  return { url, token };
}

export function isCloudflareAggregationConfigured(): boolean {
  return configuration() !== undefined;
}

export async function cloudflareAggregation(
  operation: "record" | "read",
  input:
    | { now: number; records: Array<{ key: string; member: string }> }
    | { now: number; key: string; windowStart: number },
): Promise<string[]> {
  const configured = configuration();
  if (!configured) {
    throw new ElizaError("Cloudflare aggregations are not configured", {
      code: "LOGIN_AGGREGATION_UNCONFIGURED",
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
    throw new ElizaError("Cloudflare aggregation storage is unavailable", {
      code: "LOGIN_AGGREGATION_UNAVAILABLE",
      cause,
    });
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ElizaError("Cloudflare aggregation storage was rejected", {
      code: "LOGIN_AGGREGATION_UNAVAILABLE",
    });
  }
  let result: unknown;
  try {
    result = await response.json();
  } catch (cause) {
    // error-policy:J2 preserve malformed provider responses as typed storage failures.
    throw new ElizaError(
      "Cloudflare returned an invalid aggregation response",
      {
        code: "LOGIN_AGGREGATION_RESPONSE_INVALID",
        cause,
      },
    );
  }
  if (result && typeof result === "object") {
    if (
      operation === "record" &&
      "recorded" in result &&
      result.recorded === true
    )
      return [];
    if (
      operation === "read" &&
      "members" in result &&
      Array.isArray(result.members) &&
      result.members.every((member: unknown) => typeof member === "string")
    )
      return result.members;
  }
  throw new ElizaError("Cloudflare returned invalid aggregation state", {
    code: "LOGIN_AGGREGATION_RESPONSE_INVALID",
  });
}
