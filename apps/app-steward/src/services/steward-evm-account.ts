/**
 * Steward EVM Account — a viem-compatible Account that routes all signing
 * through the Steward API. No private keys touch the container.
 *
 * Used when ELIZA_CLOUD_PROVISIONED=1 and STEWARD_AGENT_TOKEN is set.
 *
 * Implements viem's CustomAccount interface:
 *   - address
 *   - signMessage({ message })
 *   - signTransaction({ ... })
 *   - signTypedData({ domain, types, primaryType, message })
 *
 * The Steward API endpoints used:
 *   POST /vault/:agentId/sign          — sign + optionally broadcast EVM tx
 *   POST /vault/:agentId/sign-message  — sign arbitrary message (EIP-191)
 *   POST /vault/:agentId/sign-typed-data — sign EIP-712 typed data
 *
 * Auth: Bearer token (STEWARD_AGENT_TOKEN JWT) in Authorization header.
 */

import type {
  Account,
  Address,
  CustomSource,
  Hex,
  SignableMessage,
  TransactionSerializable,
  TypedData,
  TypedDataDefinition,
} from "viem";
import { toAccount } from "viem/accounts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StewardEvmAccountConfig {
  /** Steward API base URL (e.g. http://172.18.0.1:3200) */
  apiUrl: string;
  /** JWT bearer token for agent authentication */
  agentToken: string;
  /** Agent ID in Steward */
  agentId: string;
  /** EVM wallet address (fetched from Steward at init) */
  address: Address;
}

interface StewardApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

// ─── Steward API Client (minimal, signing-only) ──────────────────────────────

class StewardSigningClient {
  private baseUrl: string;
  private agentToken: string;
  private agentId: string;

  constructor(
    config: Pick<StewardEvmAccountConfig, "apiUrl" | "agentToken" | "agentId">,
  ) {
    this.baseUrl = config.apiUrl.replace(/\/+$/, "");
    this.agentToken = config.agentToken;
    this.agentId = config.agentId;
  }

  private async request<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${this.agentToken}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    let parsed: StewardApiResponse<T>;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        `[StewardAccount] Invalid JSON from Steward API (${response.status}): ${text.slice(0, 200)}`,
      );
    }

    if (!parsed.ok) {
      // 202 with pending_approval is a special case
      if (
        response.status === 202 &&
        parsed.data &&
        typeof parsed.data === "object" &&
        "status" in (parsed.data as Record<string, unknown>) &&
        (parsed.data as Record<string, unknown>).status === "pending_approval"
      ) {
        throw new Error(
          `[StewardAccount] Transaction requires manual approval (txId: ${(parsed.data as Record<string, unknown>).txId})`,
        );
      }
      throw new Error(
        `[StewardAccount] API error (${response.status}): ${parsed.error || "Unknown error"}`,
      );
    }

    return parsed.data as T;
  }

  /**
   * Sign an EVM transaction.
   * Returns the signed transaction hex (when broadcast=false) or txHash (when broadcast=true).
   */
  async signTransaction(tx: {
    to: string;
    value: string;
    data?: string;
    chainId?: number;
    nonce?: number;
    gas?: string;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
    broadcast?: boolean;
  }): Promise<{ signedTx?: string; txHash?: string }> {
    return this.request(`/vault/${encodeURIComponent(this.agentId)}/sign`, {
      ...tx,
      broadcast: tx.broadcast ?? false,
    });
  }

  /**
   * Sign an arbitrary message (EIP-191 personal_sign).
   */
  async signMessage(message: string): Promise<{ signature: string }> {
    return this.request(
      `/vault/${encodeURIComponent(this.agentId)}/sign-message`,
      { message },
    );
  }

  /**
   * Sign EIP-712 typed data.
   */
  async signTypedData(input: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    value: Record<string, unknown>;
  }): Promise<{ signature: string }> {
    return this.request(
      `/vault/${encodeURIComponent(this.agentId)}/sign-typed-data`,
      input,
    );
  }
}

// ─── Fetch wallet address from Steward ───────────────────────────────────────

/**
 * Fetch the EVM wallet address for an agent from the Steward API.
 * Tries /vault/:agentId/addresses first (multi-chain), falls back to /agents/:agentId.
 */
/**
 * Fetch optional multi-chain addresses from Steward (`/vault` first, then `/agents`).
 * Solana may be present from `/vault/.../addresses` while EVM may come from either path.
 */
export async function fetchStewardVaultChainAddresses(
  apiUrl: string,
  agentToken: string,
  agentId: string,
): Promise<{ evm: Address | null; solana: string | null }> {
  const baseUrl = apiUrl.replace(/\/+$/, "");
  const timeoutMs = 10_000;
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${agentToken}`,
  };

  try {
    const addrResp = await fetch(
      `${baseUrl}/vault/${encodeURIComponent(agentId)}/addresses`,
      {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (addrResp.ok) {
      const addrData = (await addrResp.json()) as StewardApiResponse<{
        evm?: string;
        solana?: string;
      }>;
      if (addrData.ok && addrData.data) {
        const evmRaw = addrData.data.evm?.trim();
        const solRaw = addrData.data.solana?.trim();
        return {
          evm: evmRaw ? (evmRaw as Address) : null,
          solana: solRaw ?? null,
        };
      }
    }
  } catch {
    // fall through
  }

  try {
    const agentResp = await fetch(
      `${baseUrl}/agents/${encodeURIComponent(agentId)}`,
      {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (agentResp.ok) {
      const agentData = (await agentResp.json()) as StewardApiResponse<{
        walletAddress?: string;
      }>;
      if (agentData.ok && agentData.data?.walletAddress) {
        return {
          evm: agentData.data.walletAddress as Address,
          solana: null,
        };
      }
    }
  } catch {
    // fall through
  }

  return { evm: null, solana: null };
}

export async function fetchStewardWalletAddress(
  apiUrl: string,
  agentToken: string,
  agentId: string,
): Promise<Address> {
  const baseUrl = apiUrl.replace(/\/+$/, "");
  const { evm } = await fetchStewardVaultChainAddresses(
    apiUrl,
    agentToken,
    agentId,
  );
  if (!evm) {
    throw new Error(
      `[StewardAccount] Could not fetch wallet address for agent "${agentId}" from ${baseUrl}`,
    );
  }
  return evm;
}

// ─── Create viem Account ─────────────────────────────────────────────────────

/**
 * Create a viem-compatible Account that routes signing through Steward API.
 *
 * Usage:
 *   const account = createStewardEvmAccount({ apiUrl, agentToken, agentId, address });
 *   const walletProvider = new WalletProvider(account, runtime, chains);
 */
export function createStewardEvmAccount(
  config: StewardEvmAccountConfig,
): Account {
  const client = new StewardSigningClient({
    apiUrl: config.apiUrl,
    agentToken: config.agentToken,
    agentId: config.agentId,
  });
  const signTypedData = async <
    const typedData extends TypedData | Record<string, unknown>,
    primaryType extends keyof typedData | "EIP712Domain" = keyof typedData,
  >(
    typedData: TypedDataDefinition<typedData, primaryType>,
  ): Promise<Hex> => {
    const td = typedData as Record<string, unknown>;
    const domain =
      td.domain && typeof td.domain === "object"
        ? (td.domain as Record<string, unknown>)
        : {};
    const types = {
      ...((td.types && typeof td.types === "object" ? td.types : {}) as Record<
        string,
        unknown
      >),
    };
    const primaryType =
      typeof td.primaryType === "string" ? td.primaryType : "";
    const value =
      td.message && typeof td.message === "object"
        ? (td.message as Record<string, unknown>)
        : {};

    // Remove the EIP712Domain type if present (Steward expects raw types)
    delete types.EIP712Domain;

    const result = await client.signTypedData({
      domain,
      types,
      primaryType,
      value,
    });
    return result.signature as Hex;
  };

  return toAccount({
    address: config.address,

    async signMessage({ message }: { message: SignableMessage }): Promise<Hex> {
      // Normalize message to string
      let msgStr: string;
      if (typeof message === "string") {
        msgStr = message;
      } else if (typeof message === "object" && "raw" in message) {
        // Raw bytes
        const raw = message.raw;
        if (typeof raw === "string") {
          msgStr = raw; // already hex
        } else {
          // Uint8Array → hex
          msgStr = `0x${Buffer.from(raw).toString("hex")}`;
        }
      } else {
        msgStr = String(message);
      }

      const result = await client.signMessage(msgStr);
      return result.signature as Hex;
    },

    async signTransaction(transaction: TransactionSerializable): Promise<Hex> {
      // Build a signing request for Steward
      const to = transaction.to ?? "0x0000000000000000000000000000000000000000";
      const value = transaction.value?.toString() ?? "0";

      // Serialize calldata if present
      const data = (transaction as Record<string, unknown>).data as
        | string
        | undefined;

      const result = await client.signTransaction({
        to,
        value,
        data,
        chainId: transaction.chainId,
        nonce: transaction.nonce,
        gas: transaction.gas?.toString(),
        maxFeePerGas: (
          transaction as Record<string, unknown>
        ).maxFeePerGas?.toString(),
        maxPriorityFeePerGas: (
          transaction as Record<string, unknown>
        ).maxPriorityFeePerGas?.toString(),
        broadcast: false, // We want the signed tx back, not a broadcast
      });

      if (result.signedTx) {
        return result.signedTx as Hex;
      }

      // If Steward returned a txHash instead (auto-broadcast), wrap it
      if (result.txHash) {
        console.warn(
          "[StewardAccount] Steward auto-broadcast tx despite broadcast=false. Hash:",
          result.txHash,
        );
        // Return the hash — callers will need to handle this edge case
        return result.txHash as Hex;
      }

      throw new Error(
        "[StewardAccount] signTransaction returned neither signedTx nor txHash",
      );
    },

    signTypedData: signTypedData as CustomSource["signTypedData"],
  });
}

// ─── Integration helper ──────────────────────────────────────────────────────

/**
 * Check if the runtime has the credentials needed to sign EVM transactions
 * through the Steward API. True for both cloud-provisioned containers
 * (ELIZA_CLOUD_PROVISIONED=1) and self-hosted Steward deployments — the
 * signing capability only depends on having the API URL and agent token.
 */
export function isStewardSigningReady(): boolean {
  return !!process.env.STEWARD_AGENT_TOKEN && !!process.env.STEWARD_API_URL;
}

/**
 * True when this runtime is a cloud-provisioned container. Informational —
 * distinguishes cloud Steward from self-hosted Steward in logs and UI, but
 * does NOT gate signing capability.
 */
export function isStewardCloudProvisioned(): boolean {
  return process.env.ELIZA_CLOUD_PROVISIONED === "1" && isStewardSigningReady();
}

/**
 * Resolve Steward config from environment variables.
 * Returns null when signing credentials are unavailable.
 */
export function resolveStewardEvmConfig(): StewardEvmAccountConfig | null {
  if (!isStewardSigningReady()) return null;

  const apiUrl = process.env.STEWARD_API_URL as string;
  const agentToken = process.env.STEWARD_AGENT_TOKEN as string;

  // Agent ID can come from the JWT payload or env var
  const agentId =
    process.env.STEWARD_AGENT_ID ||
    process.env.ELIZA_STEWARD_AGENT_ID ||
    extractAgentIdFromJwt(agentToken) ||
    "";

  if (!agentId) {
    console.warn("[StewardAccount] No agent ID found in env or JWT token");
    return null;
  }

  // Address will be fetched later from API
  return {
    apiUrl,
    agentToken,
    agentId,
    address: "0x0000000000000000000000000000000000000000" as Address, // placeholder
  };
}

/**
 * Extract agentId from a JWT token's payload (without verification).
 * Steward JWTs typically have { sub: agentId, ... } or { agentId: "..." }.
 */
function extractAgentIdFromJwt(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payloadB64 = parts[1];
    if (!payloadB64) return null;
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
    return payload.agentId || payload.sub || null;
  } catch {
    return null;
  }
}

// ─── Full initialization helper ──────────────────────────────────────────────

/**
 * Initialize a Steward-backed viem Account. Fetches the wallet address from the API.
 * Returns null if Steward is unavailable (allows fallback to local key).
 */
export async function initStewardEvmAccount(): Promise<Account | null> {
  const config = resolveStewardEvmConfig();
  if (!config) return null;

  try {
    console.log(
      "[StewardAccount] Cloud-provisioned mode detected, fetching wallet address...",
    );
    const address = await fetchStewardWalletAddress(
      config.apiUrl,
      config.agentToken,
      config.agentId,
    );
    config.address = address;
    console.log(`[StewardAccount] Wallet address: ${address}`);

    const account = createStewardEvmAccount(config);
    console.log("[StewardAccount] ✓ Steward signing proxy ready");
    return account;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[StewardAccount] Failed to initialize: ${msg}`);
    console.warn("[StewardAccount] Falling back to local key signing");
    return null;
  }
}
