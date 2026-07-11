/**
 * Authenticated HTTP client for Steward's governed trading routes. The service
 * is deliberately thin: Eliza carries intent, session ids, and idempotency
 * keys, while Steward owns policy checks, custody, signing, venue submission,
 * spend accounting, replay, and audit.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ElizaError, type IAgentRuntime, Service } from "@elizaos/core";
import type {
  CancelOrderRequest,
  CancelResult,
  OpenOrder,
  OpenSessionRequest,
  OrderResult,
  PolicyDenyReason,
  Position,
  SubmitOrderRequest,
  TradeEnvelope,
  TradeSession,
  TradeTokenStatus,
  TradingAccount,
  TradingCapability,
  Venue,
} from "../types/trade.js";

export const STEWARD_TRADING_SERVICE_TYPE = "steward-trading" as const;

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 25;

interface StewardTradingConfig {
  readonly apiUrl: string;
  readonly agentId: string;
  readonly agentToken?: string;
  readonly apiKey?: string;
  readonly tenantId?: string;
}

interface JsonResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}

class StewardTransportError extends ElizaError {
  readonly timedOut: boolean;

  constructor(cause: unknown, timedOut: boolean) {
    super(
      timedOut
        ? "Steward request timed out"
        : "Steward transport failed before a response was received",
      {
        code: timedOut ? "STEWARD_TIMEOUT" : "STEWARD_TRANSPORT_FAILED",
        cause,
        severity: "ephemeral",
      },
    );
    this.timedOut = timedOut;
  }
}

type FetchLike = typeof fetch;
type SleepFn = (ms: number) => Promise<void>;
type RandomFn = () => number;

export interface StewardTradingServiceOptions {
  readonly fetch?: FetchLike;
  readonly sleep?: SleepFn;
  readonly random?: RandomFn;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
}

interface PersistedStewardCredentials {
  readonly apiUrl?: string;
  readonly tenantId?: string;
  readonly agentId?: string;
  readonly apiKey?: string;
  readonly agentToken?: string;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = normalizeOptionalString(env.ELIZA_STATE_DIR);
  if (explicit) return explicit;
  const namespace = normalizeOptionalString(env.ELIZA_NAMESPACE) ?? "eliza";
  const xdgStateHome = normalizeOptionalString(env.XDG_STATE_HOME);
  const stateHome = xdgStateHome
    ? path.isAbsolute(xdgStateHome)
      ? xdgStateHome
      : path.join(homedir(), xdgStateHome)
    : path.join(homedir(), ".local", "state");
  return path.join(stateHome, namespace);
}

function readJsonCredentialsFile(
  credentialsPath: string,
): PersistedStewardCredentials | null {
  try {
    if (!fs.existsSync(credentialsPath)) return null;
    const parsed = JSON.parse(
      fs.readFileSync(credentialsPath, "utf8"),
    ) as Record<string, unknown>;
    return {
      apiUrl: normalizeOptionalString(parsed.apiUrl),
      tenantId: normalizeOptionalString(parsed.tenantId),
      agentId: normalizeOptionalString(parsed.agentId),
      apiKey:
        normalizeOptionalString(parsed.apiKey) ??
        normalizeOptionalString(parsed.tenantApiKey),
      agentToken: normalizeOptionalString(parsed.agentToken),
    };
  } catch {
    // error-policy:J4 Missing/corrupt persisted credentials make Steward unavailable.
    return null;
  }
}

function readPersistedStewardCredentials(): PersistedStewardCredentials | null {
  return readJsonCredentialsFile(
    path.join(resolveStateDir(), "steward-credentials.json"),
  );
}

function joinUrl(base: string, route: string): string {
  const normalizedBase = base.replace(/\/+$/, "");
  return `${normalizedBase}${route}`;
}

function isSecureStewardApiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "::1" ||
        url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function retryDelayMs(attempt: number, random: RandomFn): number {
  const base = RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1);
  return Math.round(base * (0.75 + random() * 0.5));
}

function detailFromBody(body: unknown, fallback: string): string {
  if (typeof body === "string" && body.trim()) return body;
  if (typeof body !== "object" || body === null) return fallback;
  const record = body as Record<string, unknown>;
  return (
    normalizeOptionalString(record.reason) ??
    normalizeOptionalString(record.message) ??
    normalizeOptionalString(record.error) ??
    fallback
  );
}

function policyReasonFromBody(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  return (
    normalizeOptionalString(record.reason) ??
    normalizeOptionalString(record.message) ??
    normalizeOptionalString(record.error)
  );
}

function mapPolicyDenyReason(reason: string | undefined): PolicyDenyReason {
  const normalized = (reason ?? "").toLowerCase();
  if (/no trade policy|has no trade policy|policy-missing/.test(normalized)) {
    return "policy-missing";
  }
  if (
    /session.*not active|active .*session required|session-not-active/.test(
      normalized,
    )
  ) {
    return "session-not-active";
  }
  if (/leverage-cap|leverage .*exceeds|leverage cap/.test(normalized)) {
    return "leverage-cap-exceeded";
  }
  if (/per-order-cap|per order|perorder/.test(normalized)) {
    return "per-order-cap-exceeded";
  }
  if (/daily-spend-cap|daily cap|dailycap/.test(normalized)) {
    return "daily-cap-exceeded";
  }
  return "market-not-allowed";
}

function bodyCode(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  return normalizeOptionalString((body as Record<string, unknown>).code);
}

function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get("Retry-After") ?? headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

function bodySaysStatusUnknown(body: unknown): boolean {
  const detail = detailFromBody(body, "");
  return /status unknown|submission status unknown/i.test(detail);
}

function unknownSubmissionResponse(): JsonResponse {
  return {
    status: 502,
    headers: new Headers(),
    body: { ok: false, error: "Trade submission status unknown" },
  };
}

function isStewardCredentialFailure(status: number, detail: string): boolean {
  if (status === 401) return true;
  return (
    /\bagent\s+jwt\s+(?:required|missing|invalid|expired)\b/i.test(detail) ||
    /\bauth(?:entication)?[-_\s]?token\s+(?:required|missing|invalid|expired)\b/i.test(
      detail,
    ) ||
    /\b(?:required|missing|invalid|expired)\s+auth(?:entication)?[-_\s]?token\b/i.test(
      detail,
    )
  );
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.name === "TimeoutError";
}

function isResponseEnvelope(
  body: unknown,
): body is { ok: true; data: unknown } {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as Record<string, unknown>).ok === true &&
    Object.hasOwn(body, "data")
  );
}

function sessionIdFromRequest(req: SubmitOrderRequest): string {
  return req.sessionId;
}

function toSessionData(body: unknown): TradeSession {
  const data = isResponseEnvelope(body) ? body.data : body;
  const record = data as Record<string, unknown>;
  const sessionId =
    normalizeOptionalString(record.sessionId) ??
    normalizeOptionalString(record.id) ??
    "";
  return { ...(record as Omit<TradeSession, "sessionId">), sessionId };
}

function toTokenStatus(body: unknown): TradeTokenStatus {
  const data = isResponseEnvelope(body) ? body.data : body;
  return data as TradeTokenStatus;
}

function toOrderResult(
  venue: Venue,
  body: unknown,
  idempotencyKey: string,
): OrderResult | null {
  const data = isResponseEnvelope(body) ? body.data : body;
  const record = data as Record<string, unknown>;
  const orderId = normalizeOptionalString(record.orderId);
  const status = normalizeOptionalString(record.status);
  if (!orderId || !status) return null;
  return {
    venue,
    orderId,
    status,
    filledQty:
      typeof record.filledQty === "number" ? record.filledQty : undefined,
    avgPrice: typeof record.avgPrice === "number" ? record.avgPrice : undefined,
    txHash:
      typeof record.txHash === "string" || record.txHash === null
        ? record.txHash
        : undefined,
    notionalUsd:
      typeof record.notionalUsd === "number" ? record.notionalUsd : undefined,
    builderPerp:
      typeof record.builderPerp === "boolean" ? record.builderPerp : undefined,
    idempotencyKey,
  };
}

function routeNotFound<T>(detail: string): TradeEnvelope<T> {
  return {
    ok: false,
    outcome: "not_attempted",
    error: "ROUTE_NOT_FOUND",
    detail,
    retryable: false,
  };
}

function mapFailure<T>(
  response: JsonResponse,
  fallback: string,
): TradeEnvelope<T> {
  const { body, headers, status } = response;
  const detail = detailFromBody(body, fallback);
  const code = bodyCode(body);
  if (status === 400 && code === "policy-violation") {
    const stewardReason = policyReasonFromBody(body) ?? detail;
    return {
      ok: false,
      outcome: "policy_denied",
      error: "POLICY_BLOCKED",
      detail,
      retryable: false,
      policy: {
        reason: mapPolicyDenyReason(stewardReason),
      },
    };
  }
  if (status === 403 && /no trade policy/i.test(detail)) {
    return {
      ok: false,
      outcome: "policy_denied",
      error: "POLICY_REQUIRES_APPROVAL",
      detail,
      retryable: false,
      policy: {
        reason: mapPolicyDenyReason(detail),
      },
    };
  }
  if (status === 403 && /session required/i.test(detail)) {
    return {
      ok: false,
      outcome: "policy_denied",
      error: "SESSION_REQUIRED",
      detail,
      retryable: false,
    };
  }
  if (isStewardCredentialFailure(status, detail)) {
    return {
      ok: false,
      outcome: "not_attempted",
      error: "PROVIDER_AUTH_MISSING",
      detail,
      retryable: false,
    };
  }
  if (status === 409 && /idempotency key reused/i.test(detail)) {
    return {
      ok: false,
      outcome: "not_attempted",
      error: "IDEMPOTENCY_CONFLICT",
      detail,
      retryable: false,
    };
  }
  if (
    (status === 404 || status === 409) &&
    /credential|creds|wallet.*not found|unprovisioned/i.test(detail)
  ) {
    return {
      ok: false,
      outcome: "not_attempted",
      error: "PROVIDER_AUTH_MISSING",
      detail,
      retryable: false,
    };
  }
  if (status === 429) {
    return {
      ok: false,
      outcome: "not_attempted",
      error: "RATE_LIMITED",
      detail,
      retryable: true,
      retryAfterMs: retryAfterMs(headers),
    };
  }
  if (status >= 500 && bodySaysStatusUnknown(body)) {
    return {
      ok: false,
      outcome: "unknown",
      error: "TIMEOUT",
      detail,
      retryable: false,
    };
  }
  if (status >= 500) {
    return {
      ok: false,
      outcome: "not_attempted",
      error: "STEWARD_UNAVAILABLE",
      detail,
      retryable: true,
    };
  }
  return {
    ok: false,
    outcome: status === 404 ? "not_attempted" : "rejected",
    error: status === 404 ? "ROUTE_NOT_FOUND" : "PROVIDER_REJECTED",
    detail,
    retryable: false,
  };
}

function buildOrderRoute(req: SubmitOrderRequest): string {
  return req.venue === "hyperliquid"
    ? "/v1/trade/hyperliquid/order"
    : "/v1/trade/polymarket/order";
}

function buildOrderBody(req: SubmitOrderRequest, idempotencyKey: string) {
  if (req.venue === "hyperliquid") {
    return {
      sessionId: req.sessionId,
      coin: req.coin,
      side: req.side,
      size: req.size,
      limitPx: req.limitPx,
      leverage: req.leverage,
      reduceOnly: req.reduceOnly,
      orderType: req.tif ? { limit: { tif: req.tif } } : undefined,
      idempotencyKey,
    };
  }
  return {
    sessionId: req.sessionId,
    tokenId: req.tokenId,
    side: req.side,
    amount: req.amount,
    price: req.price,
    tickSize: req.tickSize,
    negRisk: req.negRisk,
    idempotencyKey,
  };
}

function buildSessionBody(req: OpenSessionRequest, agentId: string) {
  return {
    agentId,
    venue: req.venue,
    dailyCap: req.dailyCapUsd,
    perOrderCap: req.perOrderCapUsd,
    leverageCap: req.leverageCap,
    allowedAssets: req.allowedAssets ? [...req.allowedAssets] : undefined,
    ttlSeconds: req.ttlSeconds,
  };
}

export function createTradeIdempotencyKey(): string {
  return randomUUID();
}

export class StewardTradingService extends Service {
  static override serviceType = STEWARD_TRADING_SERVICE_TYPE;

  override capabilityDescription =
    "Governed Steward trading HTTP client for Hyperliquid and Polymarket";

  private readonly fetchImpl: FetchLike;
  private readonly sleep: SleepFn;
  private readonly random: RandomFn;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly tradingConfig: StewardTradingConfig | null;

  constructor(
    runtime?: IAgentRuntime,
    options: StewardTradingServiceOptions = {},
  ) {
    super(runtime);
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep =
      options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = options.random ?? Math.random;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? MAX_RETRIES;
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 1) {
      throw new ElizaError("Steward maxRetries must be a positive integer", {
        code: "STEWARD_INVALID_RETRY_CONFIG",
        context: { maxRetries: this.maxRetries },
        severity: "fatal",
      });
    }
    this.tradingConfig = this.resolveConfig();
  }

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<StewardTradingService> {
    return new StewardTradingService(runtime);
  }

  override async stop(): Promise<void> {}

  capability(): TradingCapability {
    if (!this.tradingConfig) {
      return {
        kind: "none",
        canTrade: false,
        reason:
          "STEWARD_API_URL, STEWARD_AGENT_ID, and a Steward auth token are required.",
      };
    }
    const isCloud =
      normalizeOptionalString(
        this.runtime.getSetting("ELIZA_CLOUD_PROVISIONED"),
      ) === "1" || process.env.ELIZA_CLOUD_PROVISIONED === "1";
    return {
      kind: isCloud ? "steward-cloud" : "steward-self",
      canTrade: true,
      agentId: this.tradingConfig.agentId,
      apiUrl: this.tradingConfig.apiUrl,
    };
  }

  async tokenStatus(): Promise<TradeTokenStatus> {
    const config = this.requireConfig();
    const response = await this.request(
      `/v1/trade/token-status?agentId=${encodeURIComponent(config.agentId)}`,
      { method: "GET" },
      false,
    );
    if (response.status >= 200 && response.status < 300) {
      return toTokenStatus(response.body);
    }
    throw new Error(
      detailFromBody(response.body, "Steward token status failed"),
    );
  }

  async openSession(
    req: OpenSessionRequest,
  ): Promise<TradeEnvelope<TradeSession>> {
    const config = this.requireConfig();
    const response = await this.request(
      "/v1/trade/sessions",
      {
        method: "POST",
        body: buildSessionBody(req, config.agentId),
      },
      false,
    );
    if (response.status >= 200 && response.status < 300) {
      const session = toSessionData(response.body);
      return {
        ok: true,
        data: session,
        audit: { sessionId: session.sessionId },
      };
    }
    return mapFailure(response, "Steward session open failed");
  }

  async getSession(id: string): Promise<TradeEnvelope<TradeSession>> {
    const response = await this.request(
      `/v1/trade/sessions/${encodeURIComponent(id)}`,
      { method: "GET" },
      false,
    );
    if (response.status >= 200 && response.status < 300) {
      const session = toSessionData(response.body);
      return {
        ok: true,
        data: session,
        audit: { sessionId: session.sessionId },
      };
    }
    return mapFailure(response, "Steward session lookup failed");
  }

  async revokeSession(id: string): Promise<TradeEnvelope<{ revoked: true }>> {
    const response = await this.request(
      `/v1/trade/sessions/${encodeURIComponent(id)}/revoke`,
      { method: "POST" },
      false,
    );
    if (response.status >= 200 && response.status < 300) {
      return { ok: true, data: { revoked: true }, audit: { sessionId: id } };
    }
    return mapFailure(response, "Steward session revoke failed");
  }

  async submitOrder(
    req: SubmitOrderRequest,
  ): Promise<TradeEnvelope<OrderResult>> {
    const idempotencyKey = normalizeOptionalString(req.idempotencyKey);
    if (!idempotencyKey) {
      return {
        ok: false,
        outcome: "not_attempted",
        error: "INVALID_PARAMS",
        detail: "submitOrder requires a caller-supplied idempotency key.",
        retryable: false,
      };
    }
    const body = buildOrderBody(req, idempotencyKey);
    const response = await this.requestWithRetry(
      buildOrderRoute(req),
      {
        method: "POST",
        body,
        idempotencyKey,
      },
      idempotencyKey,
    );
    if (response.status >= 200 && response.status < 300) {
      const orderResult = toOrderResult(
        req.venue,
        response.body,
        idempotencyKey,
      );
      if (!orderResult) {
        return {
          ok: false,
          outcome: "not_attempted",
          error: "STEWARD_UNAVAILABLE",
          detail: "Steward order response was missing required order fields.",
          retryable: true,
        };
      }
      return {
        ok: true,
        data: orderResult,
        audit: { sessionId: sessionIdFromRequest(req), idempotencyKey },
      };
    }
    return mapFailure(response, "Steward order submission failed");
  }

  async cancelOrder(
    req: CancelOrderRequest,
  ): Promise<TradeEnvelope<CancelResult>> {
    return routeNotFound(
      `Steward does not expose a ${req.venue} cancel-order HTTP route yet.`,
    );
  }

  async resolveAccount(venue: Venue): Promise<TradeEnvelope<TradingAccount>> {
    const settingName =
      venue === "hyperliquid"
        ? "STEWARD_HYPERLIQUID_TRADE_SESSION_ID"
        : "STEWARD_POLYMARKET_TRADE_SESSION_ID";
    const sessionId =
      normalizeOptionalString(this.runtime.getSetting(settingName)) ??
      normalizeOptionalString(process.env[settingName]) ??
      normalizeOptionalString(
        this.runtime.getSetting("STEWARD_TRADE_SESSION_ID"),
      ) ??
      normalizeOptionalString(process.env.STEWARD_TRADE_SESSION_ID);
    if (!sessionId) {
      return {
        ok: false,
        outcome: "policy_denied",
        error: "SESSION_REQUIRED",
        detail: `No governed ${venue} trade session is configured.`,
        retryable: false,
        policy: {
          reason: "session-not-active",
        },
      };
    }
    const config = this.requireConfig();
    const tokenResponse = await this.request(
      `/v1/trade/token-status?agentId=${encodeURIComponent(config.agentId)}`,
      { method: "GET" },
      false,
    );
    if (tokenResponse.status < 200 || tokenResponse.status >= 300) {
      return mapFailure(tokenResponse, "Steward token status failed");
    }
    const session = await this.getSession(sessionId);
    if (!session.ok) return session;
    if (session.data.venue !== venue || session.data.status !== "active") {
      return {
        ok: false,
        outcome: "policy_denied",
        error: "SESSION_REQUIRED",
        detail: `Configured ${venue} session is not active.`,
        retryable: false,
        policy: {
          reason: "session-not-active",
        },
      };
    }
    const accountId = session.data.walletAddress ?? session.data.walletId;
    if (!accountId) {
      return {
        ok: false,
        outcome: "not_attempted",
        error: "PROVIDER_AUTH_MISSING",
        detail: `${venue} venue wallet is not provisioned.`,
        retryable: false,
      };
    }
    return {
      ok: true,
      data: {
        venue,
        accountId,
        agentId: session.data.agentId,
        walletAddress: session.data.walletAddress,
        walletId: session.data.walletId,
        status: "active",
      },
      audit: { sessionId },
    };
  }

  async listOrders(venue: Venue): Promise<TradeEnvelope<OpenOrder[]>> {
    return routeNotFound(
      `Steward does not expose a ${venue} list-orders HTTP route yet.`,
    );
  }

  async listPositions(venue: Venue): Promise<TradeEnvelope<Position[]>> {
    return routeNotFound(
      `Steward does not expose a ${venue} positions HTTP route yet.`,
    );
  }

  private resolveConfig(): StewardTradingConfig | null {
    const persisted = readPersistedStewardCredentials();
    const apiUrl =
      normalizeOptionalString(this.runtime.getSetting("STEWARD_API_URL")) ??
      normalizeOptionalString(process.env.STEWARD_API_URL) ??
      persisted?.apiUrl;
    const agentId =
      normalizeOptionalString(this.runtime.getSetting("STEWARD_AGENT_ID")) ??
      normalizeOptionalString(
        this.runtime.getSetting("ELIZA_STEWARD_AGENT_ID"),
      ) ??
      normalizeOptionalString(process.env.STEWARD_AGENT_ID) ??
      normalizeOptionalString(process.env.ELIZA_STEWARD_AGENT_ID) ??
      persisted?.agentId;
    const agentToken =
      normalizeOptionalString(this.runtime.getSetting("STEWARD_AGENT_TOKEN")) ??
      normalizeOptionalString(process.env.STEWARD_AGENT_TOKEN) ??
      persisted?.agentToken;
    const apiKey =
      normalizeOptionalString(this.runtime.getSetting("STEWARD_API_KEY")) ??
      normalizeOptionalString(process.env.STEWARD_API_KEY) ??
      persisted?.apiKey;
    const tenantId =
      normalizeOptionalString(this.runtime.getSetting("STEWARD_TENANT_ID")) ??
      normalizeOptionalString(process.env.STEWARD_TENANT_ID) ??
      persisted?.tenantId;
    if (!apiUrl || !isSecureStewardApiUrl(apiUrl) || !agentId || !agentToken) {
      return null;
    }
    return { apiUrl, agentId, agentToken, apiKey, tenantId };
  }

  private requireConfig(): StewardTradingConfig {
    if (!this.tradingConfig) {
      throw new Error(
        "Steward trading is not configured. Set Steward API URL, agent ID, and auth token.",
      );
    }
    return this.tradingConfig;
  }

  private headers(idempotencyKey?: string): Record<string, string> {
    const config = this.requireConfig();
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (config.agentToken) {
      headers.Authorization = `Bearer ${config.agentToken}`;
    } else if (config.apiKey) {
      headers["X-Steward-Key"] = config.apiKey;
    }
    if (config.tenantId) headers["X-Steward-Tenant"] = config.tenantId;
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    return headers;
  }

  private async requestWithRetry(
    route: string,
    init: {
      readonly method: "GET" | "POST";
      readonly body?: unknown;
      readonly idempotencyKey?: string;
    },
    idempotencyKey: string,
  ): Promise<JsonResponse> {
    let last: JsonResponse | null = null;
    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await this.request(route, init, true);
        if (response.status >= 500 && bodySaysStatusUnknown(response.body)) {
          return response;
        }
        if (!(response.status === 429 || response.status >= 500))
          return response;
        last = response;
        if (attempt === this.maxRetries) {
          return response.status === 429
            ? response
            : unknownSubmissionResponse();
        }
        await this.sleep(
          retryAfterMs(response.headers) ?? retryDelayMs(attempt, this.random),
        );
      } catch (error) {
        // error-policy:J1 Known transport failures become an explicit unknown
        // submission outcome; configuration and programming errors propagate.
        if (!(error instanceof StewardTransportError)) throw error;
        last = unknownSubmissionResponse();
        if (error.timedOut || attempt === this.maxRetries) return last;
        await this.sleep(retryDelayMs(attempt, this.random));
      }
    }
    throw new ElizaError("Steward retry loop ended without a response", {
      code: "STEWARD_RETRY_INVARIANT_BROKEN",
      context: { idempotencyKey, hadResponse: last !== null },
      severity: "fatal",
    });
  }

  private async request(
    route: string,
    init: {
      readonly method: "GET" | "POST";
      readonly body?: unknown;
      readonly idempotencyKey?: string;
    },
    throwTransportErrors: boolean,
  ): Promise<JsonResponse & { retryAfterMs?: number }> {
    const config = this.requireConfig();
    const headers = this.headers(init.idempotencyKey);
    const serializedBody =
      init.body === undefined ? undefined : JSON.stringify(init.body);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(joinUrl(config.apiUrl, route), {
        method: init.method,
        headers,
        body: serializedBody,
        signal: controller.signal,
      });
      const text = await response.text();
      let responseBody: unknown;
      try {
        responseBody = text ? JSON.parse(text) : null;
      } catch {
        // error-policy:J1 Malformed upstream JSON becomes a structured failure.
        responseBody = {
          ok: false,
          error: "Steward returned an unparseable body",
        };
        if (response.ok) {
          return { status: 502, headers: response.headers, body: responseBody };
        }
      }
      return {
        status: response.status,
        headers: response.headers,
        body: responseBody,
        retryAfterMs: retryAfterMs(response.headers),
      };
    } catch (error) {
      // error-policy:J2 Preserve the transport cause while preventing request
      // metadata and credentials from entering the error message.
      if (throwTransportErrors) {
        throw new StewardTransportError(error, isTimeoutError(error));
      }
      return {
        status: isTimeoutError(error) ? 502 : 503,
        headers: new Headers(),
        body: {
          ok: false,
          error: isTimeoutError(error)
            ? "Trade submission status unknown"
            : "Steward unavailable",
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
