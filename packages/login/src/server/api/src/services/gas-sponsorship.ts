import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  getDb,
  sponsoredGasEvents,
  tenantConfigs as tenantConfigsTable,
} from "../../../db/src/index.ts";
import type {
  GasSponsorshipMode,
  GasSponsorshipProvider,
  SponsoredGasSpendEntry,
  SponsoredGasSpendSummary,
  TenantGasSponsorshipConfig,
} from "../../../shared/src/index.ts";
import { validateWebhookUrl } from "./webhook-url";

type SponsoredGasChainFamily = "evm" | "solana";

const PROVIDERS = new Set<GasSponsorshipProvider>([
  "custom_evm_paymaster",
  "custom_bundler",
  "solana_fee_payer",
  "mock",
]);
const MODES = new Set<GasSponsorshipMode>([
  "erc4337",
  "eip7702",
  "solana_fee_payer",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Cap amounts are cent-rounded (see normalizeUsdLimit); compare in integer cents to avoid float drift.
function usdToCents(value: number): number {
  return Math.round(value * 100);
}

function normalizeString(
  value: unknown,
  field: string,
  max = 256,
): string | undefined | string {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return `${field} must be a string`;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max)
    return `${field} must be 1-${max} characters`;
  return trimmed;
}

function normalizeHttpsUrl(
  value: unknown,
  field: string,
): string | undefined | string {
  const text = normalizeString(value, field, 2048);
  if (text === undefined || text.startsWith(`${field} must`)) return text;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return `${field} must be a valid URL`;
  }
  const localProviderUrlsAllowed =
    process.env.STEWARD_ALLOW_LOCAL_PROVIDER_URLS === "true" ||
    process.env.NODE_ENV === "test" ||
    process.env.NODE_ENV === "development";
  if (
    url.protocol !== "https:" &&
    url.hostname !== "localhost" &&
    url.hostname !== "127.0.0.1"
  ) {
    return `${field} must use https`;
  }
  if (url.protocol !== "https:" && !localProviderUrlsAllowed) {
    return `${field} must use https unless local provider URLs are explicitly enabled`;
  }
  if (url.username || url.password || url.hash) {
    return `${field} must not include credentials or fragments`;
  }
  // SEC-072: tenant-controlled paymaster/bundler URLs become live server-side
  // fetch sinks the moment a provider adapter is installed, so they must pass
  // the same string-level public-host guard as the webhook/OIDC/SAML surfaces
  // (private/loopback/link-local IPs, .local/.internal names). The explicit
  // localhost exception above (dev/test or STEWARD_ALLOW_LOCAL_PROVIDER_URLS)
  // is the only bypass.
  const isLocalException =
    localProviderUrlsAllowed &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (!isLocalException) {
    const ssrfError = validateWebhookUrl(url.toString());
    if (ssrfError) return `${field} must be a public https URL (${ssrfError})`;
  }
  return url.toString();
}

function normalizeNumberList(
  value: unknown,
  field: string,
  max = 100,
): number[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return `${field} must be an array`;
  if (value.length > max) return `${field} can include at most ${max} entries`;
  const numbers = new Set<number>();
  for (const item of value) {
    if (!Number.isSafeInteger(item) || item <= 0)
      return `${field} entries must be positive integers`;
    numbers.add(item);
  }
  return [...numbers];
}

function normalizeStringList(
  value: unknown,
  field: string,
  max = 100,
): string[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return `${field} must be an array`;
  if (value.length > max) return `${field} can include at most ${max} entries`;
  const strings = new Set<string>();
  for (const item of value) {
    const text = normalizeString(item, field, 128);
    if (text === undefined || text.startsWith(`${field} must`)) {
      return `${field} entries must be non-empty strings`;
    }
    strings.add(text);
  }
  return [...strings];
}

function normalizeUsdLimit(
  value: unknown,
  field: string,
): number | undefined | string {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return `${field} must be a non-negative number`;
  }
  if (value > 10_000_000) return `${field} is too large`;
  return Math.round(value * 100) / 100;
}

export function normalizeGasSponsorshipConfig(
  value: unknown,
): TenantGasSponsorshipConfig | string {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) return "gasSponsorshipConfig must be an object";

  const provider = value.provider;
  if (
    provider !== undefined &&
    !PROVIDERS.has(provider as GasSponsorshipProvider)
  ) {
    return "gasSponsorshipConfig.provider is unsupported";
  }
  const mode = value.mode;
  if (mode !== undefined && !MODES.has(mode as GasSponsorshipMode)) {
    return "gasSponsorshipConfig.mode is unsupported";
  }
  const allowedChainIds = normalizeNumberList(
    value.allowedChainIds,
    "allowedChainIds",
  );
  if (typeof allowedChainIds === "string") return allowedChainIds;
  const allowedCaip2 = normalizeStringList(value.allowedCaip2, "allowedCaip2");
  if (typeof allowedCaip2 === "string") return allowedCaip2;
  const paymasterUrl = normalizeHttpsUrl(value.paymasterUrl, "paymasterUrl");
  if (
    typeof paymasterUrl === "string" &&
    paymasterUrl.startsWith("paymasterUrl must")
  ) {
    return paymasterUrl;
  }
  const bundlerUrl = normalizeHttpsUrl(value.bundlerUrl, "bundlerUrl");
  if (
    typeof bundlerUrl === "string" &&
    bundlerUrl.startsWith("bundlerUrl must")
  )
    return bundlerUrl;
  const entryPoint = normalizeString(value.entryPoint, "entryPoint", 128);
  if (
    typeof entryPoint === "string" &&
    entryPoint.startsWith("entryPoint must")
  )
    return entryPoint;
  const feePayerAgentId = normalizeString(
    value.feePayerAgentId,
    "feePayerAgentId",
    128,
  );
  if (
    typeof feePayerAgentId === "string" &&
    feePayerAgentId.startsWith("feePayerAgentId must")
  ) {
    return feePayerAgentId;
  }

  const maxPerTxUsd = normalizeUsdLimit(value.maxPerTxUsd, "maxPerTxUsd");
  if (typeof maxPerTxUsd === "string") return maxPerTxUsd;
  const maxPerWalletDayUsd = normalizeUsdLimit(
    value.maxPerWalletDayUsd,
    "maxPerWalletDayUsd",
  );
  if (typeof maxPerWalletDayUsd === "string") return maxPerWalletDayUsd;
  const maxTenantDayUsd = normalizeUsdLimit(
    value.maxTenantDayUsd,
    "maxTenantDayUsd",
  );
  if (typeof maxTenantDayUsd === "string") return maxTenantDayUsd;
  const maxTenantMonthUsd = normalizeUsdLimit(
    value.maxTenantMonthUsd,
    "maxTenantMonthUsd",
  );
  if (typeof maxTenantMonthUsd === "string") return maxTenantMonthUsd;

  return {
    enabled: value.enabled === true,
    provider: provider as GasSponsorshipProvider | undefined,
    mode: mode as GasSponsorshipMode | undefined,
    allowedChainIds,
    allowedCaip2,
    paymasterUrl,
    bundlerUrl,
    entryPoint,
    feePayerAgentId,
    maxPerTxUsd,
    maxPerWalletDayUsd,
    maxTenantDayUsd,
    maxTenantMonthUsd,
    allowClientSponsorship: value.allowClientSponsorship === true,
    requireSimulation: value.requireSimulation !== false,
    circuitBreakerEnabled: value.circuitBreakerEnabled === true,
  };
}

export async function readTenantGasSponsorshipConfig(
  tenantId: string,
): Promise<TenantGasSponsorshipConfig> {
  const [row] = await getDb()
    .select({ gasSponsorshipConfig: tenantConfigsTable.gasSponsorshipConfig })
    .from(tenantConfigsTable)
    .where(eq(tenantConfigsTable.tenantId, tenantId));
  return (
    (row?.gasSponsorshipConfig as TenantGasSponsorshipConfig | undefined) ?? {}
  );
}

export function publicGasSponsorshipState(config: TenantGasSponsorshipConfig): {
  enabled: boolean;
  provider: GasSponsorshipProvider | null;
  mode?: GasSponsorshipMode;
  circuitBreakerEnabled?: boolean;
} {
  const enabled =
    config.enabled === true && config.circuitBreakerEnabled !== true;
  return {
    enabled,
    provider: enabled ? (config.provider ?? null) : null,
    mode: enabled ? config.mode : undefined,
    circuitBreakerEnabled: config.circuitBreakerEnabled === true,
  };
}

export async function resolveGasSponsorshipRequest(input: {
  tenantId: string;
  agentId?: string;
  chainId: number;
  caip2?: string;
  sponsor?: boolean;
}): Promise<
  | {
      requested: false;
      sponsored: false;
    }
  | {
      requested: true;
      sponsored: true;
      provider: GasSponsorshipProvider;
      mode: GasSponsorshipMode;
      estimatedUsd: number | null;
    }
  | { requested: true; sponsored: false; error: string; status: number }
> {
  if (input.sponsor !== true) return { requested: false, sponsored: false };

  const config = await readTenantGasSponsorshipConfig(input.tenantId);
  if (config.enabled !== true || config.circuitBreakerEnabled === true) {
    return {
      requested: true,
      sponsored: false,
      error: "Gas sponsorship is disabled",
      status: 403,
    };
  }
  if (!config.provider || !config.mode) {
    return {
      requested: true,
      sponsored: false,
      error: "Gas sponsorship provider is not configured",
      status: 503,
    };
  }
  if (config.allowClientSponsorship !== true) {
    return {
      requested: true,
      sponsored: false,
      error: "Client-requested gas sponsorship is disabled",
      status: 403,
    };
  }
  if (
    config.allowedChainIds?.length &&
    !config.allowedChainIds.includes(input.chainId)
  ) {
    return {
      requested: true,
      sponsored: false,
      error: "Gas sponsorship is not enabled for this chain",
      status: 403,
    };
  }
  if (
    config.allowedCaip2?.length &&
    (!input.caip2 || !config.allowedCaip2.includes(input.caip2))
  ) {
    return {
      requested: true,
      sponsored: false,
      error: "Gas sponsorship is not enabled for this chain",
      status: 403,
    };
  }
  if (config.maxPerTxUsd === undefined) {
    return {
      requested: true,
      sponsored: false,
      error: "Gas sponsorship maxPerTxUsd is not configured",
      status: 503,
    };
  }
  if (config.provider !== "mock") {
    return {
      requested: true,
      sponsored: false,
      error: "Configured gas sponsorship provider adapter is not installed",
      status: 501,
    };
  }
  const estimatedUsd = config.maxPerTxUsd;
  const capError = await getSponsorshipCapError({
    tenantId: input.tenantId,
    agentId: input.agentId,
    estimatedUsd,
    config,
  });
  if (capError) {
    return {
      requested: true,
      sponsored: false,
      error: capError,
      status: 403,
    };
  }

  return {
    requested: true,
    sponsored: true,
    provider: config.provider,
    mode: config.mode,
    estimatedUsd,
  };
}

async function sumSponsoredGasUsd(input: {
  tenantId: string;
  agentId?: string;
  since: Date;
  db?: Pick<ReturnType<typeof getDb>, "select">;
}): Promise<number> {
  const conditions = [
    eq(sponsoredGasEvents.tenantId, input.tenantId),
    gte(sponsoredGasEvents.createdAt, input.since),
  ];
  if (input.agentId)
    conditions.push(eq(sponsoredGasEvents.agentId, input.agentId));
  const [row] = await (input.db ?? getDb())
    .select({
      totalUsd: sql<string>`coalesce(sum(coalesce(${sponsoredGasEvents.actualUsd}, ${sponsoredGasEvents.reservedUsd}, 0)), 0)::text`,
    })
    .from(sponsoredGasEvents)
    .where(and(...conditions));
  return Number(row?.totalUsd ?? 0);
}

async function getSponsorshipCapError(input: {
  tenantId: string;
  agentId?: string;
  estimatedUsd: number;
  config: TenantGasSponsorshipConfig;
  db?: Pick<ReturnType<typeof getDb>, "select">;
}): Promise<string | null> {
  const now = Date.now();
  const dayStart = new Date(now - 24 * 60 * 60 * 1000);
  const monthStart = new Date(now - 30 * 24 * 60 * 60 * 1000);
  // Compare in integer cents (amounts are cent-rounded) to avoid float drift; use strict
  // `>` so spend exactly at the cap is allowed, matching the platform's spend-cap semantics
  // (policy-engine trade-order/evaluators) shared with the atomic reserve path.
  const estimatedCents = usdToCents(input.estimatedUsd);
  if (input.config.maxPerWalletDayUsd !== undefined) {
    // Fail closed: the per-wallet cap cannot be enforced without an agent identifier.
    if (!input.agentId) {
      return "Gas sponsorship wallet daily cap requires an agent identifier";
    }
    const walletDaySpend = await sumSponsoredGasUsd({
      tenantId: input.tenantId,
      agentId: input.agentId,
      since: dayStart,
      db: input.db,
    });
    if (
      usdToCents(walletDaySpend) + estimatedCents >
      usdToCents(input.config.maxPerWalletDayUsd)
    ) {
      return "Gas sponsorship wallet daily cap exceeded";
    }
  }
  if (input.config.maxTenantDayUsd !== undefined) {
    const tenantDaySpend = await sumSponsoredGasUsd({
      tenantId: input.tenantId,
      since: dayStart,
      db: input.db,
    });
    if (
      usdToCents(tenantDaySpend) + estimatedCents >
      usdToCents(input.config.maxTenantDayUsd)
    ) {
      return "Gas sponsorship tenant daily cap exceeded";
    }
  }
  if (input.config.maxTenantMonthUsd !== undefined) {
    const tenantMonthSpend = await sumSponsoredGasUsd({
      tenantId: input.tenantId,
      since: monthStart,
      db: input.db,
    });
    if (
      usdToCents(tenantMonthSpend) + estimatedCents >
      usdToCents(input.config.maxTenantMonthUsd)
    ) {
      return "Gas sponsorship tenant monthly cap exceeded";
    }
  }
  return null;
}

export async function recordSponsoredGasEvent(input: {
  tenantId: string;
  agentId: string;
  userId?: string | null;
  txId?: string | null;
  chainFamily?: SponsoredGasChainFamily;
  chainId?: number | null;
  caip2?: string | null;
  provider: GasSponsorshipProvider | string;
  mode: GasSponsorshipMode | string;
  status?: string;
  reservedUsd?: number | string | null;
  actualUsd?: number | string | null;
  txHash?: string | null;
  userOperationHash?: string | null;
  signature?: string | null;
  requestHash?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await getDb()
    .insert(sponsoredGasEvents)
    .values({
      tenantId: input.tenantId,
      agentId: input.agentId,
      userId: input.userId ?? null,
      txId: input.txId ?? null,
      chainFamily: input.chainFamily ?? "evm",
      chainId: input.chainId ?? null,
      caip2: input.caip2 ?? null,
      provider: input.provider,
      mode: input.mode,
      status: input.status ?? "reserved",
      reservedUsd:
        input.reservedUsd === undefined ? null : String(input.reservedUsd),
      actualUsd: input.actualUsd === undefined ? null : String(input.actualUsd),
      txHash: input.txHash ?? null,
      userOperationHash: input.userOperationHash ?? null,
      signature: input.signature ?? null,
      requestHash: input.requestHash ?? null,
      metadata: input.metadata ?? {},
    })
    .onConflictDoUpdate({
      target: [sponsoredGasEvents.tenantId, sponsoredGasEvents.txId],
      targetWhere: sql`${sponsoredGasEvents.txId} is not null`,
      set: {
        status: input.status ?? "reserved",
        reservedUsd:
          input.reservedUsd === undefined ? null : String(input.reservedUsd),
        actualUsd:
          input.actualUsd === undefined ? null : String(input.actualUsd),
        txHash: input.txHash ?? null,
        userOperationHash: input.userOperationHash ?? null,
        signature: input.signature ?? null,
        requestHash: input.requestHash ?? null,
        metadata: input.metadata ?? {},
        updatedAt: new Date(),
      },
    });
}

export async function reserveSponsoredGasEvent(input: {
  tenantId: string;
  agentId: string;
  txId: string;
  chainFamily?: SponsoredGasChainFamily;
  chainId?: number | null;
  caip2?: string | null;
  provider: GasSponsorshipProvider | string;
  mode: GasSponsorshipMode | string;
  reservedUsd: number;
  metadata?: Record<string, unknown>;
}): Promise<void | string> {
  return getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`sponsored_gas:${input.tenantId}`}, 0))`,
    );
    const [configRow] = await tx
      .select({ gasSponsorshipConfig: tenantConfigsTable.gasSponsorshipConfig })
      .from(tenantConfigsTable)
      .where(eq(tenantConfigsTable.tenantId, input.tenantId));
    const config =
      (configRow?.gasSponsorshipConfig as
        | TenantGasSponsorshipConfig
        | undefined) ?? {};
    const capError = await getSponsorshipCapError({
      tenantId: input.tenantId,
      agentId: input.agentId,
      estimatedUsd: input.reservedUsd,
      config,
      db: tx,
    });
    if (capError) return capError;

    await tx
      .insert(sponsoredGasEvents)
      .values({
        tenantId: input.tenantId,
        agentId: input.agentId,
        txId: input.txId,
        chainFamily: input.chainFamily ?? "evm",
        chainId: input.chainId ?? null,
        caip2: input.caip2 ?? null,
        provider: input.provider,
        mode: input.mode,
        status: "reserved",
        reservedUsd: String(input.reservedUsd),
        actualUsd: null,
        metadata: input.metadata ?? {},
      })
      .onConflictDoUpdate({
        target: [sponsoredGasEvents.tenantId, sponsoredGasEvents.txId],
        targetWhere: sql`${sponsoredGasEvents.txId} is not null`,
        set: {
          status: "reserved",
          reservedUsd: String(input.reservedUsd),
          actualUsd: null,
          txHash: null,
          userOperationHash: null,
          signature: null,
          metadata: input.metadata ?? {},
          updatedAt: new Date(),
        },
      });
  });
}

export function normalizeGasSpendQuery(input: {
  walletIds?: string[];
  startTimestamp?: number;
  endTimestamp?: number;
}): { walletIds: string[]; start: Date; end: Date } | string {
  const walletIds = [
    ...new Set((input.walletIds ?? []).map((id) => id.trim()).filter(Boolean)),
  ];
  if (walletIds.length === 0) return "wallet_ids is required";
  if (walletIds.length > 100)
    return "wallet_ids can include at most 100 wallet ids";
  if (!walletIds.every((id) => /^[a-zA-Z0-9_.:-]{1,128}$/.test(id))) {
    return "wallet_ids contains an invalid wallet id";
  }
  const now = Date.now();
  const endMs = input.endTimestamp ?? now;
  const startMs = input.startTimestamp ?? endMs - 30 * 86400_000;
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    startMs <= 0 ||
    endMs <= 0
  ) {
    return "start_timestamp and end_timestamp must be Unix timestamps";
  }
  const normalizedStartMs =
    startMs < 1_000_000_000_000 ? startMs * 1000 : startMs;
  const normalizedEndMs = endMs < 1_000_000_000_000 ? endMs * 1000 : endMs;
  if (normalizedStartMs > normalizedEndMs)
    return "start_timestamp must be before end_timestamp";
  if (normalizedEndMs - normalizedStartMs > 30 * 86400_000) {
    return "gas spend queries cannot exceed 30 days";
  }
  return {
    walletIds,
    start: new Date(normalizedStartMs),
    end: new Date(normalizedEndMs),
  };
}

function toSpendEntry(
  row: typeof sponsoredGasEvents.$inferSelect,
): SponsoredGasSpendEntry {
  return {
    id: row.id,
    tenantId: row.tenantId,
    agentId: row.agentId,
    userId: row.userId,
    txId: row.txId,
    chainFamily: row.chainFamily,
    chainId: row.chainId,
    caip2: row.caip2,
    provider: row.provider,
    mode: row.mode,
    status: row.status,
    reservedUsd: row.reservedUsd,
    actualUsd: row.actualUsd,
    txHash: row.txHash,
    userOperationHash: row.userOperationHash,
    signature: row.signature,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function querySponsoredGasSpend(input: {
  tenantId: string;
  walletIds: string[];
  start: Date;
  end: Date;
}): Promise<SponsoredGasSpendSummary> {
  const db = getDb();
  const filters = and(
    eq(sponsoredGasEvents.tenantId, input.tenantId),
    inArray(sponsoredGasEvents.agentId, input.walletIds),
    gte(sponsoredGasEvents.createdAt, input.start),
    lte(sponsoredGasEvents.createdAt, input.end),
  );
  const [summary] = await db
    .select({
      reservedUsd: sql<string>`coalesce(sum(${sponsoredGasEvents.reservedUsd}), 0)::text`,
      actualUsd: sql<string>`coalesce(sum(${sponsoredGasEvents.actualUsd}), 0)::text`,
      count: sql<number>`count(*)::int`,
    })
    .from(sponsoredGasEvents)
    .where(filters);
  const entries = await db
    .select()
    .from(sponsoredGasEvents)
    .where(filters)
    .orderBy(desc(sponsoredGasEvents.createdAt))
    .limit(500);

  return {
    currency: "USD",
    reservedUsd: summary?.reservedUsd ?? "0",
    actualUsd: summary?.actualUsd ?? "0",
    count: summary?.count ?? 0,
    entries: entries.map(toSpendEntry),
  };
}
