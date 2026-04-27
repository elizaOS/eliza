/**
 * Multi-account credentials CRUD + OAuth-from-UI routes.
 *
 * The HTTP surface this exposes (under `/api/accounts/...`) is the
 * source of truth for the React settings page. It joins three sources:
 *
 *   - the on-disk credential records under `~/.eliza/auth/...`
 *     (`account-storage.ts`),
 *   - the live `LinkedAccountConfig` rows in `milady.json` (which own
 *     `label`, `enabled`, `priority`, `health`, etc.),
 *   - the in-flight OAuth flow registry (`auth/oauth-flow.ts`) used by
 *     the `oauth/start` + SSE `oauth/status` + `oauth/cancel` trio.
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
import type { SubscriptionProvider } from "../auth/types.js";
import type { ElizaConfig } from "../config/types.eliza.js";
import type {
  LinkedAccountConfig,
  LinkedAccountProviderId,
  ServiceRouteAccountStrategy,
} from "../contracts/service-routing.js";
import type { RouteRequestContext } from "./route-helpers.js";

// ─── Provider id mapping ────────────────────────────────────────────

/**
 * Provider IDs the multi-account API accepts. The on-disk credential
 * store currently only handles the two subscription providers
 * (`SubscriptionProvider`); plain API keys are accepted by the API
 * but writing them is out of scope until the storage layer grows
 * support for them — for now we reject `anthropic-api` / `openai-api`
 * with 501.
 */
const SUPPORTED_PROVIDER_IDS = [
  "anthropic-subscription",
  "openai-codex",
  "anthropic-api",
  "openai-api",
] as const satisfies readonly LinkedAccountProviderId[];

const SUBSCRIPTION_PROVIDER_IDS = new Set<LinkedAccountProviderId>([
  "anthropic-subscription",
  "openai-codex",
]);

function isLinkedAccountProviderId(
  value: string,
): value is LinkedAccountProviderId {
  return (SUPPORTED_PROVIDER_IDS as readonly string[]).includes(value);
}

function asSubscriptionProvider(
  providerId: LinkedAccountProviderId,
): SubscriptionProvider | null {
  return SUBSCRIPTION_PROVIDER_IDS.has(providerId)
    ? (providerId as SubscriptionProvider)
    : null;
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
    { message: "PATCH body must set at least one of: label, enabled, priority" },
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

// ─── Config helpers ─────────────────────────────────────────────────

/**
 * Rich linked-account record map, stored at `config.linkedAccounts[id]`.
 *
 * Note on the dual-shape: the `linkedAccounts` field in the on-disk
 * `milady.json` ALSO holds legacy `LinkedAccountFlagConfig` entries for
 * providers like `elizacloud` / `cloud`. The legacy keys are
 * provider-name strings, while the multi-account keys are uuid v4s, so
 * they don't collide at runtime. We treat the dict as a union and only
 * touch entries we own (those whose value is a `LinkedAccountConfig`).
 */
function readLinkedAccountsRecord(
  config: ElizaConfig,
): Record<string, LinkedAccountConfig | unknown> {
  return (config.linkedAccounts ?? {}) as Record<
    string,
    LinkedAccountConfig | unknown
  >;
}

function isRichLinkedAccount(value: unknown): value is LinkedAccountConfig {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.providerId === "string" &&
    isLinkedAccountProviderId(v.providerId) &&
    typeof v.label === "string" &&
    (v.source === "oauth" || v.source === "api-key") &&
    typeof v.enabled === "boolean" &&
    typeof v.priority === "number" &&
    typeof v.createdAt === "number" &&
    typeof v.health === "string"
  );
}

function listLinkedAccountsForProvider(
  config: ElizaConfig,
  providerId: LinkedAccountProviderId,
): LinkedAccountConfig[] {
  const record = readLinkedAccountsRecord(config);
  const out: LinkedAccountConfig[] = [];
  for (const value of Object.values(record)) {
    if (!isRichLinkedAccount(value)) continue;
    if (value.providerId !== providerId) continue;
    out.push(value);
  }
  out.sort((a, b) => a.priority - b.priority);
  return out;
}

function nextPriority(
  config: ElizaConfig,
  providerId: LinkedAccountProviderId,
): number {
  const existing = listLinkedAccountsForProvider(config, providerId);
  if (existing.length === 0) return 0;
  return Math.max(...existing.map((a) => a.priority)) + 1;
}

function ensureLinkedAccountsBag(
  config: ElizaConfig,
): Record<string, LinkedAccountConfig | unknown> {
  if (!config.linkedAccounts) {
    (config as unknown as { linkedAccounts: Record<string, unknown> })
      .linkedAccounts = {};
  }
  return config.linkedAccounts as unknown as Record<
    string,
    LinkedAccountConfig | unknown
  >;
}

function writeLinkedAccount(
  config: ElizaConfig,
  account: LinkedAccountConfig,
): void {
  const bag = ensureLinkedAccountsBag(config);
  (bag as Record<string, LinkedAccountConfig>)[account.id] = account;
}

function removeLinkedAccount(config: ElizaConfig, accountId: string): void {
  const bag = config.linkedAccounts;
  if (!bag) return;
  if (Object.hasOwn(bag, accountId)) {
    delete (bag as Record<string, unknown>)[accountId];
  }
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
    ...(record.lastUsedAt !== undefined ? { lastUsedAt: record.lastUsedAt } : {}),
    ...(record.organizationId
      ? { organizationId: record.organizationId }
      : {}),
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
async function probeAnthropicUsage(
  accessToken: string,
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
    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        signal: controller.signal,
        headers,
        body: JSON.stringify({
          model: "gpt-5.5-mini",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      },
    );
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
  const providers = SUPPORTED_PROVIDER_IDS.map((providerId) => {
    const linkedConfigs = listLinkedAccountsForProvider(
      ctx.state.config,
      providerId,
    );
    const subscription = asSubscriptionProvider(providerId);
    const onDiskAccounts = subscription
      ? listAccounts(subscription).map((r) => r.id)
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

  const subscription = asSubscriptionProvider(providerId);
  if (!subscription) {
    error(
      res,
      `API-key accounts for ${providerId} are not yet wired up — track WS2`,
      501,
    );
    return true;
  }

  const id = nodeCrypto.randomUUID();
  const now = Date.now();
  const record: AccountCredentialRecord = {
    id,
    providerId: subscription,
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

  const priority = nextPriority(ctx.state.config, providerId);
  const linkedConfig = buildLinkedAccountConfigFromRecord(record, priority);
  writeLinkedAccount(ctx.state.config, linkedConfig);
  ctx.saveConfig(ctx.state.config);

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

    // Reserve an accountId and the priority slot up front so the
    // post-save hook lands at a deterministic position.
    const accountId = nodeCrypto.randomUUID();
    const priority = nextPriority(ctx.state.config, providerId);

    const onAccountSaved = (record: AccountCredentialRecord) => {
      const linkedConfig = buildLinkedAccountConfigFromRecord(record, priority);
      writeLinkedAccount(ctx.state.config, linkedConfig);
      ctx.saveConfig(ctx.state.config);
    };

    let handle;
    try {
      handle =
        subscription === "anthropic-subscription"
          ? await startAnthropicOAuthFlow({
              label: parsed.data.label,
              accountId,
              onAccountSaved,
            })
          : await startCodexOAuthFlow({
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
  const existing = readLinkedAccountsRecord(ctx.state.config)[accountId];
  if (!isRichLinkedAccount(existing) || existing.providerId !== providerId) {
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
  writeLinkedAccount(ctx.state.config, next);
  ctx.saveConfig(ctx.state.config);

  // Mirror label changes onto the on-disk credential so listAccounts()
  // and the runtime keep reading the same name.
  if (parsed.data.label !== undefined) {
    const subscription = asSubscriptionProvider(providerId);
    if (subscription) {
      const record = loadAccount(subscription, accountId);
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
  removeLinkedAccount(ctx.state.config, accountId);
  ctx.saveConfig(ctx.state.config);
  const subscription = asSubscriptionProvider(providerId);
  if (subscription) {
    deleteAccount(subscription, accountId);
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
  if (!subscription) {
    error(res, `Test not supported for ${providerId}`, 501);
    return true;
  }
  const accessToken = await getAccessToken(subscription, accountId);
  if (!accessToken) {
    json(res, { ok: false, error: "No credential available" });
    return true;
  }
  const linked = readLinkedAccountsRecord(ctx.state.config)[accountId];
  const codexAccountId =
    isRichLinkedAccount(linked) && linked.providerId === "openai-codex"
      ? linked.organizationId
      : undefined;
  const probe =
    subscription === "anthropic-subscription"
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
  if (!subscription) {
    error(res, `Usage refresh not supported for ${providerId}`, 501);
    return true;
  }
  const linked = readLinkedAccountsRecord(ctx.state.config)[accountId];
  if (!isRichLinkedAccount(linked) || linked.providerId !== providerId) {
    error(res, "Account not found", 404);
    return true;
  }
  const accessToken = await getAccessToken(subscription, accountId);
  if (!accessToken) {
    error(res, "No credential available", 400);
    return true;
  }

  // Prefer WS2's pool when it's loaded — it owns the canonical
  // `pollAnthropicUsage` / `pollCodexUsage` calls plus the in-memory
  // health/cooldown cache. Falls back to an inline 1-token probe when
  // the pool isn't reachable (e.g. tests, leaner installs).
  const poolResult = await tryRefreshViaPool({
    accountId,
    accessToken,
    codexAccountId: linked.organizationId,
  });
  if (poolResult.ok) {
    const refreshed = readLinkedAccountsRecord(ctx.state.config)[accountId];
    if (isRichLinkedAccount(refreshed)) {
      json(res, { account: refreshed, source: "pool" });
      return true;
    }
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
  writeLinkedAccount(ctx.state.config, next);
  ctx.saveConfig(ctx.state.config);
  json(res, { account: next, probe, source: "inline-probe" });
  return true;
}

/**
 * Try to drive the usage refresh through WS2's `AccountPool` singleton
 * if it's loaded. The pool lives in `@elizaos/app-core` (which depends
 * on `@elizaos/agent`, not the other way around), so we resolve it via
 * a runtime dynamic import to avoid a cyclic dependency. Returns
 * `{ ok: false }` if the pool can't be loaded — caller then falls back
 * to the inline probe.
 */
async function tryRefreshViaPool(args: {
  accountId: string;
  accessToken: string;
  codexAccountId?: string;
}): Promise<{ ok: boolean }> {
  try {
    // The dynamic import resolves at runtime only; bundlers / tsc
    // don't follow it as a hard edge.
    const moduleId = "@elizaos/app-core/services/account-pool";
    const mod = (await import(/* @vite-ignore */ moduleId)) as {
      getDefaultAccountPool?: () => {
        refreshUsage: (
          accountId: string,
          accessToken: string,
          opts?: { codexAccountId?: string },
        ) => Promise<void>;
      };
    };
    if (!mod.getDefaultAccountPool) return { ok: false };
    const pool = mod.getDefaultAccountPool();
    await pool.refreshUsage(args.accountId, args.accessToken, {
      ...(args.codexAccountId ? { codexAccountId: args.codexAccountId } : {}),
    });
    return { ok: true };
  } catch (err) {
    logger.debug(`[accounts] pool refreshUsage unavailable: ${String(err)}`);
    return { ok: false };
  }
}
