/**
 * HuggingFace download routing for local-inference bundle fetches.
 *
 * The product never holds a local HuggingFace token. When the device is linked
 * to Eliza Cloud, ALL HuggingFace `resolve` traffic is routed through the cloud
 * HF proxy (`/api/v1/hf-proxy/<repo>/resolve/<rev>/<path>`), which attaches the
 * cloud-side `HF_TOKEN` so gated repos resolve without exposing a token to the
 * client. When the device is not cloud-linked, downloads go directly to the
 * public (ungated) HuggingFace host — the shipping eliza-1 bundles are public.
 *
 * Precedence:
 *   1. `ELIZA_HF_BASE_URL` override (explicit mirror/base) — always wins.
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
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/** Read the Eliza Cloud API key from the sealed store (falls back to env). */
function cloudApiKey(): string {
  return getCloudSecret("ELIZAOS_CLOUD_API_KEY")?.trim() ?? "";
}

/**
 * Resolve where HuggingFace `resolve` traffic should go and how it should
 * authenticate. See the module doc for precedence.
 */
export function resolveHfDownloadBase(): HfDownloadBase {
  const override = process.env.ELIZA_HF_BASE_URL?.trim();
  if (override) {
    return { base: trimTrailingSlash(override), viaCloud: false };
  }

  const apiKey = cloudApiKey();
  if (apiKey) {
    const cloudApi = resolveCloudApiBaseUrl(process.env.ELIZAOS_CLOUD_BASE_URL);
    return {
      base: `${trimTrailingSlash(cloudApi)}/hf-proxy`,
      authHeader: { authorization: `Bearer ${apiKey}` },
      viaCloud: true,
    };
  }

  return { base: DEFAULT_HF_HOST, viaCloud: false };
}
