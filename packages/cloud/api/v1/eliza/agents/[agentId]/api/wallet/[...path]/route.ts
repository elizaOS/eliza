/** Proxies an authenticated Cloud agent's supported wallet operations to its mapped Steward wallet. */
import { ElizaError } from "@elizaos/core";
import type {
  WalletBalancesResponse,
  WalletConfigStatus,
  WalletEntry,
} from "@elizaos/shared";
import { and, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { dbWrite } from "@/db/helpers";
import { agentServerWallets } from "@/db/schemas/agent-server-wallets";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { nextStyleParams } from "@/lib/api/hono-next-style-params";
import {
  readSessionCredential,
  requireUserOrApiKeyWithOrg,
} from "@/lib/auth/workers-hono-auth";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { createStewardClient } from "@/lib/services/steward-client";
import { parseClampedLimit, parseClampedOffset } from "@/lib/utils/clamp-limit";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { proxyLocalDedicatedOrNext } from "../../_local-dedicated-proxy";

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
    walletAddress?: string;
    balances: {
      native: string;
      nativeFormatted?: string;
      chainId: number;
      symbol: string;
    };
  }>;
  getPolicies(agentId: string): Promise<StewardPolicyRule[]>;
  setPolicies(agentId: string, policies: StewardPolicyRule[]): Promise<void>;
  getAgentDashboard(agentId: string): Promise<{
    pendingApprovals: number;
    recentTransactions: Array<{
      id: string;
      status: string;
      createdAt: Date | number | string;
      txHash?: string;
      request?: JsonObject;
    }>;
  }>;
  listPendingApprovals(
    agentId: string,
    opts?: {
      limit?: number;
      offset?: number;
    },
  ): Promise<unknown[]>;
  approveTransaction(
    txId: string,
    opts?: { comment?: string; approvedBy?: string },
  ): Promise<JsonObject>;
  denyTransaction(
    txId: string,
    reason: string,
    deniedBy?: string,
  ): Promise<JsonObject>;
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
  "config",
  "nfts",
  "market-overview",
  "trading-profile",
  "steward-status",
  "steward-policies",
  "steward-tx-records",
  "steward-pending-approvals",
  "steward-approve-tx",
  "steward-deny-tx",
]);

const OPTIONAL_WALLET_CAPABILITIES = {
  nfts: {
    code: "wallet_nfts_unavailable",
    message: "NFT inventory is not available for this managed wallet",
  },
  "market-overview": {
    code: "wallet_market_overview_unavailable",
    message: "Market overview is not available from the managed wallet proxy",
  },
  "trading-profile": {
    code: "wallet_trading_profile_unavailable",
    message: "Trading history is not available from the managed wallet proxy",
  },
} as const;

type OptionalWalletCapability = keyof typeof OPTIONAL_WALLET_CAPABILITIES;

function isOptionalWalletCapability(
  path: string,
): path is OptionalWalletCapability {
  return path in OPTIONAL_WALLET_CAPABILITIES;
}

export async function resolveStewardAgentId(
  sandboxAgentId: string,
  organizationId: string,
): Promise<string | null> {
  try {
    const row = await dbWrite
      .select({ stewardAgentId: agentServerWallets.steward_agent_id })
      .from(agentServerWallets)
      .where(
        and(
          eq(agentServerWallets.sandbox_agent_id, sandboxAgentId),
          eq(agentServerWallets.organization_id, organizationId),
        ),
      )
      .limit(1);
    return row[0]?.stewardAgentId ?? null;
  } catch (error) {
    logger.info(
      "[wallet-api] Failed to resolve steward_agent_id by sandbox_agent_id; trying organization wallet fallback",
      { sandboxAgentId, orgId: organizationId, error },
    );
  }

  const orgWalletRows = await dbWrite
    .select({ stewardAgentId: agentServerWallets.steward_agent_id })
    .from(agentServerWallets)
    .where(eq(agentServerWallets.organization_id, organizationId))
    .limit(2);

  const stewardAgentIds = orgWalletRows
    .map((row) => row.stewardAgentId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const uniqueStewardAgentIds = [...new Set(stewardAgentIds)];
  if (uniqueStewardAgentIds.length === 1) {
    logger.info(
      "[wallet-api] Using the only Steward-managed wallet in the organization as sandbox mapping fallback",
      {
        sandboxAgentId,
        orgId: organizationId,
        stewardAgentId: uniqueStewardAgentIds[0],
      },
    );
    return uniqueStewardAgentIds[0];
  }

  if (uniqueStewardAgentIds.length > 1) {
    logger.info(
      "[wallet-api] Multiple Steward-managed wallets exist in the organization; refusing ambiguous sandbox mapping fallback",
      { sandboxAgentId, orgId: organizationId },
    );
  }

  return null;
}

async function resolveStewardAgentIdForProxy(
  client: StewardClient,
  sandboxAgentId: string,
  organizationId: string,
): Promise<string | null> {
  const stewardAgentId = await resolveStewardAgentId(
    sandboxAgentId,
    organizationId,
  );
  if (stewardAgentId) return stewardAgentId;

  try {
    await client.getAgent(sandboxAgentId);
    logger.info(
      "[wallet-api] No agent_server_wallets steward_agent_id mapping found; falling back to sandbox agent id",
      { sandboxAgentId, orgId: organizationId },
    );
    return sandboxAgentId;
  } catch {
    return null;
  }
}

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

function isPolicyType(value: unknown): value is PolicyType {
  return typeof value === "string" && POLICY_TYPES.has(value as PolicyType);
}

function isJsonObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertPendingApprovalTotal(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ElizaError("Steward returned an invalid pending approval total", {
      code: "INVALID_STEWARD_PENDING_APPROVAL_TOTAL",
      context: { value },
      severity: "fatal",
    });
  }
}

function assertStewardWalletClient(
  value: unknown,
): asserts value is StewardClient {
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
    "listPendingApprovals",
    "approveTransaction",
    "denyTransaction",
  ] as const;
  const missingMethod = requiredMethods.find(
    (method) => typeof client[method] !== "function",
  );
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

const INVALID_JSON_BODY = Symbol("invalid-json-body");

async function readJsonBody(
  c: Context<AppEnv>,
): Promise<JsonObject | null | typeof INVALID_JSON_BODY> {
  const contentType = c.req.header("content-type");
  if (!contentType?.includes("application/json")) {
    return null;
  }
  const text = await c.req.text();
  if (text.length > 1_048_576) {
    throw new Error("Request body too large");
  }
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    // error-policy:J3 malformed JSON is an explicit invalid request.
    return INVALID_JSON_BODY;
  }
  return isJsonObject(parsed) ? parsed : null;
}

async function getAgentAddresses(
  client: StewardClient,
  stewardAgentId: string,
) {
  try {
    const result = await client.getAddresses(stewardAgentId);
    return {
      evmAddress:
        result.addresses.find((a) => a.chainFamily === "evm")?.address ?? "",
      solanaAddress:
        result.addresses.find((a) => a.chainFamily === "solana")?.address ?? "",
    };
  } catch {
    const agent = await client.getAgent(stewardAgentId);
    return {
      evmAddress: agent.walletAddresses?.evm ?? agent.walletAddress ?? "",
      solanaAddress: agent.walletAddresses?.solana ?? "",
    };
  }
}

export async function handleDirectWalletRequest(
  c: Context<AppEnv>,
  params: Promise<{ agentId: string; path: string[] }>,
  method: WalletMethod,
): Promise<Response> {
  const user = await requireUserOrApiKeyWithOrg(c);
  const { agentId, path } = await params;

  if (path.length !== 1 || path[0].includes("..")) {
    return json(
      { success: false, error: "Invalid wallet path" },
      { status: 400 },
    );
  }

  const walletPath = path[0];
  if (!SUPPORTED_WALLET_PATHS.has(walletPath)) {
    return json(
      { success: false, error: "Invalid wallet endpoint" },
      { status: 400 },
    );
  }

  const agent = await elizaSandboxService.getAgent(
    agentId,
    user.organization_id,
  );
  if (!agent) {
    return json({ success: false, error: "Agent not found" }, { status: 404 });
  }

  if (method === "GET" && isOptionalWalletCapability(walletPath)) {
    const capability = OPTIONAL_WALLET_CAPABILITIES[walletPath];
    return json(
      {
        success: false,
        error: capability.message,
        code: capability.code,
        capability: walletPath,
      },
      { status: 501 },
    );
  }

  let client: StewardClient;
  try {
    const bearerToken = readSessionCredential(c);
    const stewardClient = await createStewardClient({
      organizationId: user.organization_id,
      ...(bearerToken ? { bearerToken } : {}),
    });
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

  const stewardAgentId = await resolveStewardAgentIdForProxy(
    client,
    agentId,
    user.organization_id,
  );
  if (!stewardAgentId) {
    return json(
      { error: "No Steward-managed wallet found for this agent" },
      { status: 404 },
    );
  }

  logger.info("[wallet-api] Direct Steward request", {
    agentId,
    stewardAgentId,
    orgId: user.organization_id,
    walletPath,
    method,
  });

  if (method === "GET" && walletPath === "addresses") {
    return json(await getAgentAddresses(client, stewardAgentId));
  }

  if (method === "GET" && walletPath === "config") {
    const addresses = await getAgentAddresses(client, stewardAgentId);
    const evmAddress = addresses.evmAddress || null;
    const solanaAddress = addresses.solanaAddress || null;
    const wallets: WalletEntry[] = [
      ...(evmAddress
        ? [
            {
              source: "cloud" as const,
              chain: "evm" as const,
              address: evmAddress,
              provider: "steward" as const,
              primary: true,
            },
          ]
        : []),
      ...(solanaAddress
        ? [
            {
              source: "cloud" as const,
              chain: "solana" as const,
              address: solanaAddress,
              provider: "steward" as const,
              primary: true,
            },
          ]
        : []),
    ];
    const config: WalletConfigStatus = {
      evmAddress,
      solanaAddress,
      selectedRpcProviders: {
        evm: "eliza-cloud",
        bsc: "eliza-cloud",
        solana: "eliza-cloud",
      },
      legacyCustomChains: [],
      alchemyKeySet: false,
      infuraKeySet: false,
      ankrKeySet: false,
      heliusKeySet: false,
      birdeyeKeySet: false,
      evmChains: [],
      cloudManagedAccess: wallets.length > 0,
      evmBalanceReady: Boolean(evmAddress),
      // This proxy currently exposes Steward's active EVM balance only. The
      // Solana address remains usable for signing, but claiming balance
      // readiness here would cause the UI to render a fabricated empty feed.
      solanaBalanceReady: false,
      walletSource: wallets.length > 0 ? "managed" : "none",
      executionReady: wallets.length > 0,
      evmSigningCapability: evmAddress ? "steward-cloud" : "none",
      solanaSigningAvailable: Boolean(solanaAddress),
      wallets,
      ...(evmAddress && solanaAddress
        ? { primary: { evm: "cloud" as const, solana: "cloud" as const } }
        : {}),
    };
    return json(config);
  }

  if (method === "GET" && walletPath === "balances") {
    const balance = await client.getBalance(stewardAgentId);
    const { balances } = balance;
    const addresses = await getAgentAddresses(client, stewardAgentId);
    const evmAddress =
      addresses.evmAddress || balance.walletAddress?.trim() || null;
    const nativeBalance = balances.nativeFormatted ?? balances.native;
    const parsedNativeBalance = Number.parseFloat(nativeBalance);
    const valuationKnownZero =
      Number.isFinite(parsedNativeBalance) && parsedNativeBalance === 0;
    const response: WalletBalancesResponse = {
      evm: evmAddress
        ? {
            address: evmAddress,
            chains: [
              {
                chain: chainName(balances.chainId),
                chainId: balances.chainId,
                nativeBalance,
                nativeSymbol: balances.symbol,
                // Steward's native-balance contract has no fiat quote. Zero
                // units are truthfully worth zero; for a non-zero balance the
                // required legacy field carries its sentinel alongside an
                // explicit chain error so consumers render valuation as
                // unavailable rather than presenting a fake $0 portfolio.
                nativeValueUsd: "0",
                tokens: [],
                error: valuationKnownZero
                  ? null
                  : "USD valuation is unavailable for this managed wallet",
              },
            ],
          }
        : null,
      solana: null,
    };
    return json(response);
  }

  if (method === "GET" && walletPath === "steward-status") {
    try {
      await client.getAgent(stewardAgentId);
      return json({
        configured: true,
        connected: true,
        agentId,
        stewardAgentId,
        version: "cloud-worker",
      });
    } catch {
      return json({
        configured: true,
        connected: false,
        agentId,
        stewardAgentId,
        version: "cloud-worker",
      });
    }
  }

  if (method === "GET" && walletPath === "steward-policies") {
    return json(await client.getPolicies(stewardAgentId));
  }

  if (method === "PUT" && walletPath === "steward-policies") {
    const body = await readJsonBody(c);
    if (body === INVALID_JSON_BODY) {
      return json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const policies = body?.policies;
    if (!Array.isArray(policies)) {
      return json({ error: "policies must be an array" }, { status: 400 });
    }
    const normalizedPolicies: StewardPolicyRule[] = [];
    for (const policy of policies) {
      const normalizedPolicy = normalizePolicy(policy);
      if (!normalizedPolicy) {
        return json(
          { error: "policies contains an invalid policy" },
          { status: 400 },
        );
      }
      normalizedPolicies.push(normalizedPolicy);
    }
    await client.setPolicies(stewardAgentId, normalizedPolicies);
    return json({ ok: true });
  }

  if (method === "GET" && walletPath === "steward-tx-records") {
    const url = new URL(c.req.url);
    const status = url.searchParams.get("status") || "";
    const limit = parseClampedLimit(url.searchParams.get("limit"), 50, 100);
    const offset = parseClampedOffset(url.searchParams.get("offset"), 0);
    const dashboard = await client.getAgentDashboard(stewardAgentId);
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
    const limit = parseClampedLimit(url.searchParams.get("limit"), 50, 100);
    const offset = parseClampedOffset(url.searchParams.get("offset"), 0);
    const [approvals, dashboard] = await Promise.all([
      client.listPendingApprovals(stewardAgentId, { limit, offset }),
      client.getAgentDashboard(stewardAgentId),
    ]);
    assertPendingApprovalTotal(dashboard.pendingApprovals);
    return json({
      approvals,
      total: dashboard.pendingApprovals,
      offset,
      limit,
    });
  }

  if (method === "POST" && walletPath === "steward-approve-tx") {
    const body = await readJsonBody(c);
    if (body === INVALID_JSON_BODY) {
      return json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const txId = typeof body?.txId === "string" ? body.txId : "";
    if (!txId) return json({ error: "txId is required" }, { status: 400 });
    return json(await client.approveTransaction(txId, { approvedBy: user.id }));
  }

  if (method === "POST" && walletPath === "steward-deny-tx") {
    const body = await readJsonBody(c);
    if (body === INVALID_JSON_BODY) {
      return json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const txId = typeof body?.txId === "string" ? body.txId : "";
    const reason =
      typeof body?.reason === "string"
        ? body.reason
        : "Denied from Eliza Cloud";
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
honoRouter.use("*", proxyLocalDedicatedOrNext);
honoRouter.options("/", () => __next_OPTIONS());
honoRouter.get("/", async (c) => {
  try {
    return await handleDirectWalletRequest(
      c,
      nextStyleParams(c, ROUTE_PARAM_SPEC).params,
      "GET",
    );
  } catch (error) {
    return failureResponse(c, error);
  }
});
honoRouter.post("/", async (c) => {
  try {
    return await handleDirectWalletRequest(
      c,
      nextStyleParams(c, ROUTE_PARAM_SPEC).params,
      "POST",
    );
  } catch (error) {
    return failureResponse(c, error);
  }
});
honoRouter.put("/", async (c) => {
  try {
    return await handleDirectWalletRequest(
      c,
      nextStyleParams(c, ROUTE_PARAM_SPEC).params,
      "PUT",
    );
  } catch (error) {
    return failureResponse(c, error);
  }
});
export default honoRouter;
