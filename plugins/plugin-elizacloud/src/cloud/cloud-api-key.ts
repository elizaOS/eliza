/**
 * Cloud API key + base URL resolution.
 *
 * Resolves the Eliza Cloud API key and base URL from (in priority order):
 *   1. Explicit `config.cloud.apiKey` / `config.cloud.baseUrl`
 *   2. Runtime settings + character secrets (`ELIZAOS_CLOUD_API_KEY`)
 *   3. Process env (`ELIZAOS_CLOUD_API_KEY`, `ELIZAOS_CLOUD_BASE_URL`)
 *
 * Previously these helpers lived in `packages/agent/src/api/wallet-rpc.ts`
 * because the wallet uses Cloud RPC proxies. They are NOT wallet-specific —
 * cloud auth is consumed by cloud-status, cloud-billing, cloud-compat,
 * health, x-relay, and travel-provider-relay routes. Hosting them under
 * `cloud/` matches their actual ownership.
 */

import { defaultCloudSiteUrl } from "@elizaos/shared";

import type { ElizaConfig } from "../lib/config-like";

/**
 * The cloud API an unconfigured agent talks to. Environment-dependent: `bun run
 * dev` targets staging, everything else production — see
 * `defaultCloudSiteUrl()` in `@elizaos/shared`, which owns that decision for the
 * whole repo so the agent, the CLI, and the web bundles cannot disagree.
 *
 * A function, not a constant: the dev flag is read from the environment at call
 * time, and a module-load constant would freeze whichever value happened to be
 * set when this module was first imported.
 */
export function defaultCloudApiBaseUrl(): string {
  return `${defaultCloudSiteUrl()}/api/v1`;
}

export type CloudApiKeyRuntimeLike = {
  getSetting?: (key: string) => unknown;
  character?: {
    secrets?: Record<string, unknown>;
  } | null;
} | null;

export function normalizeCloudSecret(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveRuntimeCloudApiKey(
  runtime?: CloudApiKeyRuntimeLike,
): string | null {
  const fromSetting = runtime?.getSetting?.("ELIZAOS_CLOUD_API_KEY");
  if (typeof fromSetting === "string") {
    return normalizeCloudSecret(fromSetting);
  }

  const fromSecrets = runtime?.character?.secrets?.ELIZAOS_CLOUD_API_KEY;
  return typeof fromSecrets === "string"
    ? normalizeCloudSecret(fromSecrets)
    : null;
}

export function resolveCloudApiBaseUrl(
  rawBaseUrl?: string | null,
): string | null {
  const candidate =
    normalizeCloudSecret(rawBaseUrl ?? process.env.ELIZAOS_CLOUD_BASE_URL) ??
    defaultCloudApiBaseUrl();
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    parsed.hash = "";
    parsed.search = "";
    const normalizedBase = parsed.toString().replace(/\/+$/, "");
    return normalizedBase.endsWith("/api/v1")
      ? normalizedBase
      : `${normalizedBase}/api/v1`;
  } catch {
    return null;
  }
}

export function resolveCloudApiKey(
  config?: Pick<ElizaConfig, "cloud"> | null,
  runtime?: CloudApiKeyRuntimeLike,
): string | null {
  return normalizeCloudSecret(
    config?.cloud?.apiKey ??
      resolveRuntimeCloudApiKey(runtime) ??
      process.env.ELIZAOS_CLOUD_API_KEY,
  );
}
