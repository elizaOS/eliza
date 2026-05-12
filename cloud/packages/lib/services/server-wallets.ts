import { StewardApiError } from "@stwd/sdk";
import { eq } from "drizzle-orm";
import { verifyMessage } from "viem";
import { db } from "@/db/client";
import { type AgentServerWallet, agentServerWallets } from "@/db/schemas/agent-server-wallets";
import { cache } from "@/lib/cache/client";
import { createStewardClient } from "@/lib/services/steward-client";
import { resolveStewardTenantCredentials } from "@/lib/services/steward-tenant-config";
import { logger } from "@/lib/utils/logger";

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

class WalletAlreadyExistsError extends Error {
  constructor() {
    super("Wallet already exists for this client address");
    this.name = "WalletAlreadyExistsError";
  }
}

class RpcRequestExpiredError extends Error {
  constructor() {
    super("RPC request expired: Timestamp must be within the last 5 minutes");
    this.name = "RpcRequestExpiredError";
  }
}

class InvalidRpcSignatureError extends Error {
  constructor() {
    super(
      "Invalid RPC signature: The client address does not match the signature for this payload.",
    );
    this.name = "InvalidRpcSignatureError";
  }
}

class RpcReplayError extends Error {
  constructor() {
    super("RPC nonce already used: Request appears to be a replay attack");
    this.name = "RpcReplayError";
  }
}

class ServerWalletNotFoundError extends Error {
  constructor() {
    super("Server wallet not found: No provisioned wallet matches this client address.");
    this.name = "ServerWalletNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProvisionWalletParams {
  organizationId: string;
  userId: string;
  characterId: string | null;
  clientAddress: string;
  chainType: "evm" | "solana";
}

export interface RpcPayload {
  method: string;
  params: unknown[];
  timestamp: number;
  nonce: string;
}

export interface ExecuteParams {
  clientAddress: string;
  payload: RpcPayload;
  signature: `0x${string}`;
}

function isUniqueViolation(error: unknown): boolean {
  const code = error instanceof Error ? Reflect.get(error, "code") : undefined;
  return (
    code === "23505" || (error instanceof Error && error.message.includes("unique constraint"))
  );
}

function isStewardConflictError(error: unknown): boolean {
  const status =
    error instanceof StewardApiError
      ? error.status
      : typeof error === "object" && error !== null
        ? Reflect.get(error, "status")
        : undefined;

  return status === 409;
}

// ---------------------------------------------------------------------------
// Provision — top-level router
// ---------------------------------------------------------------------------

export async function provisionServerWallet(params: ProvisionWalletParams) {
  return provisionStewardWallet(params);
}

// ---------------------------------------------------------------------------
// Provision — Steward (new)
// ---------------------------------------------------------------------------

async function provisionStewardWallet({
  organizationId,
  userId,
  characterId,
  clientAddress,
  chainType,
}: ProvisionWalletParams) {
  const steward = await createStewardClient({ organizationId });
  const agentName = `cloud-${characterId || clientAddress}`;
  const { tenantId } = await resolveStewardTenantCredentials({ organizationId });
  const persistWalletRecord = async (agentId: string, walletAddress: string) =>
    (
      await db
        .insert(agentServerWallets)
        .values({
          organization_id: organizationId,
          user_id: userId,
          character_id: characterId,
          steward_agent_id: agentId,
          steward_tenant_id: tenantId,
          address: walletAddress,
          chain_type: chainType,
          client_address: clientAddress,
        })
        .returning()
    )[0];

  try {
    // Create agent + wallet in Steward (idempotent — 409 means already exists)
    const agent = await steward.createWallet(agentName, `Agent ${agentName}`, clientAddress);
    const walletAddress = agent.walletAddress;

    if (!walletAddress) {
      throw new Error(`Steward did not return a wallet address for agent ${agentName}`);
    }

    const record = await persistWalletRecord(agent.id, walletAddress);

    logger.info(`[server-wallets] Provisioned Steward wallet for ${agent.id}: ${walletAddress}`);
    return record;
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      throw new WalletAlreadyExistsError();
    }

    if (isStewardConflictError(error)) {
      const existingAgent = await steward.getAgent(agentName);
      const walletAddress = existingAgent.walletAddress;

      if (!walletAddress) {
        throw new Error(`Steward agent ${agentName} already exists but has no wallet address`);
      }

      try {
        const record = await persistWalletRecord(existingAgent.id, walletAddress);
        logger.info(
          `[server-wallets] Reused existing Steward wallet for ${existingAgent.id}: ${walletAddress}`,
        );
        return record;
      } catch (insertError) {
        if (isUniqueViolation(insertError)) {
          throw new WalletAlreadyExistsError();
        }
        throw insertError;
      }
    }

    throw error;
  }
}

// ---------------------------------------------------------------------------
// Organization lookup
// ---------------------------------------------------------------------------

/** Returns the organization_id that owns the server wallet for this client address, or null if none. */
export async function getOrganizationIdForClientAddress(
  clientAddress: string,
): Promise<string | null> {
  const row = await db
    .select({ organization_id: agentServerWallets.organization_id })
    .from(agentServerWallets)
    .where(eq(agentServerWallets.client_address, clientAddress))
    .limit(1);
  return row[0]?.organization_id ?? null;
}

// ---------------------------------------------------------------------------
// RPC execution — top-level (validates signature, routes by provider)
// ---------------------------------------------------------------------------

export async function executeServerWalletRpc({ clientAddress, payload, signature }: ExecuteParams) {
  // Timestamp check
  const now = Date.now();
  const RPC_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;
  if (!payload.timestamp || now - payload.timestamp > RPC_TIMESTAMP_WINDOW_MS) {
    throw new RpcRequestExpiredError();
  }

  // Signature verification
  const isValid = await verifyMessage({
    address: clientAddress as `0x${string}`,
    message: JSON.stringify(payload),
    signature,
  });
  if (!isValid) {
    throw new InvalidRpcSignatureError();
  }

  // Nonce replay protection — TTL matches the timestamp window since older
  // payloads are already rejected by the timestamp check above.
  const nonceKey = `rpc-nonce:${clientAddress}:${payload.nonce}`;
  const nonceSet = await cache.setIfNotExists(nonceKey, "1", RPC_TIMESTAMP_WINDOW_MS);
  if (!nonceSet) {
    throw new RpcReplayError();
  }

  // Look up wallet record
  const walletRecord = await db.query.agentServerWallets.findFirst({
    where: eq(agentServerWallets.client_address, clientAddress),
  });
  if (!walletRecord) {
    throw new ServerWalletNotFoundError();
  }

  return executeStewardRpc(walletRecord, payload);
}

// ---------------------------------------------------------------------------
// RPC execution — Steward
// ---------------------------------------------------------------------------

async function executeStewardRpc(wallet: AgentServerWallet, payload: RpcPayload) {
  const steward = await createStewardClient({
    organizationId: wallet.organization_id,
    tenantId: wallet.steward_tenant_id,
  });
  const agentId = wallet.steward_agent_id;

  if (!agentId) {
    throw new Error(`Wallet ${wallet.id} is marked as steward but has no steward_agent_id`);
  }

  switch (payload.method) {
    case "eth_sendTransaction": {
      const [tx] = payload.params as [
        { to: string; value?: string; data?: string; chainId?: number },
      ];
      return steward.signTransaction(agentId, {
        to: tx.to,
        value: tx.value || "0",
        data: tx.data,
        ...(typeof tx.chainId === "number" ? { chainId: tx.chainId } : {}),
      });
    }

    case "personal_sign":
    case "eth_sign": {
      const [message] = payload.params as [string];
      return steward.signMessage(agentId, message);
    }

    case "eth_signTypedData_v4": {
      const [, typedData] = payload.params as [string, string | Record<string, unknown>];
      const parsed =
        typeof typedData === "string"
          ? (JSON.parse(typedData) as Record<string, unknown>)
          : typedData;
      // EIP-712 uses "message" but SDK expects "value"
      return steward.signTypedData(agentId, {
        domain: parsed.domain as Record<string, unknown>,
        types: parsed.types as Record<string, Array<{ name: string; type: string }>>,
        primaryType: parsed.primaryType as string,
        value: (parsed.message ?? parsed.value) as Record<string, unknown>,
      });
    }

    default:
      throw new Error(
        `RPC method "${payload.method}" is not supported via Steward. ` +
          `Supported: eth_sendTransaction, personal_sign, eth_sign, eth_signTypedData_v4`,
      );
  }
}
