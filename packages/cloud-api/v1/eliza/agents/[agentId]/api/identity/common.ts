import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { type Address, encodeFunctionData, type Hash, isAddress } from "viem";
import { bscTestnet } from "viem/chains";
import { dbWrite } from "@/db/helpers";
import { agentIdentities } from "@/db/schemas/agent-identities";
import { agentServerWallets } from "@/db/schemas/agent-server-wallets";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { resolveEvmRpc } from "@/lib/config/evm-rpc";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import {
  ERC8004_IDENTITY_REGISTRY_ADDRESSES,
  type ERC8004ChainId,
  ERC8004IdentityClient,
  identityRegistryAbi,
} from "@/lib/services/erc8004/identity-client";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { createStewardClient } from "@/lib/services/steward-client";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { resolveStewardAgentId } from "../wallet/[...path]/route";

export { policiesAllowRegister } from "./policy";

export const CORS_METHODS = "GET, POST, PUT, OPTIONS";
export const STANDARD = "erc-8004";

type StewardIdentityClient = {
  getPolicies(agentId: string): Promise<StewardPolicyRule[]>;
  signTransaction?: (
    agentId: string,
    tx: { to: string; value: string; data: string; chainId: number },
  ) => Promise<unknown>;
};

export function optionsResponse() {
  return handleCorsOptions(CORS_METHODS);
}

export function json(data: unknown, init?: ResponseInit): Response {
  return applyCorsHeaders(Response.json(data, init), CORS_METHODS);
}

export function clearDbDependencyError(error: unknown): Response | null {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /agent_identities|relation .* does not exist|column .* does not exist/i.test(
      message,
    )
  ) {
    return json(
      {
        success: false,
        error:
          "agent_identities table is not available yet; apply Track 1A migration before enabling ERC-8004 identity endpoints",
      },
      { status: 503 },
    );
  }
  return null;
}

export function rpcUrlForChain(chainId: ERC8004ChainId): string {
  if (chainId === 56) return resolveEvmRpc("bnb").url;
  return bscTestnet.rpcUrls.default.http[0];
}

export function normalizeChainId(value: unknown): ERC8004ChainId | null {
  return value === 56 || value === 97 ? value : null;
}

export function defaultRegistry(chainId: ERC8004ChainId): Address {
  return ERC8004_IDENTITY_REGISTRY_ADDRESSES[chainId];
}

export function extractTxHash(result: unknown): Hash | null {
  if (typeof result === "string" && result.startsWith("0x"))
    return result as Hash;
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    for (const key of ["txHash", "hash", "transactionHash"]) {
      const value = record[key];
      if (typeof value === "string" && value.startsWith("0x"))
        return value as Hash;
    }
  }
  return null;
}

export async function requireAgent(c: Context<AppEnv>, agentId: string) {
  const user = await requireUserOrApiKeyWithOrg(c);
  const agent = await elizaSandboxService.getAgent(
    agentId,
    user.organization_id,
  );
  if (!agent) {
    return {
      response: json(
        { success: false, error: "Agent not found" },
        { status: 404 },
      ),
    };
  }
  return { user, agent };
}

export async function getCurrentIdentity(
  sandboxAgentId: string,
  organizationId: string,
) {
  const rows = await dbWrite
    .select()
    .from(agentIdentities)
    .where(
      and(
        eq(agentIdentities.sandbox_agent_id, sandboxAgentId),
        eq(agentIdentities.organization_id, organizationId),
        eq(agentIdentities.standard, STANDARD),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export function serializeIdentity(row: typeof agentIdentities.$inferSelect) {
  return {
    id: row.id,
    agentId: row.sandbox_agent_id,
    agentIdOnchain: row.token_id,
    chainId: row.chain_id,
    registry: row.registry_address,
    uri: row.agent_uri,
    uriIpfs: row.uri_ipfs,
    owner: row.owner_wallet_address,
    txHash: row.tx_hash,
    blockNumber: row.block_number,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getWalletRecord(sandboxAgentId: string, organizationId: string) {
  const exact = await dbWrite
    .select()
    .from(agentServerWallets)
    .where(
      and(
        eq(agentServerWallets.sandbox_agent_id, sandboxAgentId),
        eq(agentServerWallets.organization_id, organizationId),
        eq(agentServerWallets.chain_type, "evm"),
      ),
    )
    .limit(1);
  if (exact[0]) return exact[0];

  const orgWallets = await dbWrite
    .select()
    .from(agentServerWallets)
    .where(
      and(
        eq(agentServerWallets.organization_id, organizationId),
        eq(agentServerWallets.chain_type, "evm"),
      ),
    )
    .limit(2);
  return orgWallets.length === 1 ? orgWallets[0] : null;
}

export async function resolveStewardWallet(params: {
  sandboxAgentId: string;
  organizationId: string;
}): Promise<
  | {
      stewardAgentId: string;
      owner: Address;
      client: StewardIdentityClient;
    }
  | Response
> {
  const stewardAgentId = await resolveStewardAgentId(
    params.sandboxAgentId,
    params.organizationId,
  );
  const walletRecord = await getWalletRecord(
    params.sandboxAgentId,
    params.organizationId,
  );
  const effectiveStewardAgentId =
    stewardAgentId ?? walletRecord?.steward_agent_id ?? null;
  if (
    !effectiveStewardAgentId ||
    !walletRecord?.address ||
    !isAddress(walletRecord.address)
  ) {
    return json(
      { error: "No Steward-managed EVM wallet found for this agent" },
      { status: 404 },
    );
  }

  let client: StewardIdentityClient;
  try {
    client = (await createStewardClient({
      organizationId: params.organizationId,
      tenantId: walletRecord.steward_tenant_id ?? undefined,
    })) as StewardIdentityClient;
  } catch (error) {
    logger.warn("[identity-api] Steward tenant config unavailable", {
      agentId: params.sandboxAgentId,
      orgId: params.organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return json({ error: "Steward not configured" }, { status: 503 });
  }

  return {
    stewardAgentId: effectiveStewardAgentId,
    owner: walletRecord.address as Address,
    client,
  };
}

export async function stewardSendContractTx(params: {
  client: StewardIdentityClient;
  stewardAgentId: string;
  registry: Address;
  chainId: ERC8004ChainId;
  functionName: "register" | "setAgentURI";
  args: readonly unknown[];
}): Promise<Hash | Response> {
  if (typeof params.client.signTransaction !== "function") {
    return json(
      {
        success: false,
        error: "Steward signing not yet wired for ERC-8004 register-identity",
        detail:
          "Expected @stwd/sdk StewardClient.signTransaction(agentId, tx) to sign and broadcast eth_sendTransaction.",
      },
      { status: 501 },
    );
  }

  const data = encodeFunctionData({
    abi: identityRegistryAbi,
    functionName: params.functionName,
    args: params.args,
  });
  const result = await params.client.signTransaction(params.stewardAgentId, {
    to: params.registry,
    value: "0",
    data,
    chainId: params.chainId,
  });
  const txHash = extractTxHash(result);
  if (!txHash) {
    return json(
      {
        success: false,
        error: "Steward signing returned no transaction hash",
        detail:
          "If Steward returns signed-but-unbroadcast transactions, add a broadcast step before enabling ERC-8004 registration.",
      },
      { status: 501 },
    );
  }
  return txHash;
}

export function identityClient(chainId: ERC8004ChainId, registry: Address) {
  return new ERC8004IdentityClient({
    chainId,
    registryAddress: registry,
    rpcUrl: rpcUrlForChain(chainId),
  });
}

export async function routeError(
  c: Context<AppEnv>,
  error: unknown,
): Promise<Response> {
  const dependency = clearDbDependencyError(error);
  if (dependency) return dependency;
  logger.error("[identity-api] request failed", error);
  return failureResponse(c, error);
}
