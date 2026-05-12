import { loadElizaConfig } from "@elizaos/agent";
import {
  type PolicyResult,
  type PolicyRule,
  type SignTransactionInput,
  StewardApiError,
  StewardClient,
  type TxRecord,
} from "@stwd/sdk";
import { fetchSolanaNativeBalanceViaRpc } from "../api/wallet";
import { fetchEvmNativeBalanceViaRpc } from "../api/wallet-evm-balance";
import { resolveWalletRpcReadiness } from "../api/wallet-rpc";
import {
  loadStewardCredentials,
  resolveEffectiveStewardConfig,
  saveStewardCredentials,
} from "../services/steward-credentials";
import { fingerprintRandomToken } from "../services/steward-sidecar/helpers";
import type { StewardSignRequest, StewardSignResponse } from "../types/steward";

export interface StewardBridgeOptions {
  env?: NodeJS.ProcessEnv;
  evmAddress?: string | null;
  agentId?: string | null;
  client?: StewardClient | null;
}

export interface StewardBridgeStatus {
  configured: boolean;
  available: boolean;
  connected: boolean;
  baseUrl: string | null;
  agentId: string | null;
  evmAddress: string | null;
  error: string | null;
  walletAddresses?: { evm: string | null; solana: string | null };
  agentName?: string;
  vaultHealth?: "ok" | "degraded" | "error";
}

export interface StewardPendingApprovalResult {
  mode: "steward";
  pendingApproval: true;
  policyResults: PolicyResult[];
}

export interface StewardSignedTransactionResult {
  mode: "steward";
  pendingApproval: false;
  txHash: string;
}

export type StewardExecutionResult =
  | StewardPendingApprovalResult
  | StewardSignedTransactionResult;

function normalizeEnvValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

type StewardConnectionDetails = {
  baseUrl: string | null;
  apiKey: string | null;
  tenantId: string | null;
  bearerToken: string | null;
  agentId: string | null;
};

function resolveStewardConnection(
  env: NodeJS.ProcessEnv = process.env,
): StewardConnectionDetails {
  const persisted = resolveEffectiveStewardConfig(env);
  const baseUrl =
    normalizeEnvValue(env.STEWARD_API_URL) ??
    normalizeEnvValue(persisted?.apiUrl) ??
    null;
  const apiKey =
    normalizeEnvValue(env.STEWARD_API_KEY) ??
    normalizeEnvValue(persisted?.apiKey) ??
    null;
  const tenantId =
    normalizeEnvValue(env.STEWARD_TENANT_ID) ??
    normalizeEnvValue(persisted?.tenantId) ??
    null;
  const agentId =
    normalizeEnvValue(env.STEWARD_AGENT_ID) ??
    normalizeEnvValue(env.ELIZA_STEWARD_AGENT_ID) ??
    normalizeEnvValue(persisted?.agentId) ??
    null;
  const agentToken =
    normalizeEnvValue(env.STEWARD_AGENT_TOKEN) ??
    normalizeEnvValue(persisted?.agentToken) ??
    null;

  return {
    baseUrl,
    apiKey,
    tenantId,
    bearerToken: apiKey ? null : agentToken,
    agentId,
  };
}

function resolveStewardRpcReadinessSafe(): ReturnType<
  typeof resolveWalletRpcReadiness
> | null {
  try {
    return resolveWalletRpcReadiness(loadElizaConfig());
  } catch {
    return null;
  }
}

function firstRpcUrl(urls: string[]): string | null {
  return (
    urls
      .find((candidate) => typeof candidate === "string" && candidate.trim())
      ?.trim() ?? null
  );
}

function resolveEvmNativeBalanceFallback(
  chainId: number,
  readiness: ReturnType<typeof resolveWalletRpcReadiness>,
): { rpcUrl: string; symbol: string; chainId: number } | null {
  switch (chainId) {
    case 1: {
      const rpcUrl = firstRpcUrl(readiness.ethereumRpcUrls);
      return rpcUrl ? { rpcUrl, symbol: "ETH", chainId } : null;
    }
    case 8453: {
      const rpcUrl = firstRpcUrl(readiness.baseRpcUrls);
      return rpcUrl ? { rpcUrl, symbol: "ETH", chainId } : null;
    }
    case 56:
    case 97: {
      const rpcUrl = firstRpcUrl(readiness.bscRpcUrls);
      return rpcUrl ? { rpcUrl, symbol: "BNB", chainId } : null;
    }
    case 43114: {
      const rpcUrl = firstRpcUrl(readiness.avalancheRpcUrls);
      return rpcUrl ? { rpcUrl, symbol: "AVAX", chainId } : null;
    }
    default:
      return null;
  }
}

export function resolveStewardAgentId(
  env: NodeJS.ProcessEnv = process.env,
  evmAddress?: string | null,
): string | null {
  return resolveStewardConnection(env).agentId ?? evmAddress?.trim() ?? null;
}

export function createStewardClient(
  options: StewardBridgeOptions = {},
): StewardClient | null {
  if (options.client !== undefined) {
    return options.client;
  }

  const env = options.env ?? process.env;
  const connection = resolveStewardConnection(env);
  const baseUrl = connection.baseUrl;
  if (!baseUrl) {
    return null;
  }

  return new StewardClient({
    baseUrl,
    bearerToken: connection.bearerToken ?? undefined,
    apiKey: connection.apiKey ?? undefined,
    tenantId: connection.tenantId ?? undefined,
  });
}

export async function getStewardBridgeStatus(
  options: StewardBridgeOptions = {},
): Promise<StewardBridgeStatus> {
  const env = options.env ?? process.env;
  const baseUrl = normalizeEnvValue(env.STEWARD_API_URL);
  const evmAddress = options.evmAddress ?? null;
  const agentId = options.agentId ?? resolveStewardAgentId(env, evmAddress);
  const client = createStewardClient(options);

  if (!baseUrl || !client) {
    // Check persisted credentials as fallback
    const persisted = resolveEffectiveStewardConfig(env);
    if (!persisted?.apiUrl) {
      return {
        configured: false,
        available: false,
        connected: false,
        baseUrl,
        agentId,
        evmAddress,
        error: null,
      };
    }

    // Re-derive from persisted credentials
    const fallbackClient = new StewardClient({
      baseUrl: persisted.apiUrl,
      bearerToken: persisted.agentToken || undefined,
      apiKey: persisted.apiKey || undefined,
      tenantId: persisted.tenantId || undefined,
    });
    const fallbackAgentId = persisted.agentId || agentId;

    if (!fallbackClient || !fallbackAgentId) {
      return {
        configured: false,
        available: false,
        connected: false,
        baseUrl: persisted.apiUrl,
        agentId: fallbackAgentId,
        evmAddress,
        error: null,
      };
    }

    // Use persisted values for the rest of this function
    try {
      type AgentDataShape = {
        walletAddress?: string;
        walletAddresses?: { evm?: string; solana?: string };
        name?: string;
      };
      let agentData: AgentDataShape | null = null;

      if (fallbackAgentId) {
        try {
          agentData = (await fallbackClient.getAgent(
            fallbackAgentId,
          )) as AgentDataShape;
        } catch (error: unknown) {
          if (
            !(error instanceof StewardApiError) ||
            ((error as StewardApiError).status !== 404 &&
              (error as StewardApiError).status !== 400)
          ) {
            throw error;
          }
        }
      }

      const walletAddresses = agentData
        ? {
            evm:
              agentData.walletAddresses?.evm?.trim() ||
              agentData.walletAddress?.trim() ||
              null,
            solana: agentData.walletAddresses?.solana?.trim() || null,
          }
        : undefined;

      return {
        configured: true,
        available: true,
        connected: true,
        baseUrl: persisted.apiUrl,
        agentId: fallbackAgentId,
        evmAddress: walletAddresses?.evm ?? evmAddress,
        error: null,
        walletAddresses,
        agentName: agentData?.name || undefined,
        vaultHealth: fallbackAgentId && !agentData ? "degraded" : "ok",
      };
    } catch (error) {
      return {
        configured: true,
        available: false,
        connected: false,
        baseUrl: persisted.apiUrl,
        agentId: fallbackAgentId,
        evmAddress,
        error: formatStewardError(error),
        vaultHealth: "error",
      };
    }
  }

  try {
    type AgentDataShape = {
      walletAddress?: string;
      walletAddresses?: { evm?: string; solana?: string };
      name?: string;
    };
    let agentData: AgentDataShape | null = null;

    if (agentId) {
      try {
        agentData = (await client.getAgent(
          agentId,
        )) as AgentDataShape;
      } catch (error: unknown) {
        if (
          !(error instanceof StewardApiError) ||
          ((error as StewardApiError).status !== 404 &&
            (error as StewardApiError).status !== 400)
        ) {
          throw error;
        }
      }
    } else {
      await client.listAgents();
    }

    // Extract wallet addresses from agent data
    const walletAddresses = agentData
      ? {
          evm:
            agentData.walletAddresses?.evm?.trim() ||
            agentData.walletAddress?.trim() ||
            null,
          solana: agentData.walletAddresses?.solana?.trim() || null,
        }
      : undefined;

    const agentName = agentData?.name || undefined;

    // Determine vault health by checking if we could read the agent
    let vaultHealth: "ok" | "degraded" | "error" = "ok";
    if (agentId && !agentData) {
      vaultHealth = "degraded";
    }

    return {
      configured: true,
      available: true,
      connected: true,
      baseUrl,
      agentId,
      evmAddress: walletAddresses?.evm ?? evmAddress,
      error: null,
      walletAddresses,
      agentName,
      vaultHealth,
    };
  } catch (error) {
    return {
      configured: true,
      available: false,
      connected: false,
      baseUrl,
      agentId,
      evmAddress,
      error: formatStewardError(error),
      vaultHealth: "error",
    };
  }
}

/** Check if Steward env vars are configured (synchronous, no network). */
export function isStewardConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const connection = resolveStewardConnection(env);
  return Boolean(connection.baseUrl && connection.agentId);
}

export function formatStewardError(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

export async function signTransactionWithOptionalSteward(params: {
  tx: SignTransactionInput;
  env?: NodeJS.ProcessEnv;
  evmAddress?: string | null;
  agentId?: string | null;
  client?: StewardClient | null;
}): Promise<StewardExecutionResult> {
  const env = params.env ?? process.env;
  const evmAddress = params.evmAddress ?? null;
  const agentId =
    params.agentId ?? resolveStewardAgentId(env, evmAddress) ?? null;
  const client = createStewardClient({
    env,
    evmAddress,
    agentId,
    client: params.client,
  });

  if (!client || !agentId) {
    throw new Error(
      "Steward credentials and agent ID must be provided to sign transactions.",
    );
  }

  // Basic tx shape validation before sending to steward.
  const tx = params.tx;
  if (!tx || typeof tx !== "object") {
    throw new Error("Transaction input is required and must be an object.");
  }
  if (!("to" in tx) || typeof tx.to !== "string" || !tx.to.trim()) {
    throw new Error("Transaction must include a valid 'to' address.");
  }

  const result = await client.signTransaction(agentId, tx);
  if ("txHash" in result) {
    return {
      mode: "steward",
      pendingApproval: false,
      txHash: result.txHash,
    };
  }

  if ("results" in result) {
    return {
      mode: "steward",
      pendingApproval: true,
      policyResults: result.results,
    };
  }

  throw new Error("Steward returned an unsigned transaction unexpectedly");
}

// ── Wallet address / balance / token helpers ─────────────────────────────────

export interface StewardWalletAddresses {
  evmAddress: string | null;
  solanaAddress: string | null;
}

/**
 * Fetch steward-managed wallet addresses for the configured agent.
 * Calls `GET /agents/:agentId` and extracts `walletAddresses.evm` / `walletAddresses.solana`.
 * Falls back to the flat `walletAddress` field if the extended shape is missing.
 */
export async function getStewardWalletAddresses(
  options: StewardBridgeOptions = {},
): Promise<StewardWalletAddresses> {
  const env = options.env ?? process.env;
  const evmAddr = options.evmAddress ?? null;
  const agentId =
    options.agentId ?? resolveStewardAgentId(env, evmAddr) ?? null;
  const client = createStewardClient(options);

  if (!client || !agentId) {
    return { evmAddress: null, solanaAddress: null };
  }

  // The SDK's AgentIdentity type only declares `walletAddress` (string),
  // but the live API returns an extended `walletAddresses` object with
  // per-chain addresses.  Cast to `unknown` to access those extra fields.
  const agent = (await client.getAgent(agentId)) as {
    walletAddress?: string;
    walletAddresses?: { evm?: string; solana?: string };
  };

  const evmAddress =
    agent.walletAddresses?.evm?.trim() || agent.walletAddress?.trim() || null;
  const solanaAddress = agent.walletAddresses?.solana?.trim() || null;

  return { evmAddress, solanaAddress };
}

export interface StewardBalanceResult {
  balance: string;
  formatted: string;
  symbol: string;
  chainId: number;
}

/**
 * Fetch the native balance for a steward-managed agent wallet.
 * Uses the SDK's `getBalance()` when available.
 */
export async function getStewardBalance(
  agentId: string,
  chainId?: number,
  options: StewardBridgeOptions = {},
): Promise<StewardBalanceResult> {
  const client = createStewardClient(options);
  if (!client) throw new Error("Steward not configured");

  try {
    const result = await client.getBalance(agentId, chainId);
    return {
      balance: result.balances.native,
      formatted: result.balances.nativeFormatted,
      symbol: result.balances.symbol,
      chainId: result.balances.chainId,
    };
  } catch (error) {
    const readiness = resolveStewardRpcReadinessSafe();
    const walletAddresses = await getStewardWalletAddresses({
      ...options,
      agentId,
    });

    if (
      chainId === 101 &&
      walletAddresses.solanaAddress &&
      readiness &&
      readiness.solanaRpcUrls.length > 0
    ) {
      const result = await fetchSolanaNativeBalanceViaRpc(
        walletAddresses.solanaAddress,
        readiness.solanaRpcUrls,
      );
      return {
        balance: result.solBalance,
        formatted: result.solBalance,
        symbol: "SOL",
        chainId,
      };
    }

    const evmFallback =
      readiness && chainId != null
        ? resolveEvmNativeBalanceFallback(chainId, readiness)
        : null;
    if (evmFallback && walletAddresses.evmAddress) {
      const balance = await fetchEvmNativeBalanceViaRpc(
        evmFallback.rpcUrl,
        walletAddresses.evmAddress,
      );
      return {
        balance,
        formatted: balance,
        symbol: evmFallback.symbol,
        chainId: evmFallback.chainId,
      };
    }

    throw error;
  }
}

export interface StewardTokenBalancesResult {
  native: {
    balance: string;
    formatted: string;
    symbol: string;
    chainId: number;
  };
  tokens: Array<{
    address: string;
    symbol: string;
    name: string;
    balance: string;
    formatted: string;
    decimals: number;
    valueUsd?: string;
    logoUrl?: string;
  }>;
}

/**
 * Fetch token balances for a steward-managed agent wallet.
 * The SDK doesn't expose a token-list endpoint, so this uses a direct
 * fetch to `GET /agents/:agentId/tokens?chainId=X`.
 */
export async function getStewardTokenBalances(
  agentId: string,
  chainId?: number,
  options: StewardBridgeOptions = {},
): Promise<StewardTokenBalancesResult> {
  const env = options.env ?? process.env;
  const baseUrl = getStewardBaseUrl(env);
  if (!baseUrl) throw new Error("Steward not configured");

  const headers = buildStewardHeaders(env);
  const qs = chainId != null ? `?chainId=${encodeURIComponent(chainId)}` : "";
  try {
    const res = await fetch(
      `${baseUrl}/agents/${encodeURIComponent(agentId)}/tokens${qs}`,
      { headers },
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new Error(
        `Steward token balances failed (${res.status}): ${errText}`,
      );
    }

    const body = (await res.json()) as {
      ok?: boolean;
      data?: StewardTokenBalancesResult;
    };
    return (
      body.data ?? {
        native: {
          balance: "0",
          formatted: "0",
          symbol: "???",
          chainId: chainId ?? 0,
        },
        tokens: [],
      }
    );
  } catch (error) {
    const readiness = resolveStewardRpcReadinessSafe();
    const walletAddresses = await getStewardWalletAddresses({
      ...options,
      agentId,
    });

    if (
      chainId === 101 &&
      walletAddresses.solanaAddress &&
      readiness &&
      readiness.solanaRpcUrls.length > 0
    ) {
      const native = await fetchSolanaNativeBalanceViaRpc(
        walletAddresses.solanaAddress,
        readiness.solanaRpcUrls,
      );
      return {
        native: {
          balance: native.solBalance,
          formatted: native.solBalance,
          symbol: "SOL",
          chainId,
        },
        tokens: [],
      };
    }

    const evmFallback =
      readiness && chainId != null
        ? resolveEvmNativeBalanceFallback(chainId, readiness)
        : null;
    if (evmFallback && walletAddresses.evmAddress) {
      const nativeBalance = await fetchEvmNativeBalanceViaRpc(
        evmFallback.rpcUrl,
        walletAddresses.evmAddress,
      );
      return {
        native: {
          balance: nativeBalance,
          formatted: nativeBalance,
          symbol: evmFallback.symbol,
          chainId: evmFallback.chainId,
        },
        tokens: [],
      };
    }

    throw error;
  }
}

// ── Extended steward operations (not yet in @stwd/sdk) ───────────────────────

/**
 * Build auth headers for direct steward API calls.
 * Used for endpoints not yet exposed in the SDK (pending, approve, deny).
 */
export function buildStewardHeaders(
  env: NodeJS.ProcessEnv = process.env,
): Headers {
  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json");

  const connection = resolveStewardConnection(env);
  const bearerToken = connection.bearerToken;
  const apiKey = connection.apiKey;
  const tenantId = connection.tenantId;

  if (bearerToken) {
    headers.set("Authorization", `Bearer ${bearerToken}`);
  } else if (apiKey) {
    headers.set("X-Steward-Key", apiKey);
  }
  if (tenantId) {
    headers.set("X-Steward-Tenant", tenantId);
  }
  return headers;
}

function getStewardBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return resolveStewardConnection(env).baseUrl;
}

export interface StewardPendingEntry {
  queueId: string;
  status: string;
  requestedAt: string;
  transaction: TxRecord;
}

/**
 * Fetch pending approval queue from steward.
 * Returns empty array if the endpoint is not available (404).
 */
export async function getStewardPendingApprovals(
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StewardPendingEntry[]> {
  const baseUrl = getStewardBaseUrl(env);
  if (!baseUrl) throw new Error("Steward not configured");

  const headers = buildStewardHeaders(env);
  const res = await fetch(
    `${baseUrl}/vault/${encodeURIComponent(agentId)}/pending`,
    { headers },
  );

  if (res.status === 404) return [];

  if (!res.ok) {
    const errText = await res.text().catch(() => "Unknown error");
    throw new Error(
      `Steward pending approvals failed (${res.status}): ${errText}`,
    );
  }

  const body = await res.json();
  return body.data ?? body ?? [];
}

/**
 * Approve a pending transaction on steward.
 */
export async function approveStewardTransaction(
  agentId: string,
  txId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ txId: string; txHash?: string }> {
  const baseUrl = getStewardBaseUrl(env);
  if (!baseUrl) throw new Error("Steward not configured");

  const headers = buildStewardHeaders(env);
  const res = await fetch(
    `${baseUrl}/vault/${encodeURIComponent(agentId)}/approve/${encodeURIComponent(txId)}`,
    { method: "POST", headers },
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => "Unknown error");
    throw new Error(`Steward approve failed (${res.status}): ${errText}`);
  }

  const body = await res.json();
  return body.data ?? body;
}

/**
 * Deny/reject a pending transaction on steward.
 * Uses POST /vault/:agentId/reject/:txId
 */
export async function denyStewardTransaction(
  agentId: string,
  txId: string,
  reason?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ txId: string }> {
  const baseUrl = getStewardBaseUrl(env);
  if (!baseUrl) throw new Error("Steward not configured");

  const headers = buildStewardHeaders(env);
  const reqBody: Record<string, string> = {};
  if (reason) reqBody.reason = reason;

  const res = await fetch(
    `${baseUrl}/vault/${encodeURIComponent(agentId)}/reject/${encodeURIComponent(txId)}`,
    { method: "POST", headers, body: JSON.stringify(reqBody) },
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => "Unknown error");
    throw new Error(`Steward deny failed (${res.status}): ${errText}`);
  }

  const body = await res.json().catch(() => ({}));
  return body.data ?? body ?? { txId };
}

/**
 * Fetch transaction history from steward.
 * Uses GET /vault/:agentId/history for full transaction records.
 */
export async function getStewardHistory(
  agentId: string,
  opts?: { limit?: number; offset?: number },
  env: NodeJS.ProcessEnv = process.env,
): Promise<TxRecord[]> {
  const baseUrl = getStewardBaseUrl(env);
  if (!baseUrl) throw new Error("Steward not configured");

  const headers = buildStewardHeaders(env);
  const params = new URLSearchParams();
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  if (opts?.offset != null) params.set("offset", String(opts.offset));
  const qs = params.toString() ? `?${params.toString()}` : "";

  const res = await fetch(
    `${baseUrl}/vault/${encodeURIComponent(agentId)}/history${qs}`,
    { headers },
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => "Unknown error");
    throw new Error(`Steward history failed (${res.status}): ${errText}`);
  }

  const body = await res.json();
  return body.data ?? body ?? [];
}

/**
 * Provision a steward wallet for a new agent.
 * Creates the agent identity + wallet on steward, optionally with default policies.
 */
export async function provisionStewardWallet(params: {
  agentId: string;
  agentName: string;
  platformId?: string;
  defaultPolicies?: PolicyRule[];
  env?: NodeJS.ProcessEnv;
}): Promise<{ walletAddress: string }> {
  const env = params.env ?? process.env;
  const client = createStewardClient({ env });
  if (!client) {
    throw new Error("Steward not configured — cannot provision wallet");
  }

  const identity = await client.createWallet(
    params.agentId,
    params.agentName,
    params.platformId,
  );

  // Apply default policies if provided
  if (params.defaultPolicies && params.defaultPolicies.length > 0) {
    await client.setPolicies(params.agentId, params.defaultPolicies);
  }

  return { walletAddress: identity.walletAddress };
}

// ── Steward Vault Signing ────────────────────────────────────────────────────

/**
 * Sign (and optionally broadcast) a transaction through the Steward vault.
 *
 * This calls `POST /vault/:agentId/sign` directly. The three possible outcomes
 * are mapped to a combined {@link StewardSignResponse}:
 *
 * - **Approved** (HTTP 200): `{ approved: true, txHash }`.
 * - **Pending approval** (HTTP 202): `{ approved: false, pending: true, txId }`.
 * - **Denied** (HTTP 403): `{ approved: false, denied: true, violations }`.
 */
export async function signViaSteward(
  request: StewardSignRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StewardSignResponse> {
  const baseUrl = getStewardBaseUrl(env);
  if (!baseUrl) throw new Error("Steward not configured");

  const evmAddress =
    normalizeEnvValue(env.EVM_ADDRESS) ??
    normalizeEnvValue(env.ELIZA_EVM_ADDRESS) ??
    null;
  const agentId = resolveStewardAgentId(env, evmAddress);
  if (!agentId) throw new Error("Steward agent ID not resolved");

  const headers = buildStewardHeaders(env);
  const res = await fetch(
    `${baseUrl}/vault/${encodeURIComponent(agentId)}/sign`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        to: request.to,
        value: request.value,
        chainId: request.chainId,
        data: request.data,
        broadcast: request.broadcast ?? true,
        description: request.description,
      }),
    },
  );

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  // Approved — HTTP 200
  if (res.ok && body.ok === true) {
    const data = (body.data ?? {}) as Record<string, unknown>;
    return {
      approved: true,
      txHash: typeof data.txHash === "string" ? data.txHash : undefined,
    };
  }

  // Pending approval — HTTP 202
  if (res.status === 202) {
    const data = (body.data ?? {}) as Record<string, unknown>;
    return {
      approved: false,
      pending: true,
      txId: typeof data.txId === "string" ? data.txId : undefined,
      violations: normalizeViolations(data.violations),
    };
  }

  // Denied — HTTP 403
  if (res.status === 403) {
    const data = (body.data ?? {}) as Record<string, unknown>;
    return {
      approved: false,
      denied: true,
      violations: normalizeViolations(data.violations),
    };
  }

  // Unexpected error
  const errMsg =
    typeof body.error === "string"
      ? body.error
      : `Steward sign failed (${res.status})`;
  throw new Error(errMsg);
}

function normalizeViolations(
  raw: unknown,
): Array<{ policy: string; reason: string }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .filter(
      (v): v is { policy: string; reason: string } =>
        !!v &&
        typeof v === "object" &&
        typeof (v as Record<string, unknown>).policy === "string" &&
        typeof (v as Record<string, unknown>).reason === "string",
    )
    .map((v) => ({ policy: v.policy, reason: v.reason }));
}

// ── Webhook Support ──────────────────────────────────────────────────────────

export type StewardWebhookEventType =
  | "tx.pending"
  | "tx.approved"
  | "tx.denied"
  | "tx.confirmed";

export interface StewardWebhookEvent {
  event: StewardWebhookEventType;
  data: Record<string, unknown>;
  timestamp?: string;
}

const MAX_WEBHOOK_EVENTS = 200;

/**
 * In-memory ring buffer for recent webhook events from steward.
 * The UI can poll these to get near-real-time updates without WebSocket.
 */
const recentWebhookEvents: StewardWebhookEvent[] = [];

/** Push a webhook event into the in-memory buffer. */
export function pushWebhookEvent(event: StewardWebhookEvent): void {
  recentWebhookEvents.push(event);
  if (recentWebhookEvents.length > MAX_WEBHOOK_EVENTS) {
    recentWebhookEvents.splice(
      0,
      recentWebhookEvents.length - MAX_WEBHOOK_EVENTS,
    );
  }
}

/** Read recent webhook events, optionally filtered by event type. */
export function getRecentWebhookEvents(
  eventType?: StewardWebhookEventType,
  sinceIndex = 0,
): { events: StewardWebhookEvent[]; nextIndex: number } {
  const all = eventType
    ? recentWebhookEvents.filter((e) => e.event === eventType)
    : recentWebhookEvents;
  const events = all.slice(sinceIndex);
  return { events, nextIndex: recentWebhookEvents.length };
}

/**
 * Register a webhook URL with steward so it pushes tx events to the app.
 * Calls PUT /tenants/:tenantId with { webhookUrl }.
 */
export async function registerStewardWebhook(
  webhookUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const baseUrl = getStewardBaseUrl(env);
  if (!baseUrl) throw new Error("Steward not configured");

  const tenantId = normalizeEnvValue(env.STEWARD_TENANT_ID);
  if (!tenantId)
    throw new Error("STEWARD_TENANT_ID not set — cannot register webhook");

  const headers = buildStewardHeaders(env);
  const res = await fetch(
    `${baseUrl}/tenants/${encodeURIComponent(tenantId)}`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({ webhookUrl }),
    },
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => "Unknown error");
    throw new Error(
      `Steward webhook registration failed (${res.status}): ${errText}`,
    );
  }
}

/**
 * Attempt to register the local webhook endpoint with steward.
 * Logs but does not throw on failure (best-effort).
 */
export async function tryRegisterStewardWebhook(
  port = Number(
    process.env.ELIZA_API_PORT?.trim() ||
      process.env.ELIZA_PORT?.trim() ||
      "31337",
  ) || 31337,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!isStewardConfigured(env)) return;

  const webhookUrl = `http://127.0.0.1:${port}/api/wallet/steward-webhook`;
  try {
    await registerStewardWebhook(webhookUrl, env);
    console.info(`[steward] Webhook registered: ${webhookUrl}`);
  } catch (err) {
    console.warn(
      `[steward] Webhook registration failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// ── Steward Auto-Setup (first launch) ────────────────────────────────────────

/** Promise-based lock to prevent concurrent ensureStewardAgent calls. */
let ensureStewardAgentPromise: Promise<EnsureStewardAgentResult | null> | null =
  null;

export interface EnsureStewardAgentResult {
  agentId: string;
  agentName: string;
  walletAddresses: { evm: string | null; solana: string | null };
  created: boolean;
}

/**
 * Ensure the configured steward agent exists. If it doesn't, create it.
 *
 * This is a lazy-init function — call it on first request to steward-status,
 * not on server startup. It's idempotent and will only run once per process.
 *
 * If steward setup fails, logs a warning and returns null (does not throw).
 */
export function ensureStewardAgent(
  options: {
    agentId?: string;
    agentName?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<EnsureStewardAgentResult | null> {
  if (!ensureStewardAgentPromise) {
    ensureStewardAgentPromise = doEnsureStewardAgent(options);
  }
  return ensureStewardAgentPromise;
}

async function doEnsureStewardAgent(
  options: {
    agentId?: string;
    agentName?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<EnsureStewardAgentResult | null> {
  const env = options.env ?? process.env;
  const baseUrl = normalizeEnvValue(env.STEWARD_API_URL);
  if (!baseUrl) {
    return null;
  }

  const agentId = options.agentId ?? resolveStewardAgentId(env) ?? null;

  if (!agentId) {
    return null;
  }

  const agentName = options.agentName ?? agentId;

  try {
    const client = createStewardClient({ env });
    if (!client) {
      return null;
    }

    // Check if agent exists
    try {
      const agent = (await client.getAgent(agentId)) as {
        id: string;
        name?: string;
        walletAddress?: string;
        walletAddresses?: { evm?: string; solana?: string };
      };

      const result: EnsureStewardAgentResult = {
        agentId,
        agentName: agent.name || agentName,
        walletAddresses: {
          evm:
            agent.walletAddresses?.evm?.trim() ||
            agent.walletAddress?.trim() ||
            null,
          solana: agent.walletAddresses?.solana?.trim() || null,
        },
        created: false,
      };

      // Update persisted credentials with wallet addresses
      persistAgentCredentials(baseUrl, env, result);

      return result;
    } catch (err: unknown) {
      if (
        !(err instanceof StewardApiError) ||
        (err as StewardApiError).status !== 404
      ) {
        throw err;
      }
    }

    // Agent doesn't exist — try to create it
    console.info(`[steward] Agent "${agentId}" not found, creating...`);

    const tenantId = normalizeEnvValue(env.STEWARD_TENANT_ID);
    const apiKey = normalizeEnvValue(env.STEWARD_API_KEY);

    // Try to create tenant first (may already exist, that's ok)
    if (tenantId && apiKey) {
      try {
        const tenantRes = await fetch(`${baseUrl}/tenants`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Api-Key": normalizeEnvValue(env.STEWARD_MASTER_PASSWORD) ?? "",
          },
          body: JSON.stringify({
            id: tenantId,
            name: "Desktop",
            apiKeyHash: fingerprintRandomToken(apiKey),
          }),
        });

        if (!tenantRes.ok) {
          const body = (await tenantRes.json().catch(() => ({}))) as {
            error?: string;
          };
          if (!body.error?.includes("already exists")) {
            console.warn(
              `[steward] Tenant creation returned ${tenantRes.status}: ${body.error}`,
            );
          }
        }
      } catch (tenantErr) {
        console.warn(
          `[steward] Tenant creation failed (non-fatal): ${
            tenantErr instanceof Error ? tenantErr.message : String(tenantErr)
          }`,
        );
      }
    }

    // Create agent
    const headers = buildStewardHeaders(env);
    const agentRes = await fetch(`${baseUrl}/agents`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: agentId, name: agentName }),
    });

    if (!agentRes.ok) {
      const errText = await agentRes.text().catch(() => "Unknown error");
      console.warn(
        `[steward] Agent creation failed (${agentRes.status}): ${errText}`,
      );
      return null;
    }

    const agentBody = (await agentRes.json()) as {
      ok: boolean;
      data?: {
        id: string;
        walletAddress?: string;
        walletAddresses?: { evm?: string; solana?: string };
      };
    };

    if (!agentBody.ok || !agentBody.data) {
      console.warn("[steward] Agent creation returned unexpected response");
      return null;
    }

    // Get agent token
    let agentToken = "";
    try {
      const tokenRes = await fetch(
        `${baseUrl}/agents/${encodeURIComponent(agentId)}/token`,
        { method: "POST", headers },
      );
      if (tokenRes.ok) {
        const tokenBody = (await tokenRes.json()) as {
          ok: boolean;
          data?: { token: string };
        };
        agentToken = tokenBody.data?.token ?? "";
      }
    } catch {
      console.warn("[steward] Token generation failed (non-fatal)");
    }

    const result: EnsureStewardAgentResult = {
      agentId,
      agentName,
      walletAddresses: {
        evm:
          agentBody.data.walletAddresses?.evm?.trim() ||
          agentBody.data.walletAddress?.trim() ||
          null,
        solana: agentBody.data.walletAddresses?.solana?.trim() || null,
      },
      created: true,
    };

    console.info(
      `[steward] Agent "${agentId}" created with wallet ${result.walletAddresses.evm ?? "(none)"}`,
    );

    // Persist credentials
    persistAgentCredentials(baseUrl, env, result, agentToken);

    return result;
  } catch (err) {
    console.warn(
      `[steward] Auto-setup failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

function persistAgentCredentials(
  apiUrl: string,
  env: NodeJS.ProcessEnv,
  result: EnsureStewardAgentResult,
  agentToken?: string,
): void {
  try {
    const existing = loadStewardCredentials();
    saveStewardCredentials({
      apiUrl,
      tenantId:
        normalizeEnvValue(env.STEWARD_TENANT_ID) ?? existing?.tenantId ?? "",
      agentId: result.agentId,
      apiKey: normalizeEnvValue(env.STEWARD_API_KEY) ?? existing?.apiKey ?? "",
      agentToken:
        agentToken ??
        normalizeEnvValue(env.STEWARD_AGENT_TOKEN) ??
        existing?.agentToken ??
        "",
      walletAddresses: {
        evm: result.walletAddresses.evm ?? undefined,
        solana: result.walletAddresses.solana ?? undefined,
      },
      agentName: result.agentName,
    });
  } catch (credErr) {
    console.warn(
      `[steward] Failed to persist credentials (non-fatal): ${
        credErr instanceof Error ? credErr.message : String(credErr)
      }`,
    );
  }
}

/** Reset the ensured flag (for testing). */
export function __resetStewardAgentEnsured(): void {
  ensureStewardAgentPromise = null;
}
