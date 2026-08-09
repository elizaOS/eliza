/**
 * Authenticated Cloud MCP transport for one canonical agent connector binding
 * and Google product. The broker owns token lookup and upstream allowlisting.
 */
import { type Context, Hono } from "hono";
import { userCharactersRepository } from "@/db/repositories/characters";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import {
  GoogleMcpBrokerError,
  googleMcpBroker,
} from "@/lib/services/google-mcp-broker";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();
const MAX_MCP_REQUEST_BYTES = 1024 * 1024;
const MCP_TIMEOUT_MS = 30_000;

async function canonicalAgentId(
  routeAgentId: string,
  organizationId: string,
): Promise<string | null> {
  const direct = await userCharactersRepository.findByIdInOrganization(
    routeAgentId,
    organizationId,
  );
  if (direct) return direct.id;
  const sandbox = await elizaSandboxService.getAgent(
    routeAgentId,
    organizationId,
  );
  if (!sandbox?.character_id) return null;
  const character = await userCharactersRepository.findByIdInOrganization(
    sandbox.character_id,
    organizationId,
  );
  return character?.id ?? null;
}

async function bodyBytes(request: Request): Promise<Uint8Array | undefined> {
  if (request.method === "GET" || request.method === "DELETE") return undefined;
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_MCP_REQUEST_BYTES) {
    throw new GoogleMcpBrokerError(
      400,
      "MCP_REQUEST_TOO_LARGE",
      "MCP request is too large.",
    );
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_MCP_REQUEST_BYTES) {
    throw new GoogleMcpBrokerError(
      400,
      "MCP_REQUEST_TOO_LARGE",
      "MCP request is too large.",
    );
  }
  return bytes;
}

async function handle(c: Context<AppEnv>) {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const routeAgentId = c.req.param("agentId");
    const bindingId = c.req.param("bindingId");
    const product = c.req.param("product");
    if (!routeAgentId || !bindingId || !product) {
      return c.json({ error: "Google MCP route is incomplete." }, 404);
    }
    const agentId = await canonicalAgentId(routeAgentId, user.organization_id);
    if (!agentId) return c.json({ error: "Agent not found." }, 404);
    return await googleMcpBroker.forward({
      organizationId: user.organization_id,
      agentId,
      bindingId,
      product,
      method: c.req.method,
      headers: c.req.raw.headers,
      body: await bodyBytes(c.req.raw),
      signal: AbortSignal.any([
        c.req.raw.signal,
        AbortSignal.timeout(MCP_TIMEOUT_MS),
      ]),
    });
  } catch (error) {
    if (error instanceof GoogleMcpBrokerError) {
      return c.json({ error: error.message, code: error.code }, error.status);
    }
    return failureResponse(c, error);
  }
}

app.post("/", handle);

export default app;
