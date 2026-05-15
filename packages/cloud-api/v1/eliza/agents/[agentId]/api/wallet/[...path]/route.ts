import { type Context, Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { nextStyleParams } from "@/lib/api/hono-next-style-params";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { createStewardClient } from "@/lib/services/steward-client";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "GET, POST, PUT, OPTIONS";
type WalletMethod = "GET" | "POST" | "PUT";
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type PolicyType =
  | "spending-limit"
  | "approved-addresses"
  | "auto-approve-threshold"
  | "time-window"
  | "rate-limit"
  | "allowed-chains"
  | "reputation-threshold"
  | "reputation-scaling";

function __next_OPTIONS() {
  return handleCorsOptions(CORS_METHODS);
}

type StewardPolicyRule = {
  id: string;
  type: PolicyType;
  enabled: boolean;
  config: JsonObject;
};

type StewardWalletClient = {
  getAddresses(agentId: string): Promise<{
    addresses: Array<{ chainFamily: "evm" | "solana"; address: string }>;
  }>;
  getAgent(agentId: string): Promise<{
    walletAddress?: string | null;
    walletAddresses?: {
      evm?: string | null;
      solana?: string | null;
    };
  }>;
  getBalance(agentId: string): Promise<{
    balances: {
      native: string;
      chainId: number;
      symbol: string;
    };
  }>;
  getPolicies(agentId: string): Promise<StewardPolicyRule[]>;
  setPolicies(agentId: string, policies: StewardPolicyRule[]): Promise<void>;
  getAgentDashboard(agentId: string): Promise<{
    recentTransactions: Array<{
      id: string;
      status: string;
      createdAt: Date | number | string;
      txHash?: string;
      request?: JsonObject;
    }>;
  }>;
  listApprovals(opts?: {
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<Array<{ agentId?: string } & JsonObject>>;
  approveTransaction(
    txId: string,
    opts?: { comment?: string; approvedBy?: string },
  ): Promise<JsonObject>;
  denyTransaction(txId: string, reason: string, deniedBy?: string): Promise<JsonObject>;
};

type StewardClient = StewardWalletClient;

const POLICY_TYPES: ReadonlySet<string> = new Set([
  "spending-limit",
  "approved-addresses",
  "auto-approve-threshold",
  "time-window",
  "rate-limit",
  "allowed-chains",
  "reputation-threshold",
  "reputation-scaling",
]);

const SUPPORTED_WALLET_PATHS = new Set([
  "addresses",
  "balances",
  "steward-status",
  "steward-policies",
  "steward-tx-records",
  "steward-pending-approvals",
  "steward-approve-tx",
  "steward-deny-tx",
]);

function json(data: unknown, init?: ResponseInit): Response {
  return applyCorsHeaders(Response.json(data, init), CORS_METHODS);
}

function chainName(chainId: number): string {
  switch (chainId) {
    case 1:
      return "Ethereum";
    case 56:
      return "BNB Smart Chain";
    case 8453:
      return "Base";
    case 84532:
      return "Base Sepolia";
    default:
      return `Chain ${chainId}`;
  }
}

function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  if (typeof value === "string") return value;
  return new Date().toISOString();
}

function boundedIntParam(
  params: URLSearchParams,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = Number(params.get(name) ?? fallback);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(Math.trunc(raw), min), max);
}

function isPolicyType(value: unknown): value is PolicyType {
  return typeof value === "string" && POLICY_TYPES.has(value as PolicyType);
}

function isJsonObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertStewardWalletClient(value: unknown): asserts value is StewardClient {
  if (!value || typeof value !== "object") {
    throw new Error("Steward client is unavailable");
  }
  const client = value as Record<string, unknown>;
  const requiredMethods = [
    "getAddresses",
    "getAgent",
    "getBalance",
    "getPolicies",
    "setPolicies",
    "getAgentDashboard",
    "listApprovals",
    "approveTransaction",
    "denyTransaction",
  ] as const;
  const missingMethod = requiredMethods.find((method) => typeof client[method] !== "function");
  if (missingMethod) {
    throw new Error(`Steward client is missing ${missingMethod}`);
  }
}

function normalizePolicy(value: JsonValue): StewardPolicyRule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const policy = value;
  if (
    typeof policy.id !== "string" ||
    !isPolicyType(policy.type) ||
    typeof policy.enabled !== "boolean"
  ) {
    return null;
  }
  const config = isJsonObject(policy.config) ? policy.config : {};
  return {
    id: policy.id,
    type: policy.type,
    enabled: policy.enabled,
    config,
  };
}

async function readJsonBody(c: Context<AppEnv>): Promise<JsonObject | null> {
  const contentType = c.req.header("content-type");
  if (!contentType?.includes("application/json")) {
    return null;
  }
  const text = await c.req.text();
  if (text.length > 1_048_576) {
    throw new Error("Request body too large");
  }
  if (!text.trim()) return {};
  const parsed = JSON.parse(text) as unknown;
  return isJsonObject(parsed) ? parsed : null;
}

async function getAgentAddresses(client: StewardClient, agentId: string) {
  try {
    const result = await client.getAddresses(agentId);
    return {
      evmAddress: result.addresses.find((a) => a.chainFamily === "evm")?.address ?? "",
      solanaAddress: result.addresses.find((a) => a.chainFamily === "solana")?.address ?? "",
    };
  } catch {
    const agent = await client.getAgent(agentId);
    return {
      evmAddress: agent.walletAddresses?.evm ?? agent.walletAddress ?? "",
      solanaAddress: agent.walletAddresses?.solana ?? "",
    };
  }
}

async function handleDirectWalletRequest(
  c: Context<AppEnv>,
  params: Promise<{ agentId: string; path: string[] }>,
  method: WalletMethod,
): Promise<Response> {
  const user = await requireUserOrApiKeyWithOrg(c);
  const { agentId, path } = await params;

  if (path.length !== 1 || path[0].includes("..")) {
    return json({ success: false, error: "Invalid wallet path" }, { status: 400 });
  }

  const walletPath = path[0];
  if (!SUPPORTED_WALLET_PATHS.has(walletPath)) {
    return json({ success: false, error: "Invalid wallet endpoint" }, { status: 400 });
  }

  const agent = await elizaSandboxService.getAgent(agentId, user.organization_id);
  if (!agent) {
    return json({ success: false, error: "Agent not found" }, { status: 404 });
  }

  let client: StewardClient;
  try {
    const stewardClient = await createStewardClient({ organizationId: user.organization_id });
    assertStewardWalletClient(stewardClient);
    client = stewardClient;
  } catch (error) {
    logger.warn("[wallet-api] Steward tenant config unavailable", {
      agentId,
      orgId: user.organization_id,
      error: error instanceof Error ? error.message : String(error),
    });
    return json({ error: "Steward not configured" }, { status: 503 });
  }

  logger.info("[wallet-api] Direct Steward request", {
    agentId,
    orgId: user.organization_id,
    walletPath,
    method,
  });

  if (method === "GET" && walletPath === "addresses") {
    return json(await getAgentAddresses(client, agentId));
  }

  if (method === "GET" && walletPath === "balances") {
    const balance = await client.getBalance(agentId);
    const { balances } = balance;
    return json({
      evm: [
        {
          chainId: balances.chainId,
          chainName: chainName(balances.chainId),
          nativeBalance: balances.native,
          nativeSymbol: balances.symbol,
          tokens: [],
        },
      ],
      solana: null,
    });
  }

  if (method === "GET" && walletPath === "steward-status") {
    try {
      await client.getAgent(agentId);
      return json({ configured: true, connected: true, agentId, version: "cloud-worker" });
    } catch {
      return json({ configured: true, connected: false, agentId, version: "cloud-worker" });
    }
  }

  if (method === "GET" && walletPath === "steward-policies") {
    return json(await client.getPolicies(agentId));
  }

  if (method === "PUT" && walletPath === "steward-policies") {
    const body = await readJsonBody(c);
    const policies = body?.policies;
    if (!Array.isArray(policies)) {
      return json({ error: "policies must be an array" }, { status: 400 });
    }
    const normalizedPolicies: StewardPolicyRule[] = [];
    for (const policy of policies) {
      const normalizedPolicy = normalizePolicy(policy);
      if (!normalizedPolicy) {
        return json({ error: "policies contains an invalid policy" }, { status: 400 });
      }
      normalizedPolicies.push(normalizedPolicy);
    }
    await client.setPolicies(agentId, normalizedPolicies);
    return json({ ok: true });
  }

  if (method === "GET" && walletPath === "steward-tx-records") {
    const url = new URL(c.req.url);
    const status = url.searchParams.get("status") || "";
    const limit = boundedIntParam(url.searchParams, "limit", 50, 1, 100);
    const offset = boundedIntParam(url.searchParams, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
    const dashboard = await client.getAgentDashboard(agentId);
    const records = (dashboard.recentTransactions ?? [])
      .filter((tx) => !status || tx.status === status)
      .map((tx) => ({
        id: tx.id,
        status: tx.status,
        createdAt: toIsoString(tx.createdAt),
        txHash: tx.txHash,
        request: tx.request,
      }));
    return json({
      records: records.slice(offset, offset + limit),
      total: records.length,
      offset,
      limit,
    });
  }

  if (method === "GET" && walletPath === "steward-pending-approvals") {
    const url = new URL(c.req.url);
    const limit = boundedIntParam(url.searchParams, "limit", 50, 1, 100);
    const offset = boundedIntParam(url.searchParams, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
    const approvals = (await client.listApprovals({ status: "pending", limit, offset })).filter(
      (entry) => entry.agentId === agentId,
    );
    return json({ approvals, total: approvals.length, offset, limit });
  }

  if (method === "POST" && walletPath === "steward-approve-tx") {
    const body = await readJsonBody(c);
    const txId = typeof body?.txId === "string" ? body.txId : "";
    if (!txId) return json({ error: "txId is required" }, { status: 400 });
    return json(await client.approveTransaction(txId, { approvedBy: user.id }));
  }

  if (method === "POST" && walletPath === "steward-deny-tx") {
    const body = await readJsonBody(c);
    const txId = typeof body?.txId === "string" ? body.txId : "";
    const reason = typeof body?.reason === "string" ? body.reason : "Denied from Eliza Cloud";
    if (!txId) return json({ error: "txId is required" }, { status: 400 });
    return json(await client.denyTransaction(txId, reason, user.id));
  }

  return json({ success: false, error: "Method not allowed" }, { status: 405 });
}

const ROUTE_PARAM_SPEC = [
  { name: "agentId", splat: false },
  { name: "path", splat: true },
] as const;
const honoRouter = new Hono<AppEnv>();
honoRouter.options("/", () => __next_OPTIONS());
honoRouter.get("/", async (c) => {
  try {
    return await handleDirectWalletRequest(c, nextStyleParams(c, ROUTE_PARAM_SPEC).params, "GET");
  } catch (error) {
    return failureResponse(c, error);
  }
});
honoRouter.post("/", async (c) => {
  try {
    return await handleDirectWalletRequest(c, nextStyleParams(c, ROUTE_PARAM_SPEC).params, "POST");
  } catch (error) {
    return failureResponse(c, error);
  }
});
honoRouter.put("/", async (c) => {
  try {
    return await handleDirectWalletRequest(c, nextStyleParams(c, ROUTE_PARAM_SPEC).params, "PUT");
  } catch (error) {
    return failureResponse(c, error);
  }
});
export default honoRouter;
