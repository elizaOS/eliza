import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { dbWrite } from "@/db/helpers";
import { agentIdentities } from "@/db/schemas/agent-identities";
import { nextStyleParams } from "@/lib/api/hono-next-style-params";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  getCurrentIdentity,
  identityClient,
  json,
  optionsResponse,
  policiesAllowRegister,
  requireAgent,
  resolveStewardWallet,
  routeError,
  stewardSendContractTx,
} from "../common";

function __next_OPTIONS() {
  return optionsResponse();
}
function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function handlePutIdentityUri(
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
    if (!existing)
      return json(
        { success: false, error: "Identity not found" },
        { status: 404 },
      );
    const body = (await c.req.json().catch(() => null)) as unknown;
    if (!isObject(body) || typeof body.uri !== "string" || !body.uri.trim()) {
      return json(
        { success: false, error: "uri is required" },
        { status: 400 },
      );
    }
    const chainId =
      existing.chain_id === 56 || existing.chain_id === 97
        ? existing.chain_id
        : 56;
    const registry = existing.registry_address as `0x${string}`;
    const wallet = await resolveStewardWallet({
      sandboxAgentId: agentId,
      organizationId: auth.user.organization_id,
    });
    if (wallet instanceof Response) return wallet;
    const policies = await wallet.client.getPolicies(wallet.stewardAgentId);
    const policy = policiesAllowRegister(policies, chainId, registry);
    if (!policy.allowed)
      return json(
        {
          success: false,
          error: "Steward policy denied ERC-8004 URI update",
          reason: policy.reason,
        },
        { status: 403 },
      );
    const txHashOrResponse = await stewardSendContractTx({
      client: wallet.client,
      stewardAgentId: wallet.stewardAgentId,
      registry,
      chainId,
      functionName: "setAgentURI",
      args: [BigInt(existing.token_id), body.uri.trim()],
    });
    if (txHashOrResponse instanceof Response) return txHashOrResponse;
    const client = identityClient(chainId, registry);
    await client.publicClient.waitForTransactionReceipt({
      hash: txHashOrResponse,
      timeout: 60_000,
    });
    const agentUriOnchain = await client.getAgentURI(BigInt(existing.token_id));
    await dbWrite
      .update(agentIdentities)
      .set({ agent_uri: body.uri.trim(), updated_at: new Date() })
      .where(eq(agentIdentities.id, existing.id));
    return json({
      success: true,
      data: {
        agentId,
        agentIdOnchain: existing.token_id,
        txHash: txHashOrResponse,
        uri: body.uri.trim(),
        agentUriOnchain,
      },
    });
  } catch (error) {
    return routeError(c, error);
  }
}

const app = new Hono<AppEnv>();
app.options("/", () => __next_OPTIONS());
app.put("/", (c) =>
  handlePutIdentityUri(
    c,
    nextStyleParams(c, [{ name: "agentId", splat: false }] as const).params,
  ),
);
export default app;
