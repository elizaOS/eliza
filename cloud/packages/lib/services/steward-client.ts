/**
 * Steward integration for Eliza Cloud.
 *
 * Two layers:
 *   1. `getStewardClient()` — returns a `@stwd/sdk` StewardClient for
 *      provisioning and signing (used by server-wallets.ts).
 *   2. Read-only helpers (`getStewardAgent`, `getStewardWalletInfo`) that
 *      hit the Steward REST API directly for the API/dashboard layer.
 *      These use lightweight fetch calls so we don't depend on the SDK for
 *      simple reads that only need a subset of the response.
 */

import { StewardClient } from "@stwd/sdk";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import {
  type ResolveStewardTenantCredentialsOptions,
  resolveDefaultStewardTenantId,
  resolveStewardTenantCredentials,
} from "@/lib/services/steward-tenant-config";
import { resolveServerStewardApiUrlFromEnv } from "@/lib/steward-url";
import { logger } from "@/lib/utils/logger";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

let hasWarnedMissingStewardTenantApiKey = false;

// ---------------------------------------------------------------------------
// SDK client (singleton)
// ---------------------------------------------------------------------------

let _client: { key: string; value: StewardClient } | null = null;

export interface StewardClientOptions extends ResolveStewardTenantCredentialsOptions {}

function resolveStewardHostUrl(): string {
  const env = getCloudAwareEnv();
  return resolveServerStewardApiUrlFromEnv(env);
}

function resolveDefaultStewardConfig() {
  const env = getCloudAwareEnv();
  const baseUrl = resolveStewardHostUrl();
  const apiKey = env.STEWARD_TENANT_API_KEY || undefined;
  const tenantId = resolveDefaultStewardTenantId() || undefined;
  return {
    baseUrl,
    apiKey,
    tenantId,
    key: JSON.stringify({ baseUrl, apiKey, tenantId }),
  };
}

function warnMissingStewardTenantApiKey(apiKey?: string) {
  if (apiKey || hasWarnedMissingStewardTenantApiKey) {
    return;
  }

  hasWarnedMissingStewardTenantApiKey = true;
  logger.warn(
    "[steward-client] STEWARD_TENANT_API_KEY is not set; Steward requests will run without tenant API key auth",
  );
}

/**
 * Returns a configured `@stwd/sdk` StewardClient instance (singleton).
 *
 * Used by `server-wallets.ts` for wallet provisioning and RPC execution.
 */
export function getStewardClient(): StewardClient {
  const config = resolveDefaultStewardConfig();
  if (!_client || _client.key !== config.key) {
    warnMissingStewardTenantApiKey(config.apiKey);
    _client = {
      key: config.key,
      value: new StewardClient({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        tenantId: config.tenantId,
      }),
    };
  }
  return _client.value;
}

export async function createStewardClient(
  options: StewardClientOptions = {},
): Promise<StewardClient> {
  const credentials = await resolveStewardTenantCredentials(options);
  warnMissingStewardTenantApiKey(credentials.apiKey);
  return new StewardClient({
    baseUrl: resolveStewardHostUrl(),
    apiKey: credentials.apiKey,
    tenantId: credentials.tenantId,
  });
}

// ---------------------------------------------------------------------------
// Types (for read-only API layer)
// ---------------------------------------------------------------------------

export interface StewardAgentInfo {
  id: string;
  name: string;
  walletAddress: string | null;
  createdAt: string;
}

export interface StewardWalletInfo {
  agentId: string;
  walletAddress: string | null;
  walletProvider: "steward";
  walletStatus: "active" | "pending" | "error" | "unknown";
  balance?: string | null;
  chain?: string | null;
}

// ---------------------------------------------------------------------------
// Lightweight fetch helpers (for API routes that only need reads)
// ---------------------------------------------------------------------------

async function stewardHeaders(options: StewardClientOptions = {}): Promise<Record<string, string>> {
  const credentials = await resolveStewardTenantCredentials(options);
  warnMissingStewardTenantApiKey(credentials.apiKey);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (credentials.tenantId) {
    headers["X-Steward-Tenant"] = credentials.tenantId;
  }
  if (credentials.apiKey) {
    headers["X-Steward-Key"] = credentials.apiKey;
  }
  return headers;
}

async function stewardFetch<T>(
  path: string,
  options?: RequestInit,
  clientOptions?: StewardClientOptions,
): Promise<T | null> {
  const url = `${resolveStewardHostUrl()}${path}`;
  try {
    const response = await fetch(url, {
      ...options,
      headers: { ...(await stewardHeaders(clientOptions)), ...(options?.headers ?? {}) },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      if (response.status === 404) return null;
      logger.warn(`[steward-client] ${path} returned ${response.status}`);
      return null;
    }

    return (await response.json()) as T;
  } catch (err) {
    logger.warn(
      `[steward-client] Failed to reach Steward at ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Read-only public API (used by API routes + dashboard)
// ---------------------------------------------------------------------------

/**
 * Fetch agent info from Steward, including wallet address.
 */
export async function getStewardAgent(
  agentId: string,
  options: StewardClientOptions = {},
): Promise<StewardAgentInfo | null> {
  const data = await stewardFetch<{
    id?: string;
    name?: string;
    walletAddress?: string;
    wallet_address?: string;
    created_at?: string;
    createdAt?: string;
  }>(`/agents/${encodeURIComponent(agentId)}`, undefined, options);

  if (!data) return null;

  return {
    id: data.id ?? agentId,
    name: data.name ?? "",
    walletAddress: data.walletAddress ?? data.wallet_address ?? null,
    createdAt: data.createdAt ?? data.created_at ?? "",
  };
}

/**
 * Fetch wallet info for a sandbox/agent from Steward.
 * Returns a normalized StewardWalletInfo or null if unreachable.
 */
export async function getStewardWalletInfo(
  agentId: string,
  options: StewardClientOptions = {},
): Promise<StewardWalletInfo | null> {
  // Use the SDK client for balance, since it handles auth + parsing
  const client =
    options.organizationId || options.tenantId || options.apiKey
      ? await createStewardClient(options)
      : getStewardClient();

  let agent: StewardAgentInfo | null = null;
  try {
    const sdkAgent = await client.getAgent(agentId);
    agent = {
      id: sdkAgent.id,
      name: sdkAgent.name,
      walletAddress: sdkAgent.walletAddress || null,
      createdAt: sdkAgent.createdAt?.toISOString?.() ?? "",
    };
  } catch {
    // SDK call failed, try lightweight fetch as fallback
    agent = await getStewardAgent(agentId, options);
  }

  if (!agent) return null;

  let balance: string | null = null;
  let chain: string | null = null;

  if (agent.walletAddress) {
    try {
      const balanceResult = await client.getBalance(agentId);
      balance = balanceResult.balances?.nativeFormatted ?? null;
      chain = balanceResult.balances?.chainId ? `eip155:${balanceResult.balances.chainId}` : null;
    } catch {
      // Balance fetch is best-effort
    }
  }

  return {
    agentId,
    walletAddress: agent.walletAddress,
    walletProvider: "steward",
    walletStatus: agent.walletAddress ? "active" : "pending",
    balance,
    chain,
  };
}

/**
 * Check if Steward is reachable.
 */
export async function isStewardAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${resolveStewardHostUrl()}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
