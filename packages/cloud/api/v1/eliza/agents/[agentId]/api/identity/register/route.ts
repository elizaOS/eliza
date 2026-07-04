// Handles v1 cloud API v1 eliza agents agentid api identity register route traffic with route-local auth expectations.
import { type Context, Hono } from "hono";
import { type Address, isAddress } from "viem";
import { dbWrite } from "@/db/helpers";
import { agentIdentities } from "@/db/schemas/agent-identities";
import { nextStyleParams } from "@/lib/api/hono-next-style-params";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  defaultRegistry,
  getCurrentIdentity,
  identityClient,
  json,
  normalizeChainId,
  optionsResponse,
  policiesAllowRegister,
  requireAgent,
  resolveStewardWallet,
  routeError,
  serializeIdentity,
  stewardSendContractTx,
} from "../common";

function __next_OPTIONS() {
  return optionsResponse();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function handleRegisterIdentity(
  c: Context<AppEnv>,
  paramsPromise: Promise<{ agentId: string }>,
): Promise<Response> {
  try {
    const { agentId } = await paramsPromise;
    const auth = await requireAgent(c, agentId);
    if ("response" in auth && auth.response) return auth.response;

    const existing = await getCurrentIdentity(
      agentId,
      auth.user.organization_id,
    );
    if (existing) {
      return json({
        success: true,
        data: { ...serializeIdentity(existing), idempotent: true },
      });
    }

    const body = (await c.req.json().catch(() => null)) as unknown;
    if (!isObject(body))
      return json(
        { success: false, error: "Invalid JSON body" },
        { status: 400 },
      );
    const chainId = normalizeChainId(body.chainId);
    if (!chainId)
      return json(
        { success: false, error: "chainId must be 56 or 97" },
        { status: 400 },
      );
    const agentURI =
      typeof body.agentURI === "string" && body.agentURI.trim()
        ? body.agentURI.trim()
        : null;
    if (!agentURI)
      return json(
        { success: false, error: "agentURI is required" },
        { status: 400 },
      );
    const registry =
      typeof body.registry === "string" && isAddress(body.registry)
        ? (body.registry as Address)
        : defaultRegistry(chainId);
    const uriIpfs = typeof body.uriIpfs === "string" ? body.uriIpfs : null;

    const wallet = await resolveStewardWallet({
      sandboxAgentId: agentId,
      organizationId: auth.user.organization_id,
    });
    if (wallet instanceof Response) return wallet;

    const policies = await wallet.client.getPolicies(wallet.stewardAgentId);
    const policy = policiesAllowRegister(policies, chainId, registry);
    if (!policy.allowed) {
      return json(
        {
          success: false,
          error: "Steward policy denied ERC-8004 register",
          reason: policy.reason,
        },
        { status: 403 },
      );
    }

    const txHashOrResponse = await stewardSendContractTx({
      client: wallet.client,
      stewardAgentId: wallet.stewardAgentId,
      registry,
      chainId,
      functionName: "register",
      args: [agentURI],
    });
    if (txHashOrResponse instanceof Response) return txHashOrResponse;

    const client = identityClient(chainId, registry);
    const receipt = await client.publicClient.waitForTransactionReceipt({
      hash: txHashOrResponse,
      timeout: 60_000,
    });
    const agentIdOnchain = await client.getAgentId(txHashOrResponse);
    const [owner, agentUriOnchain] = await Promise.all([
      client.getOwner(agentIdOnchain),
      client.getAgentURI(agentIdOnchain),
    ]);

    const inserted = await dbWrite
      .insert(agentIdentities)
      .values({
        organization_id: auth.user.organization_id,
        sandbox_agent_id: agentId,
        standard: "erc-8004",
        chain_id: chainId,
        registry_address: registry,
        token_id: agentIdOnchain.toString(),
        agent_uri: agentURI,
        uri_ipfs: uriIpfs,
        owner_wallet_address: owner,
        tx_hash: txHashOrResponse,
        block_number: receipt.blockNumber?.toString(),
        status: "confirmed",
      })
      .returning();

    return json({
      success: true,
      data: {
        agentId: inserted[0]?.sandbox_agent_id ?? agentId,
        agentIdOnchain: agentIdOnchain.toString(),
        txHash: txHashOrResponse,
        owner,
        chainId,
        registry,
        uri: agentURI,
        agentUriOnchain,
      },
    });
  } catch (error) {
    return routeError(c, error);
  }
}

const app = new Hono<AppEnv>();
app.options("/", () => __next_OPTIONS());
app.post("/", (c) =>
  handleRegisterIdentity(
    c,
    nextStyleParams(c, [{ name: "agentId", splat: false }] as const).params,
  ),
);
export default app;
