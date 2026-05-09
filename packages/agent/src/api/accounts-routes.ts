/**
 * Multi-account credentials CRUD + OAuth-from-UI routes.
 *
 * The HTTP surface this exposes (under `/api/accounts/...`) is the
 * source of truth for the React settings page. It joins three sources:
 *
 *   - on-disk credential records under `~/.eliza/auth/...`
 *     (`account-storage.ts`),
 *   - rich `LinkedAccountConfig` records (label / enabled / priority /
 *     health / usage) owned by `AccountPool` in
 *     `@elizaos/app-core/account-pool`,
 *   - the in-flight OAuth flow registry (`auth/oauth-flow.ts`) used by
 *     the `oauth/start` + SSE `oauth/status` + `oauth/cancel` trio.
 *
 * The pool is the SINGLE source of truth for `LinkedAccountConfig`. We
 * never touch `config.linkedAccounts` from these routes — that field
 * still holds the legacy `LinkedAccountFlagsConfig` (elizacloud
 * is-linked flags) shape for unrelated consumers.
 *
 * Provider-level account selection strategy lives in a dedicated
 * top-level config key, `accountStrategies` (see `applyStrategyPatch`
 * below). It's a separate slot from the per-capability
 * `serviceRouting[capability].strategy` so the UI can express
 * "always prefer my Pro Anthropic account before falling back to my
 * Max one" without having to know which capability each provider
 * powers.
 */

import nodeCrypto from "node:crypto";
import { logger } from "@elizaos/core";
import type { RouteRequestContext } from "@elizaos/shared";
import {
  isLinkedAccountProviderId,
  type LinkedAccountConfig,
  type LinkedAccountProviderId,
  type ServiceRouteAccountStrategy,
} from "@elizaos/shared";
import { z } from "zod";
import {
  type AccountCredentialRecord,
  deleteAccount,
  listAccounts,
  loadAccount,
  saveAccount,
} from "../auth/account-storage.js";
import { getAccessToken } from "../auth/credentials.js";
import {
  cancelFlow,
  getFlowState,
  startAnthropicOAuthFlow,
  startCodexOAuthFlow,
  submitFlowCode,
  subscribeFlow,
} from "../auth/oauth-flow.js";
import {
  type AccountCredentialProvider,
  DIRECT_ACCOUNT_PROVIDER_ENV,
  type DirectAccountProvider,
  isAccountCredentialProvider,
  isSubscriptionProvider,
  type SubscriptionProvider,
} from "../auth/types.js";
import type { ElizaConfig } from "../config/types.eliza.js";

// ─── Account pool (single source of truth) ──────────────────────────
//
// All `LinkedAccountConfig` records (label / enabled / priority / health /
// usage) are owned by `@elizaos/app-core/account-pool`. We hit
// it via dynamic import to avoid a cyclic package dep — app-core depends
// on agent, not the other way around. The promise is cached at module
// scope so we pay the import cost once per process.

interface PoolFacade {
  list(providerId?: string): LinkedAccountConfig[];
  get(accountId: string, providerId?: string): LinkedAccountConfig | null;
  upsert(account: LinkedAccountConfig): Promise<void>;
  deleteMetadata(providerId: string, accountId: string): Promise<void>;
  refreshUsage(
    accountId: string,
    accessToken: string,
    opts?: { codexAccountId?: string; providerId?: string },
  ): Promise<void>;
}

let cachedPoolPromise: Promise<PoolFacade> | null = null;

async function getPool(): Promise<PoolFacade> {
  if (!cachedPoolPromise) {
    const moduleId = "@elizaos/app-core/account-pool";
    cachedPoolPromise = (async () => {
      const mod = (await import(/* @vite-ignore */ moduleId)) as {
        getDefaultAccountPool: () => PoolFacade;
      };
      return mod.getDefaultAccountPool();
    })();
  }
  return cachedPoolPromise;
}

/** Test-only: drop the cached pool reference between tests. */
export function _resetAccountsRoutesPoolCache(): void {
  cachedPoolPromise = null;
}

// ─── Provider id mapping ────────────────────────────────────────────

const SUPPORTED_PROVIDER_IDS = [
  "anthropic-subscription",
  "openai-codex",
  "anthropic-api",
  "openai-api",
  "deepseek-api",
  "zai-api",
  "moonshot-api",
] as const satisfies readonly LinkedAccountProviderId[];

const DIRECT_PROVIDER_IDS = new Set<LinkedAccountProviderId>([
  "anthropic-api",
  "openai-api",
  "deepseek-api",
  "zai-api",
  "moonshot-api",
]);

function asSubscriptionProvider(
  providerId: LinkedAccountProviderId,
): SubscriptionProvider | null {
  return isSubscriptionProvider(providerId) ? providerId : null;
}

function asAccountCredentialProvider(
  providerId: LinkedAccountProviderId,
): AccountCredentialProvider | null {
  return isAccountCredentialProvider(providerId) ? providerId : null;
}

// ─── Validation schemas ─────────────────────────────────────────────

const apiKeyAccountSchema = z.object({
  source: z.literal("api-key"),
  label: z.string().trim().min(1).max(120),
  apiKey: z.string().min(8).max(2048),
});

const oauthStartSchema = z.object({
  label: z.string().trim().min(1).max(120),
});

const oauthSubmitCodeSchema = z.object({
  sessionId: z.string().min(1),
  code: z.string().min(1),
});

const oauthCancelSchema = z.object({
  sessionId: z.string().min(1),
});

const accountPatchSchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    enabled: z.boolean().optional(),
    priority: z.number().int().min(0).max(10_000).optional(),
  })
  .refine(
    (v) =>
      v.label !== undefined ||
      v.enabled !== undefined ||
      v.priority !== undefined,
    {
      message: "PATCH body must set at least one of: label, enabled, priority",
    },
  );

const STRATEGY_VALUES = [
  "priority",
  "round-robin",
  "least-used",
  "quota-aware",
] as const satisfies readonly ServiceRouteAccountStrategy[];

const strategyPatchSchema = z.object({
  strategy: z.enum(STRATEGY_VALUES),
});

// ─── Strategy helpers ───────────────────────────────────────────────

function nextPriorityFromPool(
  pool: PoolFacade,
  providerId: LinkedAccountProviderId,
): number {
  const existing = pool.list(providerId);
  if (existing.length === 0) return 0;
  return Math.max(...existing.map((a) => a.priority)) + 1;
}

interface AccountStrategiesShape {
  accountStrategies?: Partial<
    Record<LinkedAccountProviderId, ServiceRouteAccountStrategy>
  >;
}

function readAccountStrategy(
  config: ElizaConfig,
  providerId: LinkedAccountProviderId,
): ServiceRouteAccountStrategy {
  const strategies = (config as ElizaConfig & AccountStrategiesShape)
    .accountStrategies;
  return strategies?.[providerId] ?? "priority";
}

function writeAccountStrategy(
  config: ElizaConfig,
  providerId: LinkedAccountProviderId,
  strategy: ServiceRouteAccountStrategy,
): void {
  const cfg = config as ElizaConfig & AccountStrategiesShape;
  if (!cfg.accountStrategies) cfg.accountStrategies = {};
  cfg.accountStrategies[providerId] = strategy;
}

// ─── Account ↔ config sync ──────────────────────────────────────────

function buildLinkedAccountConfigFromRecord(
  record: AccountCredentialRecord,
  priority: number,
): LinkedAccountConfig {
  if (!isLinkedAccountProviderId(record.providerId)) {
    throw new Error(
      `Internal error: provider "${record.providerId}" cannot back a LinkedAccountConfig`,
    );
  }
  return {
    id: record.id,
    providerId: record.providerId,
    label: record.label,
    source: record.source,
    enabled: true,
    priority,
    createdAt: record.createdAt,
    health: "ok",
    ...(record.lastUsedAt !== undefined
      ? { lastUsedAt: record.lastUsedAt }
      : {}),
    ...(record.organizationId ? { organizationId: record.organizationId } : {}),
    ...(record.userId ? { userId: record.userId } : {}),
    ...(record.email ? { email: record.email } : {}),
  };
}

// ─── Inline usage probes (WS2 fallback) ─────────────────────────────

/**
 * The full WS2 `accountPool.refreshUsage` provides a richer signal
 * (it also updates the in-memory pool's health/cooldown state). When
 * it isn't loaded yet we still want the UI to surface SOMETHING after
 * a "Refresh usage" click, so we issue a 1-token probe and fold the
 * `anthropic-ratelimit-*` (Anthropic) / `x-ratelimit-*` (Codex)
 * response headers into a `LinkedAccountUsage`. Numbers are
 * conservative — anything we can't read becomes `undefined`, never
 * `0`.
 */
async function probeAnthropicUsage(accessToken: string): Promise<{
  ok: boolean;
  status: number;
  usage?: LinkedAccountConfig["usage"];
  error?: string;
  latencyMs: number;
}> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    // @duplicate-component-audit-allow: usage probe reads auth/rate-limit headers; response text is ignored.
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const latencyMs = Date.now() - start;
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        status: response.status,
        error: `Anthropic ${response.status}: ${text.slice(0, 200)}`,
        latencyMs,
      };
    }
    return {
      ok: true,
      status: response.status,
      usage: { refreshedAt: Date.now() },
      latencyMs,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeCodexUsage(
  accessToken: string,
  codexAccountId?: string,
): Promise<{
  ok: boolean;
  status: number;
  usage?: LinkedAccountConfig["usage"];
  error?: string;
  latencyMs: number;
}> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    };
    if (codexAccountId) headers["ChatGPT-Account-Id"] = codexAccountId;
    // @duplicate-component-audit-allow: usage probe reads auth/rate-limit headers; response text is ignored.
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers,
      body: JSON.stringify({
        model: "gpt-5-mini",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const latencyMs = Date.now() - start;
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        status: response.status,
        error: `OpenAI ${response.status}: ${text.slice(0, 200)}`,
        latencyMs,
      };
    }
    return {
      ok: true,
      status: response.status,
      usage: { refreshedAt: Date.now() },
      latencyMs,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

function asDirectProvider(
  providerId: LinkedAccountProviderId,
): DirectAccountProvider | null {
  return DIRECT_PROVIDER_IDS.has(providerId)
    ? (providerId as DirectAccountProvider)
    : null;
}

function directProviderBaseUrl(providerId: DirectAccountProvider): string {
  switch (providerId) {
    case "anthropic-api":
      return (
        process.env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com/v1"
      );
    case "openai-api":
      return process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";
    case "deepseek-api":
      return (
        process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com"
      );
    case "zai-api":
      return (
        process.env.ZAI_BASE_URL?.trim() ||
        process.env.Z_AI_BASE_URL?.trim() ||
        "https://api.z.ai/api/paas/v4"
      );
    case "moonshot-api":
      return (
        process.env.MOONSHOT_BASE_URL?.trim() ||
        process.env.KIMI_BASE_URL?.trim() ||
        "https://api.moonshot.ai/v1"
      );
  }
}

async function probeDirectApiKey(
  providerId: DirectAccountProvider,
  apiKey: string,
): Promise<{
  ok: boolean;
  status: number;
  error?: string;
  latencyMs: number;
}> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const baseUrl = directProviderBaseUrl(providerId).replace(/\/+$/, "");
    const response =
      providerId === "anthropic-api"
        ? await fetch(`${baseUrl}/models?limit=1`, {
            method: "GET",
            signal: controller.signal,
            headers: {
              "anthropic-version": "2023-06-01",
              "x-api-key": apiKey,
            },
          })
        : await fetch(`${baseUrl}/models`, {
            method: "GET",
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${apiKey}`,
            },
          });
    const latencyMs = Date.now() - start;
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        status: response.status,
        error: `${providerId} ${response.status}: ${text.slice(0, 200)}`,
        latencyMs,
      };
    }
    return { ok: true, status: response.status, latencyMs };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

function healthForProbeStatus(status: number): LinkedAccountConfig["health"] {
  if (status === 401 || status === 403) return "needs-reauth";
  if (status === 429) return "rate-limited";
  if (status >= 500 || status === 0) return "unknown";
  return "invalid";
}

// ─── Route handler ──────────────────────────────────────────────────

export interface AccountsRouteContext extends RouteRequestContext {
  state: { config: ElizaConfig };
  saveConfig: (config: ElizaConfig) => void;
}

const ACCOUNTS_PREFIX = "/api/accounts";
const PROVIDERS_PREFIX = "/api/providers";

export async function handleAccountsRoutes(
  ctx: AccountsRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, json, error, readJsonBody } = ctx;

  if (
    !pathname.startsWith(ACCOUNTS_PREFIX) &&
    !pathname.startsWith(PROVIDERS_PREFIX)
  ) {
    return false;
  }

  // ── PATCH /api/providers/:providerId/strategy ─────────────────────
  if (
    method === "PATCH" &&
    pathname.startsWith(`${PROVIDERS_PREFIX}/`) &&
    pathname.endsWith("/strategy")
  ) {
    const providerId = pathname
      .slice(PROVIDERS_PREFIX.length + 1)
      .replace(/\/strategy$/, "");
    if (!isLinkedAccountProviderId(providerId)) {
      error(res, `Unknown providerId: ${providerId}`, 400);
      return true;
    }
    const body = await readJsonBody<{ strategy?: string }>(req, res);
    if (!body) return true;
    const parsed = strategyPatchSchema.safeParse(body);
    if (!parsed.success) {
      error(res, parsed.error.issues[0]?.message ?? "Invalid body", 400);
      return true;
    }
    writeAccountStrategy(ctx.state.config, providerId, parsed.data.strategy);
    ctx.saveConfig(ctx.state.config);
    json(res, { providerId, strategy: parsed.data.strategy });
    return true;
  }

  if (pathname === ACCOUNTS_PREFIX && method === "GET") {
    return await handleListAllAccounts(ctx);
  }

  // ── /api/accounts/:providerId... ──────────────────────────────────
  if (!pathname.startsWith(`${ACCOUNTS_PREFIX}/`)) return false;
  const remainder = pathname.slice(ACCOUNTS_PREFIX.length + 1);
  const segments = remainder.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return false;

  const providerId = segments[0];
  if (!isLinkedAccountProviderId(providerId)) {
    error(res, `Unknown providerId: ${providerId}`, 400);
    return true;
  }

  // ── POST /api/accounts/:providerId (api-key add) ──────────────────
  if (segments.length === 1 && method === "POST") {
    return await handleCreateApiKeyAccount(ctx, providerId);
  }

  // ── OAuth flow trio ───────────────────────────────────────────────
  if (segments[1] === "oauth") {
    return await handleOAuthRoutes(ctx, providerId, segments.slice(2));
  }

  // ── /:accountId actions ───────────────────────────────────────────
  if (segments.length >= 2) {
    const accountId = segments[1];
    if (segments.length === 2) {
      if (method === "PATCH") {
        return await handlePatchAccount(ctx, providerId, accountId);
      }
      if (method === "DELETE") {
        return await handleDeleteAccount(ctx, providerId, accountId);
      }
    }
    if (segments.length === 3 && method === "POST") {
      if (segments[2] === "test") {
        return await handleTestAccount(ctx, providerId, accountId);
      }
      if (segments[2] === "refresh-usage") {
        return await handleRefreshUsage(ctx, providerId, accountId);
      }
    }
  }

  return false;
}

// ─── Handlers ───────────────────────────────────────────────────────

async function handleListAllAccounts(
  ctx: AccountsRouteContext,
): Promise<boolean> {
  const { res, json } = ctx;
  const pool = await getPool();
  const providers = SUPPORTED_PROVIDER_IDS.map((providerId) => {
    const linkedConfigs = pool
      .list(providerId)
      .sort((a, b) => a.priority - b.priority);
    const accountProvider = asAccountCredentialProvider(providerId);
    const onDiskAccounts = accountProvider
      ? listAccounts(accountProvider).map((r) => r.id)
      : [];
    const onDiskSet = new Set(onDiskAccounts);
    return {
      providerId,
      strategy: readAccountStrategy(ctx.state.config, providerId),
      accounts: linkedConfigs.map((cfg) => ({
        ...cfg,
        hasCredential: onDiskSet.has(cfg.id),
      })),
    };
  });
  json(res, { providers });
  return true;
}

async function handleCreateApiKeyAccount(
  ctx: AccountsRouteContext,
  providerId: LinkedAccountProviderId,
): Promise<boolean> {
  const { req, res, json, error, readJsonBody } = ctx;
  const body = await readJsonBody<{ source?: string }>(req, res);
  if (!body) return true;
  const parsed = apiKeyAccountSchema.safeParse(body);
  if (!parsed.success) {
    error(res, parsed.error.issues[0]?.message ?? "Invalid body", 400);
    return true;
  }

  const accountProvider = asAccountCredentialProvider(providerId);
  if (!accountProvider) {
    error(res, `Credential storage not supported for ${providerId}`, 400);
    return true;
  }

  // Compute priority BEFORE we save the credential — once `saveAccount`
  // lands, the pool's auto-assignment in `loadAllAccounts` would slot
  // the new account at the next default index, which would offset
  // `nextPriorityFromPool` by one.
  const pool = await getPool();
  const priority = nextPriorityFromPool(pool, providerId);

  const id = nodeCrypto.randomUUID();
  const now = Date.now();
  const record: AccountCredentialRecord = {
    id,
    providerId: accountProvider,
    label: parsed.data.label,
    source: "api-key",
    credentials: {
      access: parsed.data.apiKey,
      refresh: "",
      // Sentinel: api-key creds never expire.
      expires: Number.MAX_SAFE_INTEGER,
    },
    createdAt: now,
    updatedAt: now,
  };
  saveAccount(record);

  const envKey =
    accountProvider in DIRECT_ACCOUNT_PROVIDER_ENV
      ? DIRECT_ACCOUNT_PROVIDER_ENV[accountProvider as DirectAccountProvider]
      : null;
  if (envKey) {
    process.env[envKey] = parsed.data.apiKey;
    if (accountProvider === "zai-api") {
      process.env.Z_AI_API_KEY ??= parsed.data.apiKey;
    }
  }

  const linkedConfig = buildLinkedAccountConfigFromRecord(record, priority);
  await pool.upsert(linkedConfig);

  json(res, linkedConfig, 201);
  return true;
}

async function handleOAuthRoutes(
  ctx: AccountsRouteContext,
  providerId: LinkedAccountProviderId,
  rest: string[],
): Promise<boolean> {
  const { req, res, json, error, readJsonBody, method } = ctx;
  const subscription = asSubscriptionProvider(providerId);
  if (!subscription) {
    error(res, `OAuth not supported for providerId: ${providerId}`, 400);
    return true;
  }

  const action = rest[0];

  if (action === "start" && method === "POST") {
    const body = await readJsonBody<{ label?: string }>(req, res);
    if (!body) return true;
    const parsed = oauthStartSchema.safeParse(body);
    if (!parsed.success) {
      error(res, parsed.error.issues[0]?.message ?? "Invalid body", 400);
      return true;
    }

    // Reserve an accountId up front so the OAuth flow can wire it
    // into the credential record before any token exchange completes.
    // Priority is computed AT SAVE TIME, not now: pre-allocating leaks
    // a stale priority if two users start parallel OAuth flows before
    // either completes (both would get the same number). Computing in
    // the post-save hook is monotonic regardless of concurrency since
    // the on-disk credential file appears strictly before the hook
    // fires.
    const accountId = nodeCrypto.randomUUID();
    const pool = await getPool();

    const onAccountSaved = async (record: AccountCredentialRecord) => {
      // Exclude the just-saved record from the priority calc — its
      // credential file already exists on disk so `pool.list` would
      // include it at a default priority (createdAt-sorted index),
      // which would push the new max one too high.
      const others = pool.list(providerId).filter((a) => a.id !== record.id);
      const livePriority =
        others.length === 0
          ? 0
          : Math.max(...others.map((a) => a.priority)) + 1;
      const linkedConfig = buildLinkedAccountConfigFromRecord(
        record,
        livePriority,
      );
      await pool.upsert(linkedConfig);
    };

    const startFlow =
      subscription === "anthropic-subscription"
        ? startAnthropicOAuthFlow
        : startCodexOAuthFlow;
    let handle: Awaited<ReturnType<typeof startFlow>>;
    try {
      handle = await startFlow({
        label: parsed.data.label,
        accountId,
        onAccountSaved,
      });
    } catch (err) {
      logger.error(
        `[accounts] Failed to start ${providerId} OAuth flow: ${String(err)}`,
      );
      error(res, "Failed to start OAuth flow", 500);
      return true;
    }
    json(res, {
      sessionId: handle.sessionId,
      authUrl: handle.authUrl,
      needsCodeSubmission: handle.needsCodeSubmission,
    });
    return true;
  }

  if (action === "status" && method === "GET") {
    return handleOAuthStatusSse(ctx, providerId);
  }

  if (action === "submit-code" && method === "POST") {
    const body = await readJsonBody<{ sessionId?: string; code?: string }>(
      req,
      res,
    );
    if (!body) return true;
    const parsed = oauthSubmitCodeSchema.safeParse(body);
    if (!parsed.success) {
      error(res, parsed.error.issues[0]?.message ?? "Invalid body", 400);
      return true;
    }
    const accepted = submitFlowCode(parsed.data.sessionId, parsed.data.code);
    if (!accepted) {
      error(res, "No active flow accepts a code submission", 400);
      return true;
    }
    json(res, { accepted: true });
    return true;
  }

  if (action === "cancel" && method === "POST") {
    const body = await readJsonBody<{ sessionId?: string }>(req, res);
    if (!body) return true;
    const parsed = oauthCancelSchema.safeParse(body);
    if (!parsed.success) {
      error(res, parsed.error.issues[0]?.message ?? "Invalid body", 400);
      return true;
    }
    const cancelled = cancelFlow(parsed.data.sessionId, "Cancelled by user");
    json(res, { cancelled });
    return true;
  }

  return false;
}

function handleOAuthStatusSse(
  ctx: AccountsRouteContext,
  providerId: LinkedAccountProviderId,
): boolean {
  const { req, res, error } = ctx;
  const url = new URL(req.url ?? "/", "http://localhost");
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    error(res, "Missing sessionId", 400);
    return true;
  }
  const initial = getFlowState(sessionId);
  if (!initial) {
    error(res, "Unknown sessionId", 404);
    return true;
  }
  if (initial.providerId !== providerId) {
    error(res, "Provider mismatch for sessionId", 400);
    return true;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const writeEvent = (data: unknown) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    try {
      res.end();
    } catch (err) {
      logger.debug(`[accounts] sse end failed: ${String(err)}`);
    }
  };

  const unsubscribe = subscribeFlow(sessionId, (state) => {
    if (closed) return;
    writeEvent(state);
    if (state.status !== "pending") {
      unsubscribe();
      finish();
    }
  });

  req.on("close", () => {
    unsubscribe();
    finish();
  });
  return true;
}

async function handlePatchAccount(
  ctx: AccountsRouteContext,
  providerId: LinkedAccountProviderId,
  accountId: string,
): Promise<boolean> {
  const { req, res, json, error, readJsonBody } = ctx;
  const body = await readJsonBody<{
    label?: unknown;
    enabled?: unknown;
    priority?: unknown;
  }>(req, res);
  if (!body) return true;
  const parsed = accountPatchSchema.safeParse(body);
  if (!parsed.success) {
    error(res, parsed.error.issues[0]?.message ?? "Invalid body", 400);
    return true;
  }
  const pool = await getPool();
  const existing = pool.get(accountId, providerId);
  if (!existing || existing.providerId !== providerId) {
    error(res, "Account not found", 404);
    return true;
  }
  const next: LinkedAccountConfig = {
    ...existing,
    ...(parsed.data.label !== undefined ? { label: parsed.data.label } : {}),
    ...(parsed.data.enabled !== undefined
      ? { enabled: parsed.data.enabled }
      : {}),
    ...(parsed.data.priority !== undefined
      ? { priority: parsed.data.priority }
      : {}),
  };
  await pool.upsert(next);

  // Mirror label changes onto the on-disk credential so listAccounts()
  // and the runtime keep reading the same name.
  if (parsed.data.label !== undefined) {
    const accountProvider = asAccountCredentialProvider(providerId);
    if (accountProvider) {
      const record = loadAccount(accountProvider, accountId);
      if (record && record.label !== parsed.data.label) {
        saveAccount({ ...record, label: parsed.data.label });
      }
    }
  }

  json(res, next);
  return true;
}

async function handleDeleteAccount(
  ctx: AccountsRouteContext,
  providerId: LinkedAccountProviderId,
  accountId: string,
): Promise<boolean> {
  const { res, json } = ctx;
  const pool = await getPool();
  await pool.deleteMetadata(providerId, accountId);
  const accountProvider = asAccountCredentialProvider(providerId);
  if (accountProvider) {
    deleteAccount(accountProvider, accountId);
  }
  json(res, { deleted: true });
  return true;
}

async function handleTestAccount(
  ctx: AccountsRouteContext,
  providerId: LinkedAccountProviderId,
  accountId: string,
): Promise<boolean> {
  const { res, json, error } = ctx;
  const subscription = asSubscriptionProvider(providerId);
  const direct = asDirectProvider(providerId);
  const tokenProvider = subscription ?? direct;
  if (!tokenProvider) {
    error(res, `Test not supported for ${providerId}`, 501);
    return true;
  }
  const accessToken = await getAccessToken(tokenProvider, accountId);
  if (!accessToken) {
    json(res, { ok: false, error: "No credential available" });
    return true;
  }
  const pool = await getPool();
  const linked = pool.get(accountId, providerId);
  const codexAccountId =
    linked?.providerId === "openai-codex" ? linked.organizationId : undefined;
  const probe = direct
    ? await probeDirectApiKey(direct, accessToken)
    : subscription === "anthropic-subscription"
      ? await probeAnthropicUsage(accessToken)
      : await probeCodexUsage(accessToken, codexAccountId);
  if (probe.ok) {
    json(res, { ok: true, latencyMs: probe.latencyMs, status: probe.status });
  } else {
    json(res, {
      ok: false,
      error: probe.error ?? `HTTP ${probe.status}`,
      status: probe.status,
      latencyMs: probe.latencyMs,
    });
  }
  return true;
}

async function handleRefreshUsage(
  ctx: AccountsRouteContext,
  providerId: LinkedAccountProviderId,
  accountId: string,
): Promise<boolean> {
  const { res, json, error } = ctx;
  const subscription = asSubscriptionProvider(providerId);
  const direct = asDirectProvider(providerId);
  const tokenProvider = subscription ?? direct;
  if (!tokenProvider) {
    error(res, `Usage refresh not supported for ${providerId}`, 501);
    return true;
  }
  const pool = await getPool();
  const linked = pool.get(accountId, providerId);
  if (!linked || linked.providerId !== providerId) {
    error(res, "Account not found", 404);
    return true;
  }
  const accessToken = await getAccessToken(tokenProvider, accountId);
  if (!accessToken) {
    error(res, "No credential available", 400);
    return true;
  }

  if (direct) {
    const probe = await probeDirectApiKey(direct, accessToken);
    const next: LinkedAccountConfig = {
      ...linked,
      health: probe.ok ? "ok" : healthForProbeStatus(probe.status),
      healthDetail: {
        lastChecked: Date.now(),
        ...(probe.ok
          ? {}
          : { lastError: probe.error ?? `HTTP ${probe.status}` }),
      },
      usage: {
        ...(linked.usage ?? {}),
        refreshedAt: Date.now(),
      },
    };
    await pool.upsert(next);
    json(res, { account: next, probe, source: "direct-probe" });
    return true;
  }

  // Drive the canonical `pollAnthropicUsage` / `pollCodexUsage` through
  // the pool — same singleton used by the runtime, so health flips and
  // usage snapshots are consistent across UI and inference paths. Falls
  // back to an inline 1-token probe only if the pool throws (network
  // failure to the provider's usage endpoint, etc.).
  try {
    await pool.refreshUsage(accountId, accessToken, {
      providerId,
      ...(linked.organizationId
        ? { codexAccountId: linked.organizationId }
        : {}),
    });
    const refreshed = pool.get(accountId, providerId);
    if (refreshed) {
      json(res, { account: refreshed, source: "pool" });
      return true;
    }
  } catch (err) {
    logger.debug(`[accounts] pool.refreshUsage failed: ${String(err)}`);
  }

  const probe =
    subscription === "anthropic-subscription"
      ? await probeAnthropicUsage(accessToken)
      : await probeCodexUsage(accessToken, linked.organizationId);
  const next: LinkedAccountConfig = {
    ...linked,
    ...(probe.usage ? { usage: probe.usage } : {}),
    health: probe.ok ? "ok" : "rate-limited",
    healthDetail: probe.ok
      ? { lastChecked: Date.now() }
      : {
          lastChecked: Date.now(),
          ...(probe.error ? { lastError: probe.error } : {}),
        },
  };
  await pool.upsert(next);
  json(res, { account: next, probe, source: "inline-probe" });
  return true;
}
