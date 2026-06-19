import { type Context, Hono } from "hono";
import { type Address, isAddress } from "viem";
import { nextStyleParams } from "@/lib/api/hono-next-style-params";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  defaultRegistry,
  getCurrentIdentity,
  identityClient,
  json,
  normalizeChainId,
  optionsResponse,
  requireAgent,
  routeError,
} from "../common";

function __next_OPTIONS() {
  return optionsResponse();
}

export async function handleGetOnchainIdentity(
  c: Context<AppEnv>,
  paramsPromise: Promise<{ agentId: string }>,
): Promise<Response> {
  try {
    const { agentId } = await paramsPromise;
    const auth = await requireAgent(c, agentId);
    if ("response" in auth && auth.response) return auth.response;
    const url = new URL(c.req.url);
    const dbIdentity = await getCurrentIdentity(
      agentId,
      auth.user.organization_id,
    ).catch(() => null);
    const chainId = normalizeChainId(
      Number(url.searchParams.get("chainId")) || dbIdentity?.chain_id || 56,
    );
    if (!chainId)
      return json(
        { success: false, error: "chainId must be 56 or 97" },
        { status: 400 },
      );
    const registryParam = url.searchParams.get("registry");
    const registry =
      registryParam && isAddress(registryParam)
        ? (registryParam as Address)
        : ((dbIdentity?.registry_address as Address | undefined) ??
          defaultRegistry(chainId));
    const onchainId =
      url.searchParams.get("agentIdOnchain") ?? dbIdentity?.token_id;
    if (!onchainId)
      return json(
        { success: false, error: "Identity not found" },
        { status: 404 },
      );
    const tokenId = BigInt(onchainId);
    const client = identityClient(chainId, registry);
    try {
      const [owner, uri] = await Promise.all([
        client.getOwner(tokenId),
        client.getAgentURI(tokenId),
      ]);
      return json({
        success: true,
        data: {
          exists: true,
          agentIdOnchain: tokenId.toString(),
          owner,
          uri,
          chainId,
          registry,
        },
      });
    } catch (error) {
      return json({
        success: true,
        data: {
          exists: false,
          agentIdOnchain: tokenId.toString(),
          chainId,
          registry,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  } catch (error) {
    return routeError(c, error);
  }
}

const app = new Hono<AppEnv>();
app.options("/", () => __next_OPTIONS());
app.get("/", (c) =>
  handleGetOnchainIdentity(
    c,
    nextStyleParams(c, [{ name: "agentId", splat: false }] as const).params,
  ),
);
export default app;
