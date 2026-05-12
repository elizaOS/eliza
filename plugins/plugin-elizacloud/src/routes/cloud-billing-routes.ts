import type http from "node:http";
import type { AgentRuntime, Service } from "@elizaos/core";
import { normalizeCloudSiteUrl } from "../cloud/base-url.js";
import { resolveCloudApiKey } from "../cloud/cloud-api-key.js";
import { validateCloudBaseUrl } from "../cloud/validate-url.js";
import type { CloudProxyConfigLike } from "../lib/config-like";
import { sendJson, sendJsonError } from "../lib/http";

export interface CloudBillingRouteState {
  config: CloudProxyConfigLike;
  runtime?: AgentRuntime | null;
}

const PROXY_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 1_048_576;
const MAX_REDIRECTS = 4;
/**
 * crypto/status changes rarely (it advertises whether crypto top-ups are
 * enabled and which networks). Caching it amortises the second upstream call
 * `forwardSummary` makes per dashboard refresh against the per-key rate limit.
 *
 * Keyed by `(baseUrl, Authorization header)` so multi-account hosts (or hosts
 * that switch keys via re-login) never serve one account's cached status to
 * another. The Authorization header is already present in process memory at
 * the time of caching, so this introduces no new exposure.
 */
const CRYPTO_STATUS_CACHE_MS = 60_000;
const cryptoStatusCache = new Map<
  string,
  { value: unknown; expiresAt: number }
>();

function cryptoStatusCacheKey(
  baseUrl: string,
  headers: Record<string, string>,
): string {
  return `${baseUrl}|${headers.Authorization ?? ""}`;
}

async function fetchCryptoStatusCached(
  baseUrl: string,
  headers: Record<string, string>,
): Promise<unknown> {
  const now = Date.now();
  const cacheKey = cryptoStatusCacheKey(baseUrl, headers);
  const cached = cryptoStatusCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  const response = await fetchUpstream(
    `${baseUrl}/api/crypto/status`,
    "GET",
    headers,
    undefined,
  ).catch(() => null);
  if (!response?.ok) {
    return cached?.value ?? null;
  }
  const value = await readJsonResponse(response).catch(() => ({}));
  cryptoStatusCache.set(cacheKey, {
    value,
    expiresAt: now + CRYPTO_STATUS_CACHE_MS,
  });
  return value;
}

interface CloudAuthApiKeyService {
  isAuthenticated: () => boolean;
  getApiKey?: () => string | undefined;
}

function resolveCloudBaseUrl(config: CloudProxyConfigLike): string {
  return normalizeCloudSiteUrl(config.cloud?.baseUrl);
}

function normalizeCloudApiKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toUpperCase() === "[REDACTED]") {
    return null;
  }
  return trimmed;
}

function resolveProxyApiKey(state: CloudBillingRouteState): string | null {
  const cloudAuth = state.runtime
    ? state.runtime.getService<Service & CloudAuthApiKeyService>("CLOUD_AUTH")
    : null;
  const runtimeApiKey =
    cloudAuth?.isAuthenticated() === true
      ? normalizeCloudApiKey(cloudAuth.getApiKey?.())
      : null;

  return runtimeApiKey ?? resolveCloudApiKey(state.config, state.runtime);
}

function buildAuthHeaders(
  config: CloudProxyConfigLike,
  apiKeyOverride?: string | null,
): Record<string, string> {
  const serviceKey = config.cloud?.serviceKey?.trim();
  const apiKey =
    normalizeCloudApiKey(apiKeyOverride) ?? resolveCloudApiKey(config);

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  if (serviceKey) {
    headers["X-Service-Key"] = serviceKey;
  }
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readBody(req: http.IncomingMessage): Promise<string | undefined> {
  const preParsedBody = (req as http.IncomingMessage & { body?: unknown }).body;
  if (preParsedBody !== undefined) {
    return Promise.resolve(
      typeof preParsedBody === "string"
        ? preParsedBody
        : JSON.stringify(preParsedBody),
    );
  }

  if (req.readableEnded) {
    return Promise.resolve(undefined);
  }

  return new Promise<string | undefined>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () =>
      resolve(
        chunks.length > 0 ? Buffer.concat(chunks).toString("utf-8") : undefined,
      ),
    );
    req.on("error", reject);
  });
}

async function fetchUpstream(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
): Promise<Response> {
  let currentUrl = url;
  let currentMethod = method;
  let currentBody = body;

  for (
    let redirectCount = 0;
    redirectCount <= MAX_REDIRECTS;
    redirectCount += 1
  ) {
    const response = await fetch(currentUrl, {
      method: currentMethod,
      headers,
      body: currentBody,
      redirect: "manual",
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });

    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    const location = response.headers.get("location");
    if (!location) {
      throw Object.assign(new Error("redirect"), { code: "REDIRECT" });
    }

    const nextUrl = new URL(location, currentUrl).toString();
    const currentOrigin = normalizeCloudSiteUrl(new URL(currentUrl).origin);
    const nextOrigin = normalizeCloudSiteUrl(new URL(nextUrl).origin);
    if (
      new URL(currentUrl).origin !== new URL(nextUrl).origin &&
      currentOrigin !== nextOrigin
    ) {
      throw Object.assign(new Error("redirect"), { code: "REDIRECT" });
    }

    currentUrl = nextUrl;
    if (
      currentMethod !== "GET" &&
      currentMethod !== "HEAD" &&
      (response.status === 301 ||
        response.status === 302 ||
        response.status === 303)
    ) {
      currentMethod = "GET";
      currentBody = undefined;
    }
  }

  throw Object.assign(new Error("redirect"), { code: "REDIRECT" });
}

async function readJsonResponse(response: Response): Promise<unknown> {
  return response.json().catch(async () => ({
    success: response.ok,
    error: await response.text().catch(() => "Billing request failed"),
  }));
}

function buildRedirectUrl(
  baseUrl: string,
  pathname: string,
  params: Record<string, string>,
): string {
  const url = new URL(pathname, `${baseUrl}/`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function normalizeCryptoNetwork(value: string | undefined): string | undefined {
  if (!value) return undefined;

  const normalized = value.trim().toUpperCase();
  switch (normalized) {
    case "BSC":
    case "BEP20":
      return "BEP20";
    case "ETH":
    case "ERC20":
      return "ERC20";
    case "MATIC":
    case "POLYGON":
      return "POLYGON";
    case "SOL":
    case "SOLANA":
      return "SOL";
    case "BASE":
      return "BASE";
    case "ARB":
    case "ARBITRUM":
      return "ARB";
    case "OP":
    case "OPTIMISM":
      return "OP";
    case "TRON":
    case "TRC20":
      return "TRC20";
    default:
      return undefined;
  }
}

function mapBillingSummary(
  payload: unknown,
  baseUrl: string,
  cryptoStatus: unknown,
): Record<string, unknown> {
  const source = isRecord(payload) ? payload : {};
  const organization = isRecord(source.organization) ? source.organization : {};
  const pricing = isRecord(source.pricing) ? source.pricing : {};
  const crypto = isRecord(cryptoStatus) ? cryptoStatus : {};
  const balance = readNumber(organization.creditBalance) ?? 0;

  return {
    success: source.success ?? true,
    balance,
    currency: "USD",
    topUpUrl: `${baseUrl}/dashboard/settings?tab=billing`,
    embeddedCheckoutEnabled: false,
    hostedCheckoutEnabled: true,
    cryptoEnabled:
      readBoolean(crypto.enabled) ?? readBoolean(pricing.x402Enabled) ?? false,
    low: balance < 2,
    critical: balance < 0.5,
    hasPaymentMethod: readBoolean(organization.hasPaymentMethod) ?? false,
    autoTopUpEnabled: readBoolean(organization.autoTopUpEnabled) ?? false,
    autoTopUpAmount: readNumber(organization.autoTopUpAmount),
    autoTopUpThreshold: readNumber(organization.autoTopUpThreshold),
    minimumTopUp: readNumber(pricing.minimumTopUp),
  };
}

function mapPaymentMethods(payload: unknown): Record<string, unknown> {
  const source = isRecord(payload) ? payload : {};
  const organization = isRecord(source.organization) ? source.organization : {};
  const hasPaymentMethod = readBoolean(organization.hasPaymentMethod) ?? false;

  return {
    success: true,
    data: hasPaymentMethod
      ? [
          {
            id: "stripe-default",
            type: "card",
            label: "Saved payment method",
            brand: "Card",
            isDefault: true,
          },
        ]
      : [],
  };
}

function mapBillingHistory(payload: unknown): Record<string, unknown> {
  const source = isRecord(payload) ? payload : {};
  const rawTransactions = Array.isArray(source.transactions)
    ? source.transactions
    : [];

  return {
    success: true,
    data: rawTransactions.filter(isRecord).map((item, index) => ({
      id: readString(item.id) ?? `txn-${index}`,
      kind: readString(item.type),
      provider: readString(item.stripe_payment_intent_id)
        ? "stripe"
        : undefined,
      status: (readNumber(item.amount) ?? 0) >= 0 ? "credited" : "usage",
      amount: readNumber(item.amount) ?? 0,
      currency: "USD",
      description: readString(item.description),
      createdAt: readString(item.created_at) ?? new Date().toISOString(),
    })),
    total: readNumber(source.total),
    period: source.period,
  };
}

function mapCheckoutResponse(payload: unknown): Record<string, unknown> {
  const source = isRecord(payload) ? payload : {};
  return {
    success: true,
    provider: "stripe",
    mode: "hosted",
    checkoutUrl: readString(source.url) ?? readString(source.checkoutUrl),
    sessionId: readString(source.sessionId),
  };
}

function mapCryptoQuoteResponse(
  payload: unknown,
  amountUsd: number,
  payCurrency: string,
  network: string | undefined,
): Record<string, unknown> {
  const source = isRecord(payload) ? payload : {};
  return {
    success: true,
    provider: "oxapay",
    invoiceId: readString(source.paymentId) ?? readString(source.trackId),
    trackId: readString(source.trackId),
    network,
    currency: payCurrency,
    amount: readString(source.creditsToAdd) ?? String(amountUsd),
    amountUsd,
    paymentLinkUrl: readString(source.payLink),
    expiresAt: readString(source.expiresAt),
  };
}

function parseJsonBody(body: string | undefined): Record<string, unknown> {
  if (!body) return {};
  const parsed = JSON.parse(body);
  return isRecord(parsed) ? parsed : {};
}

async function forwardSummary(
  baseUrl: string,
  headers: Record<string, string>,
): Promise<{ status: number; payload: Record<string, unknown> | unknown }> {
  const summaryResponse = await fetchUpstream(
    `${baseUrl}/api/v1/credits/summary`,
    "GET",
    headers,
    undefined,
  );
  const summaryPayload = await readJsonResponse(summaryResponse);
  if (!summaryResponse.ok) {
    return { status: summaryResponse.status, payload: summaryPayload };
  }

  // Fetch crypto/status only when summary succeeded; cache it across requests
  // so we don't burn a per-key rate-limit slot every time the dashboard
  // refreshes (it changes rarely).
  const cryptoPayload = (await fetchCryptoStatusCached(baseUrl, headers)) ?? {};

  return {
    status: summaryResponse.status,
    payload: mapBillingSummary(summaryPayload, baseUrl, cryptoPayload),
  };
}

/**
 * Wraps `sendJson` to also set the HTTP `Retry-After` header when the upstream
 * payload describes a rate-limit (status 429 + `retryAfter` in the body).
 * The body's `retryAfter` field is preserved for clients that read JSON.
 */
function sendJsonWithRetry(
  res: http.ServerResponse,
  payload: unknown,
  status: number,
): void {
  if (status === 429 && isRecord(payload)) {
    const retryAfter = readNumber(payload.retryAfter);
    if (retryAfter && retryAfter > 0) {
      res.setHeader("Retry-After", String(Math.ceil(retryAfter)));
    }
  }
  sendJson(res, payload, status);
}

function mirrorPaymentHeaders(
  res: http.ServerResponse,
  upstreamResponse: Response,
): void {
  for (const header of [
    "PAYMENT-REQUIRED",
    "Payment-Required",
    "PAYMENT-RESPONSE",
    "Payment-Response",
    "Access-Control-Expose-Headers",
  ]) {
    const value = upstreamResponse.headers.get(header);
    if (value) {
      res.setHeader(header, value);
    }
  }
}

function isAllowedAppMoneyPath(pathname: string): boolean {
  const appMoneyPath =
    /^\/api\/cloud\/billing\/apps\/[^/]+\/(charges|earnings|monetization)(?:\/|$)/;
  return appMoneyPath.test(pathname);
}

function mapBillingProxyPath(pathname: string): string | null {
  if (pathname === "/api/cloud/billing/x402") return "/api/v1/x402";
  if (pathname.startsWith("/api/cloud/billing/x402/")) {
    return pathname.replace("/api/cloud/billing/x402", "/api/v1/x402");
  }

  if (pathname === "/api/cloud/billing/app-credits") {
    return "/api/v1/app-credits";
  }
  if (pathname.startsWith("/api/cloud/billing/app-credits/")) {
    return pathname.replace(
      "/api/cloud/billing/app-credits",
      "/api/v1/app-credits",
    );
  }

  if (pathname === "/api/cloud/billing/affiliates") {
    return "/api/v1/affiliates";
  }
  if (pathname.startsWith("/api/cloud/billing/affiliates/")) {
    return pathname.replace(
      "/api/cloud/billing/affiliates",
      "/api/v1/affiliates",
    );
  }

  if (pathname === "/api/cloud/billing/redemptions") {
    return "/api/v1/redemptions";
  }
  if (pathname.startsWith("/api/cloud/billing/redemptions/")) {
    return pathname.replace(
      "/api/cloud/billing/redemptions",
      "/api/v1/redemptions",
    );
  }

  if (isAllowedAppMoneyPath(pathname)) {
    return pathname.replace("/api/cloud/billing/apps", "/api/v1/apps");
  }

  return null;
}

async function forwardBillingProxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  baseUrl: string,
  headers: Record<string, string>,
  upstreamPath: string,
  search: string,
): Promise<void> {
  let body: string | undefined;
  if (method !== "GET" && method !== "HEAD") {
    body = await readBody(req);
  }

  const upstreamResponse = await fetchUpstream(
    `${baseUrl}${upstreamPath}${search}`,
    method,
    headers,
    body,
  );
  const responseData = await readJsonResponse(upstreamResponse);
  mirrorPaymentHeaders(res, upstreamResponse);
  sendJsonWithRetry(res, responseData, upstreamResponse.status);
}

export async function handleCloudBillingRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  state: CloudBillingRouteState,
): Promise<boolean> {
  if (!pathname.startsWith("/api/cloud/billing")) return false;

  const apiKey = resolveProxyApiKey(state);
  if (!apiKey) {
    sendJsonError(
      res,
      "Not connected to Eliza Cloud. Please log in first.",
      401,
    );
    return true;
  }

  const baseUrl = resolveCloudBaseUrl(state.config);
  const urlError = await validateCloudBaseUrl(baseUrl);
  if (urlError) {
    sendJsonError(res, urlError, 502);
    return true;
  }

  const headers = buildAuthHeaders(state.config, apiKey);

  const fullUrl = new URL(req.url ?? pathname, "http://localhost");
  const proxiedMoneyPath = mapBillingProxyPath(pathname);
  if (proxiedMoneyPath) {
    await forwardBillingProxy(
      req,
      res,
      method,
      baseUrl,
      headers,
      proxiedMoneyPath,
      fullUrl.search,
    );
    return true;
  }

  if (pathname === "/api/cloud/billing/summary" && method === "GET") {
    const { status, payload } = await forwardSummary(baseUrl, headers);
    sendJsonWithRetry(res, payload, status);
    return true;
  }

  if (pathname === "/api/cloud/billing/payment-methods" && method === "GET") {
    const summaryResponse = await fetchUpstream(
      `${baseUrl}/api/v1/credits/summary`,
      "GET",
      headers,
      undefined,
    );
    const summaryPayload = await readJsonResponse(summaryResponse);
    sendJsonWithRetry(
      res,
      summaryResponse.ok ? mapPaymentMethods(summaryPayload) : summaryPayload,
      summaryResponse.status,
    );
    return true;
  }

  if (pathname === "/api/cloud/billing/history" && method === "GET") {
    const upstreamUrl = `${baseUrl}/api/credits/transactions${fullUrl.search}`;
    const historyResponse = await fetchUpstream(
      upstreamUrl,
      "GET",
      headers,
      undefined,
    );
    const historyPayload = await readJsonResponse(historyResponse);
    sendJsonWithRetry(
      res,
      historyResponse.ok ? mapBillingHistory(historyPayload) : historyPayload,
      historyResponse.status,
    );
    return true;
  }

  if (pathname === "/api/cloud/billing/checkout" && method === "POST") {
    const body = await readBody(req);
    const requestBody = parseJsonBody(body);
    const amountUsd = readNumber(requestBody.amountUsd);

    if (!amountUsd || amountUsd <= 0) {
      sendJsonError(res, "Invalid top-up amount", 400);
      return true;
    }

    const upstreamBody = JSON.stringify({
      credits: amountUsd,
      success_url: buildRedirectUrl(baseUrl, "/dashboard/billing/success", {
        from: "eliza",
      }),
      cancel_url: buildRedirectUrl(baseUrl, "/dashboard/settings", {
        from: "eliza",
        tab: "billing",
        canceled: "1",
      }),
    });

    const checkoutResponse = await fetchUpstream(
      `${baseUrl}/api/v1/credits/checkout`,
      "POST",
      headers,
      upstreamBody,
    );
    const checkoutPayload = await readJsonResponse(checkoutResponse);
    sendJsonWithRetry(
      res,
      checkoutResponse.ok
        ? mapCheckoutResponse(checkoutPayload)
        : checkoutPayload,
      checkoutResponse.status,
    );
    return true;
  }

  if (pathname === "/api/cloud/billing/crypto/quote" && method === "POST") {
    const body = await readBody(req);
    const requestBody = parseJsonBody(body);
    const amountUsd = readNumber(requestBody.amountUsd);

    if (!amountUsd || amountUsd <= 0) {
      sendJsonError(res, "Invalid top-up amount", 400);
      return true;
    }

    const payCurrency =
      readString(requestBody.currency)?.trim().toUpperCase() ?? "USDC";
    const network = normalizeCryptoNetwork(readString(requestBody.network));
    const upstreamBody = JSON.stringify({
      amount: amountUsd,
      payCurrency,
      network,
    });

    const cryptoResponse = await fetchUpstream(
      `${baseUrl}/api/crypto/payments`,
      "POST",
      headers,
      upstreamBody,
    );
    const cryptoPayload = await readJsonResponse(cryptoResponse);
    sendJsonWithRetry(
      res,
      cryptoResponse.ok
        ? mapCryptoQuoteResponse(cryptoPayload, amountUsd, payCurrency, network)
        : cryptoPayload,
      cryptoResponse.status,
    );
    return true;
  }

  if (pathname.startsWith("/api/cloud/billing/credits/")) {
    let body: string | undefined;
    if (method !== "GET" && method !== "HEAD") {
      body = await readBody(req);
    }

    const upstreamPath = pathname.replace(
      "/api/cloud/billing/credits",
      "/api/v1/credits",
    );
    const upstreamResponse = await fetchUpstream(
      `${baseUrl}${upstreamPath}${fullUrl.search}`,
      method,
      headers,
      body,
    );
    const responseData = await readJsonResponse(upstreamResponse);
    sendJsonWithRetry(res, responseData, upstreamResponse.status);
    return true;
  }

  if (
    pathname.startsWith("/api/cloud/billing/crypto/") &&
    pathname !== "/api/cloud/billing/crypto/quote"
  ) {
    let body: string | undefined;
    if (method !== "GET" && method !== "HEAD") {
      body = await readBody(req);
    }

    const upstreamPath = pathname.replace(
      "/api/cloud/billing/crypto",
      "/api/crypto",
    );
    const upstreamResponse = await fetchUpstream(
      `${baseUrl}${upstreamPath}${fullUrl.search}`,
      method,
      headers,
      body,
    );
    const responseData = await readJsonResponse(upstreamResponse);
    sendJsonWithRetry(res, responseData, upstreamResponse.status);
    return true;
  }

  let body: string | undefined;
  if (method !== "GET" && method !== "HEAD") {
    body = await readBody(req);
  }

  const billingPath = pathname.replace("/api/cloud/billing", "/api/v1/billing");
  const upstreamResponse = await fetchUpstream(
    `${baseUrl}${billingPath}${fullUrl.search}`,
    method,
    headers,
    body,
  );
  const responseData = await readJsonResponse(upstreamResponse);
  sendJsonWithRetry(res, responseData, upstreamResponse.status);
  return true;
}
