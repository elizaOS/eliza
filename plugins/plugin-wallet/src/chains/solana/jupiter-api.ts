/**
 * Resolves the Jupiter Swap API endpoint and translates transport/protocol
 * failures into typed wallet errors shared by both Solana execution paths.
 */
import { ElizaError } from "@elizaos/core";

export const DEFAULT_JUPITER_API_BASE_URL = "https://lite-api.jup.ag/swap/v1";
export const JUPITER_API_BASE_URL_SETTING = "JUPITER_API_BASE_URL";

type RuntimeSettings = { getSetting(key: string): unknown };
type JupiterStage = "quote" | "swap";

function stageCode(stage: JupiterStage, suffix: string): string {
  return `JUPITER_${stage.toUpperCase()}_${suffix}`;
}

export function resolveJupiterApiBaseUrl(runtime: RuntimeSettings): string {
  const configured = runtime.getSetting(JUPITER_API_BASE_URL_SETTING);
  const configuredUrl = typeof configured === "string" ? configured.trim() : undefined;
  const raw =
    configuredUrl && configuredUrl.length > 0 ? configuredUrl : DEFAULT_JUPITER_API_BASE_URL;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (cause) {
    // error-policy:J2 Preserve the invalid configured value and URL parser cause.
    throw new ElizaError("Jupiter API base URL is invalid", {
      code: "JUPITER_API_BASE_URL_INVALID",
      cause,
      context: { setting: JUPITER_API_BASE_URL_SETTING, value: raw },
      severity: "fatal",
    });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ElizaError("Jupiter API base URL must use HTTP or HTTPS", {
      code: "JUPITER_API_BASE_URL_INVALID",
      context: { setting: JUPITER_API_BASE_URL_SETTING, value: raw },
      severity: "fatal",
    });
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ElizaError(
      "Jupiter API base URL cannot include credentials, a query, or a fragment",
      {
        code: "JUPITER_API_BASE_URL_INVALID",
        context: { setting: JUPITER_API_BASE_URL_SETTING, value: raw },
        severity: "fatal",
      }
    );
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

export async function fetchJupiterJson(
  fetchFn: typeof globalThis.fetch,
  url: string,
  stage: JupiterStage,
  init?: RequestInit
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchFn(url, init);
  } catch (cause) {
    // error-policy:J2 Classify DNS/network failures while retaining the fetch cause.
    throw new ElizaError(`Jupiter ${stage} request failed`, {
      code: stageCode(stage, "TRANSPORT_FAILED"),
      cause,
      context: { url },
      severity: "ephemeral",
    });
  }

  if (!response.ok) {
    throw new ElizaError(`Jupiter ${stage} request returned HTTP ${response.status}`, {
      code: stageCode(stage, "HTTP_ERROR"),
      context: { url, status: response.status },
      severity: response.status >= 500 ? "ephemeral" : "fatal",
    });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    // error-policy:J2 The response boundary adds endpoint context to malformed JSON.
    throw new ElizaError(`Jupiter ${stage} response was not valid JSON`, {
      code: stageCode(stage, "INVALID_RESPONSE"),
      cause,
      context: { url, status: response.status },
      severity: "fatal",
    });
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ElizaError(`Jupiter ${stage} response was not an object`, {
      code: stageCode(stage, "INVALID_RESPONSE"),
      context: { url, status: response.status },
      severity: "fatal",
    });
  }
  return payload as Record<string, unknown>;
}
