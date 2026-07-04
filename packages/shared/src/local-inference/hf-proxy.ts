/**
 * HuggingFace download routing for local-inference bundle fetches.
 *
 * The product never holds a local HuggingFace token. Explicit mirrors are tried
 * first, then a cloud-linked device can route through the Eliza Cloud HF proxy
 * (`/api/v1/hf-proxy/<repo>/resolve/<rev>/<path>`), which attaches the
 * cloud-side `HF_TOKEN` so gated repos resolve without exposing a token to the
 * client. Direct public HuggingFace remains the final fallback for public
 * bundles and local-only devices.
 *
 * Precedence:
 *   1. `ELIZA_HF_BASE_URLS` / `ELIZA_HF_BASE_URL` mirrors — first in order.
 *   2. Cloud proxy base + bearer — when an Eliza Cloud API key is present.
 *   3. Direct public HuggingFace host — no auth header.
 *
 * The returned `base` is the host (+ optional path prefix) that a
 * `<repo>/resolve/<rev>/<path>` suffix is appended to by the catalog URL
 * builder, so cloud and direct paths share one URL-construction shape.
 */

import { resolveCloudApiBaseUrl } from "../elizacloud/base-url.js";
import { getCloudSecret } from "../elizacloud/cloud-secrets.js";

const DEFAULT_HF_HOST = "https://huggingface.co";

export interface HfDownloadBase {
  /**
   * Base URL the catalog builder appends `<repo>/resolve/<rev>/<path>` to.
   * For the cloud proxy this is `<cloudApi>/hf-proxy`; for direct HF it is the
   * HuggingFace host. Never has a trailing slash.
   */
  base: string;
  /**
   * Bearer header to send with the request, or `undefined` for the
   * unauthenticated public path. Only the cloud proxy carries auth — the
   * cloud-side `HF_TOKEN` is attached by the Worker, never by the client.
   */
  authHeader?: { authorization: string };
  /** True when traffic is routed through the Eliza Cloud HF proxy. */
  viaCloud: boolean;
  /** Stable diagnostic label for logs and failover reporting. */
  label?: "mirror" | "cloud" | "direct";
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function parseMirrorBases(): string[] {
  const list = [process.env.ELIZA_HF_BASE_URLS, process.env.ELIZA_HF_BASE_URL]
    .filter((value): value is string => typeof value === "string")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean)
    .map(trimTrailingSlash);
  return [...new Set(list)];
}

/** Read the Eliza Cloud API key from the sealed store (falls back to env). */
function cloudApiKey(): string {
  return getCloudSecret("ELIZAOS_CLOUD_API_KEY")?.trim() ?? "";
}

/**
 * Resolve every HuggingFace `resolve` base in the order downloads should try
 * them. See the module doc for precedence.
 */
export function resolveHfDownloadBases(): HfDownloadBase[] {
  const bases: HfDownloadBase[] = parseMirrorBases().map((base) => ({
    base,
    viaCloud: false,
    label: "mirror",
  }));

  const apiKey = cloudApiKey();
  if (apiKey) {
    const cloudApi = resolveCloudApiBaseUrl(process.env.ELIZAOS_CLOUD_BASE_URL);
    bases.push({
      base: `${trimTrailingSlash(cloudApi)}/hf-proxy`,
      authHeader: { authorization: `Bearer ${apiKey}` },
      viaCloud: true,
      label: "cloud",
    });
  }

  bases.push({ base: DEFAULT_HF_HOST, viaCloud: false, label: "direct" });
  return bases;
}

/**
 * Backward-compatible single-base resolver for callers that do not implement
 * failover. New download paths should use {@link resolveHfDownloadBases}.
 */
export function resolveHfDownloadBase(): HfDownloadBase {
  return resolveHfDownloadBases()[0];
}
