// Coordinates cloud service server wallets behavior behind route handlers.
import { buildWalletProvisionChallenge } from "@elizaos/cloud-sdk/wallet-provision-challenge";
import { StewardApiError } from "@stwd/sdk";
import { and, eq } from "drizzle-orm";
import { verifyMessage } from "viem";
import { db } from "../../db/client";
import { type AgentServerWallet, agentServerWallets } from "../../db/schemas/agent-server-wallets";
import { cache } from "../cache/client";
import { logger } from "../utils/logger";
import { createStewardClient } from "./steward-client";
import { resolveStewardTenantCredentials } from "./steward-tenant-config";

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

class ProvisionProofExpiredError extends Error {
  constructor() {
    super("Provision proof expired: timestamp must be within 5 minutes of server time");
    this.name = "ProvisionProofExpiredError";
  }
}

class ProvisionProofInvalidError extends Error {
  constructor() {
    super("Invalid provision proof: signature does not prove control of clientAddress");
    this.name = "ProvisionProofInvalidError";
  }
}

class ProvisionProofReplayError extends Error {
  constructor() {
    super("Provision proof nonce already used: request appears to be a replay");
    this.name = "ProvisionProofReplayError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Proof that the caller controls the `clientAddress` private key: a signature
 * over {@link buildWalletProvisionChallenge}, bound to a freshness window
 * (`timestamp`) and single-use (`nonce`).
 */
export interface ProvisionControlProof {
  signature: `0x${string}`;
  timestamp: number;
  nonce: string;
}

export interface ProvisionWalletParams {
  organizationId: string;
  userId: string;
  characterId: string | null;
  clientAddress: string;
  chainType: "evm" | "solana";
  controlProof: ProvisionControlProof;
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
// Proof-of-control
// ---------------------------------------------------------------------------

const PROVISION_PROOF_WINDOW_MS = 5 * 60 * 1000;

/**
 * Proves the caller controls the `clientAddress` private key before a wallet is
 * provisioned under it. Provision is otherwise authenticated only by the org's
 * API key, so without this any org could claim an arbitrary address: the
 * globally-unique-per-chain row then blocks the true key-holder's own
 * provision for that chain (a permanent DoS) and captures that address's RPC
 * routing (`#10279`).
 *
 * The caller signs {@link buildWalletProvisionChallenge} with the clientAddress
 * key; we rebuild the identical message, verify the signature, enforce a
 * freshness window, and reject nonce replays.
 *
 * Nonce replay is enforced only while the cache is reachable. Unlike RPC —
 * where a replayed payload re-executes a transaction and so must fail closed —
 * re-running a provision is idempotent (same org + clientAddress returns the
 * existing wallet), so degrading to signature + freshness during a cache outage
 * costs no real safety and keeps provisioning available.
 */
async function assertProvisionControlProof(params: {
  clientAddress: string;
  chainType: "evm" | "solana";
  proof: ProvisionControlProof;
}): Promise<void> {
  const { clientAddress, chainType, proof } = params;

  if (!proof.timestamp || Math.abs(Date.now() - proof.timestamp) > PROVISION_PROOF_WINDOW_MS) {
    throw new ProvisionProofExpiredError();
  }

  const message = buildWalletProvisionChallenge({
    clientAddress,
    chainType,
    timestamp: proof.timestamp,
    nonce: proof.nonce,
  });

  let isValid = false;
  try {
    isValid = await verifyMessage({
      address: clientAddress as `0x${string}`,
      message,
      signature: proof.signature,
    });
  } catch {
    // A malformed address/signature is a failed proof, never a 500.
    isValid = false;
  }
  if (!isValid) {
    throw new ProvisionProofInvalidError();
  }

  if (cache.isAvailable()) {
    const nonceKey = `wallet-provision-nonce:${clientAddress.toLowerCase()}:${proof.nonce}`;
    const nonceClaimed = await cache.setIfNotExists(nonceKey, "1", PROVISION_PROOF_WINDOW_MS);
    if (!nonceClaimed) {
      throw new ProvisionProofReplayError();
    }
  }
}

// ---------------------------------------------------------------------------
// Provision — top-level router
// ---------------------------------------------------------------------------

export async function provisionServerWallet(params: ProvisionWalletParams) {
  const clientAddress = params.clientAddress.toLowerCase();
  await assertProvisionControlProof({
    clientAddress,
    chainType: params.chainType,
    proof: params.controlProof,
  });
  return provisionStewardWallet({ ...params, clientAddress });
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
// RPC execution — top-level (validates signature, routes by provider)
// ---------------------------------------------------------------------------

export async function executeServerWalletRpc({ clientAddress, payload, signature }: ExecuteParams) {
  const normalizedClientAddress = clientAddress.toLowerCase();
  // Timestamp check
  const now = Date.now();
  const RPC_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;
  if (!payload.timestamp || now - payload.timestamp > RPC_TIMESTAMP_WINDOW_MS) {
    throw new RpcRequestExpiredError();
  }

  // Signature verification
  const isValid = await verifyMessage({
    address: normalizedClientAddress as `0x${string}`,
    message: JSON.stringify(payload),
    signature,
  });
  if (!isValid) {
    throw new InvalidRpcSignatureError();
  }

  // Nonce replay protection — TTL matches the timestamp window since older
  // payloads are already rejected by the timestamp check above.
  const nonceKey = `rpc-nonce:${normalizedClientAddress}:${payload.nonce}`;
  const nonceSet = await cache.setIfNotExists(nonceKey, "1", RPC_TIMESTAMP_WINDOW_MS);
  if (!nonceSet) {
    throw new RpcReplayError();
  }

  // Look up the EVM wallet record globally by client_address + chain_type. The
  // wallet-signature auth above already proves control of the key, and
  // proof-of-control at provision keeps that pair unambiguous. Scoping it to the
  // RPC-signer's org would never match — provision stores the row under the
  // API-key owner's org, the RPC signer resolves to a separate wallet-derived
  // org (#10279).
  const walletRecord = await db.query.agentServerWallets.findFirst({
    where: and(
      eq(agentServerWallets.client_address, normalizedClientAddress),
      eq(agentServerWallets.chain_type, "evm"),
    ),
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
