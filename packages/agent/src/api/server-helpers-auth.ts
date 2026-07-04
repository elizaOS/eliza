/**
 * Auth, CORS, pairing, terminal, and WebSocket auth helpers extracted from server.ts.
 */

import crypto from "node:crypto";
import type http from "node:http";
import { logger } from "@elizaos/core";
import {
  isCloudProvisionedContainer,
  isLoopbackBindHost,
  isNullOriginAllowed,
  isTrustedLocalRequest as isTrustedLocalRequestShared,
  isWildcardBindHost,
  resolveAllowedHosts,
  resolveAllowedOrigins,
  resolveApiBindHost,
  resolveApiSecurityConfig,
  resolveApiToken,
  setApiToken,
  stripOptionalHostPort,
} from "@elizaos/shared";
import { sweepExpiredEntries } from "./memory-bounds.ts";

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

const LOCAL_ORIGIN_RE =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|\[0:0:0:0:0:0:0:1\])(:\d+)?$/i;
const APP_ORIGIN_RE =
  /^(capacitor|capacitor-electron|app|tauri|file|electrobun):\/\/.*$/i;

export const CORS_ALLOWED_HEADERS = [
  "Content-Type",
  "Authorization",
  "X-API-Token",
  "X-Api-Key",
  "X-Eliza-Token",
  "X-ElizaOS-Token",
  "X-Server-Token",
  "X-Waifu-Chat-Access-Token",
  "X-Eliza-Export-Token",
  "X-Eliza-Client-Id",
  "X-ElizaOS-Client-Id",
  "X-Eliza-Terminal-Token",
  "X-Eliza-Platform",
  "X-Eliza-UI-Language",
  "X-ElizaOS-UI-Language",
  "X-Browser-Bridge-Companion-Id",
  "X-Eliza-Browser-Companion-Id",
  "X-Eliza-CSRF",
  "X-Server-Token",
].join(", ");

/**
 * Hostname allowlist for DNS rebinding protection.
 * Requests with a Host header that doesn't match a known loopback name are
 * rejected before CORS / auth processing.  This prevents a malicious page
 * from rebinding its DNS to 127.0.0.1 and reading the unauthenticated API.
 */
const LOCAL_HOST_RE =
  /^(localhost|127\.0\.0\.1|\[?::1\]?|\[?0:0:0:0:0:0:0:1\]?|::ffff:127\.0\.0\.1)$/;

/** Wildcard bind addresses that listen on all interfaces. */
const WILDCARD_BIND_RE = /^(0\.0\.0\.0|::|0:0:0:0:0:0:0:0)$/;

export function isAllowedHost(req: http.IncomingMessage): boolean {
  const raw = req.headers.host;
  if (!raw) return true; // No Host header -> non-browser client (e.g. curl)

  let hostname: string;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return true;

  if (trimmed.startsWith("[")) {
    // Bracketed IPv6: [::1]:31337 -> ::1
    const close = trimmed.indexOf("]");
    hostname = close > 0 ? trimmed.slice(1, close) : trimmed.slice(1);
  } else if ((trimmed.match(/:/g) || []).length >= 2) {
    // Bare IPv6 (multiple colons, no brackets): ::1 -> ::1
    hostname = trimmed;
  } else {
    // IPv4 or hostname: localhost:31337 -> localhost
    hostname = stripOptionalHostPort(trimmed);
  }

  if (!hostname) return true;

  const bindHost = resolveApiBindHost(process.env).toLowerCase();

  // When binding on all interfaces (0.0.0.0 / ::), any Host is acceptable --
  // ensureApiTokenForBindHost already enforces a token for non-loopback binds.
  if (WILDCARD_BIND_RE.test(stripOptionalHostPort(bindHost))) {
    return true;
  }

  // Allow the exact configured bind hostname.
  if (bindHost && hostname === stripOptionalHostPort(bindHost)) {
    return true;
  }

  for (const allowedHost of resolveAllowedHosts(process.env)) {
    if (stripOptionalHostPort(allowedHost).toLowerCase() === hostname) {
      return true;
    }
  }

  return LOCAL_HOST_RE.test(hostname);
}

export function resolveCorsOrigin(origin?: string): string | null {
  if (!origin) return null;
  const trimmed = origin.trim();
  if (!trimmed) return null;

  // Cloud-provisioned containers default to allowing all origins so the
  // browser web UI can reach the agent API without extra config.
  if (process.env.ELIZA_CLOUD_PROVISIONED === "1") {
    return trimmed;
  }

  // When bound to a wildcard address, allow any origin. Non-loopback binds still
  // require an explicit token, so this only relaxes the browser origin check.
  const bindHost = resolveApiBindHost(process.env).toLowerCase();
  if (WILDCARD_BIND_RE.test(stripOptionalHostPort(bindHost))) return trimmed;

  // Explicit allowlist via env (comma-separated)
  const allow = resolveAllowedOrigins(process.env);
  if (allow.includes(trimmed)) {
    return trimmed;
  }

  if (isWaifuHostedChatOrigin(trimmed)) return trimmed;
  if (LOCAL_ORIGIN_RE.test(trimmed)) return trimmed;
  if (APP_ORIGIN_RE.test(trimmed)) return trimmed;
  if (trimmed === "null" || trimmed === "file://") {
    if (isNullOriginAllowed(process.env)) {
      return "null";
    }
  }
  return null;
}

function isBrowserCompanionExtensionOrigin(
  origin: string | undefined,
): boolean {
  if (!origin) {
    return false;
  }
  const trimmed = origin.trim();
  return (
    /^chrome-extension:\/\/[a-z]{32}$/i.test(trimmed) ||
    /^moz-extension:\/\/[0-9a-f-]+$/i.test(trimmed) ||
    /^safari-web-extension:\/\/[A-Za-z0-9.-]+$/i.test(trimmed)
  );
}

function resolveWaifuFrameAncestors(): string | null {
  if (!process.env.WAIFU_CHAT_ACCESS_JWT_SECRET?.trim()) return null;
  const configured = process.env.WAIFU_CHAT_FRAME_ANCESTORS?.trim();
  if (configured) return configured;
  return "https://waifu.fun https://*.waifu.fun";
}

function isWaifuHostedChatOrigin(origin: string): boolean {
  if (!process.env.WAIFU_CHAT_ACCESS_JWT_SECRET?.trim()) return false;
  try {
    const parsed = new URL(origin);
    return (
      parsed.protocol === "https:" &&
      (parsed.hostname === "waifu.fun" ||
        parsed.hostname.endsWith(".waifu.fun"))
    );
  } catch {
    return false;
  }
}

export function applyCors(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): boolean {
  const origin =
    typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  const allowBrowserCompanionOrigin =
    pathname.startsWith("/api/browser-bridge/companions/") &&
    isBrowserCompanionExtensionOrigin(origin);
  const allowed = allowBrowserCompanionOrigin
    ? (origin?.trim() ?? null)
    : resolveCorsOrigin(origin);

  if (origin && !allowed) return false;

  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", allowed);
    res.setHeader("Vary", "Origin");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    );
    res.setHeader("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }

  // Security headers
  res.setHeader("X-Content-Type-Options", "nosniff");
  const waifuFrameAncestors = resolveWaifuFrameAncestors();
  if (waifuFrameAncestors) {
    res.setHeader(
      "Content-Security-Policy",
      `frame-ancestors ${waifuFrameAncestors}`,
    );
  } else {
    res.setHeader("X-Frame-Options", "DENY");
  }
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  return true;
}

// ---------------------------------------------------------------------------
// Auth token
// ---------------------------------------------------------------------------

function tokenMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function getConfiguredApiToken(): string | undefined {
  return resolveApiToken(process.env) ?? undefined;
}

/**
 * Extract an API token from an SSE handshake's query string.
 *
 * EventSource cannot set request headers, so browser SSE clients have no way
 * to send `Authorization: Bearer …`. Cloud already opts in to `?token=` for
 * the WebSocket path via `ELIZA_ALLOW_WS_QUERY_TOKEN=1`; this mirrors that
 * trust model for SSE GETs while keeping the gate tightly scoped:
 *  - same env flag (cloud-only, never silently enabled elsewhere),
 *  - method must be GET (read-only),
 *  - `Accept` must include `text/event-stream` so JSON endpoints with a stray
 *    `?token=` cannot bypass the header path or leak via proxy access logs.
 * The returned token is still validated by `tokenMatches` against
 * `getConfiguredApiToken()` — same crypto.timingSafeEqual path as Bearer.
 */
function extractSseQueryToken(req: http.IncomingMessage): string | null {
  if (process.env.ELIZA_ALLOW_WS_QUERY_TOKEN !== "1") return null;
  if ((req.method ?? "GET").toUpperCase() !== "GET") return null;
  const accept = firstHeaderValue(req.headers.accept) ?? "";
  if (!accept.toLowerCase().includes("text/event-stream")) return null;
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const raw =
      url.searchParams.get("token") ??
      url.searchParams.get("apiKey") ??
      url.searchParams.get("api_key");
    const trimmed = raw?.trim();
    return trimmed && trimmed.length <= 1024 ? trimmed : null;
  } catch {
    return null;
  }
}

export function extractAuthToken(req: http.IncomingMessage): string | null {
  const rawAuth =
    typeof req.headers.authorization === "string"
      ? req.headers.authorization
      : "";
  const auth =
    rawAuth.length > 8192 ? rawAuth.slice(0, 8192).trim() : rawAuth.trim();
  if (
    auth &&
    auth.length >= 7 &&
    auth.slice(0, 7).toLowerCase() === "bearer "
  ) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }

  const header =
    (typeof req.headers["x-eliza-token"] === "string" &&
      req.headers["x-eliza-token"]) ||
    (typeof req.headers["x-elizaos-token"] === "string" &&
      req.headers["x-elizaos-token"]) ||
    (typeof req.headers["x-waifu-chat-access-token"] === "string" &&
      req.headers["x-waifu-chat-access-token"]) ||
    (typeof req.headers["x-api-key"] === "string" && req.headers["x-api-key"]);
  if (typeof header === "string" && header.trim()) return header.trim();

  const sseToken = extractSseQueryToken(req);
  if (sseToken) return sseToken;

  return null;
}

export type WaifuChatRole = "admin" | "user" | "guest";
export type WaifuChatWorldRole = "OWNER" | "USER" | "GUEST";

export function waifuChatRoleToWorldRole(
  role: WaifuChatRole,
): WaifuChatWorldRole {
  if (role === "admin") return "OWNER";
  if (role === "user") return "USER";
  return "GUEST";
}

export interface WaifuChatAccess {
  role: WaifuChatRole;
  walletAddress: string;
  tokenAddress?: string;
  chainId?: number;
  cloudAgentId?: string;
  balanceTokens?: number | null;
}

function base64UrlDecode(input: string): Buffer | null {
  try {
    const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
    return Buffer.from(normalized + padding, "base64");
  } catch {
    return null;
  }
}

function readJsonSegment(segment: string): Record<string, unknown> | null {
  const decoded = base64UrlDecode(segment);
  if (!decoded) return null;
  try {
    const parsed = JSON.parse(decoded.toString("utf8"));
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function timingSafeJwtSignatureMatches(
  signingInput: string,
  signatureSegment: string,
  secret: string,
): boolean {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64url");
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(signatureSegment, "utf8");
  return (
    expectedBytes.length === actualBytes.length &&
    crypto.timingSafeEqual(expectedBytes, actualBytes)
  );
}

export function resolveWaifuChatAccessToken(
  token: string | null | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): WaifuChatAccess | null {
  const secret = process.env.WAIFU_CHAT_ACCESS_JWT_SECRET?.trim();
  if (!secret || !token) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerSegment, payloadSegment, signatureSegment] = parts;
  if (!headerSegment || !payloadSegment || !signatureSegment) return null;

  const header = readJsonSegment(headerSegment);
  if (header?.alg !== "HS256") return null;
  const signingInput = `${headerSegment}.${payloadSegment}`;
  if (!timingSafeJwtSignatureMatches(signingInput, signatureSegment, secret)) {
    return null;
  }

  const payload = readJsonSegment(payloadSegment);
  if (!payload) return null;
  if (payload.iss !== "waifu.fun") return null;
  const aud = payload.aud;
  if (
    aud !== "eliza-cloud-chat" &&
    !(Array.isArray(aud) && aud.includes("eliza-cloud-chat"))
  ) {
    return null;
  }
  if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) {
    return null;
  }
  if (typeof payload.nbf === "number" && payload.nbf > nowSeconds) {
    return null;
  }

  const role = typeof payload.role === "string" ? payload.role : "";
  if (role !== "admin" && role !== "user" && role !== "guest") {
    return null;
  }
  const walletAddress =
    typeof payload.walletAddress === "string" && payload.walletAddress.trim()
      ? payload.walletAddress.trim()
      : typeof payload.sub === "string" && payload.sub.trim()
        ? payload.sub.trim()
        : "";
  if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) return null;
  const tokenAddress =
    typeof payload.tokenAddress === "string" ? payload.tokenAddress : undefined;
  const expectedTokenAddress = process.env.TOKEN_CONTRACT_ADDRESS?.trim();
  if (
    expectedTokenAddress &&
    tokenAddress?.toLowerCase() !== expectedTokenAddress.toLowerCase()
  ) {
    return null;
  }
  const chainId =
    typeof payload.chainId === "number" ? payload.chainId : undefined;
  const expectedChainId = process.env.TOKEN_CHAIN_ID?.trim();
  if (expectedChainId && String(chainId ?? "") !== expectedChainId) {
    return null;
  }
  const cloudAgentId =
    typeof payload.cloudAgentId === "string" ? payload.cloudAgentId : undefined;
  const expectedCloudAgentId = (
    process.env.WAIFU_ELIZA_CLOUD_AGENT_ID ??
    process.env.ELIZA_CLOUD_AGENT_ID ??
    ""
  ).trim();
  if (expectedCloudAgentId && cloudAgentId !== expectedCloudAgentId) {
    return null;
  }

  return {
    role,
    walletAddress,
    ...(tokenAddress ? { tokenAddress } : {}),
    ...(chainId !== undefined ? { chainId } : {}),
    ...(cloudAgentId ? { cloudAgentId } : {}),
    ...(typeof payload.balanceTokens === "number" ||
    payload.balanceTokens === null
      ? { balanceTokens: payload.balanceTokens as number | null }
      : {}),
  };
}

export function resolveWaifuChatAccess(
  req: http.IncomingMessage,
): WaifuChatAccess | null {
  return resolveWaifuChatAccessToken(extractAuthToken(req));
}

function isWaifuChatScopedRoute(method: string, pathname: string): boolean {
  if (pathname === "/api/health") return method === "GET";
  if (pathname === "/api/agents") return method === "GET";
  if (pathname === "/api/auth/status") return method === "GET";
  if (pathname === "/api/runtime-mode") return method === "GET";
  if (pathname === "/api/conversations") {
    return method === "GET" || method === "POST";
  }
  if (/^\/api\/conversations\/[^/]+\/messages$/.test(pathname)) {
    return method === "GET" || method === "POST";
  }
  if (/^\/api\/conversations\/[^/]+\/messages\/stream$/.test(pathname)) {
    return method === "POST";
  }
  if (/^\/api\/conversations\/[^/]+\/greeting$/.test(pathname)) {
    return method === "POST";
  }
  return false;
}

export function isWaifuChatAuthorized(
  req: http.IncomingMessage,
  method: string,
  pathname: string,
): boolean {
  const access = resolveWaifuChatAccess(req);
  if (!access) return false;
  if (access.role === "admin") return true;
  return isWaifuChatScopedRoute(method.toUpperCase(), pathname);
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

/**
 * Same-machine dashboard trust for the agent server. Delegates to the canonical
 * `@elizaos/shared` parser with the agent's exact policy gates:
 *  - cloudCheck "container": `isCloudProvisionedContainer()` (the flag AND a
 *    provisioning token), NOT the raw `ELIZA_CLOUD_PROVISIONED` flag.
 *  - requireLocalAuthEnv: on-device local agents (Android) set
 *    `ELIZA_REQUIRE_LOCAL_AUTH=1` alongside a per-boot `ELIZA_API_TOKEN`, so
 *    loopback alone is not a trust signal there.
 *  - NO dev-auth bypass: the agent never honours `ELIZA_DEV_AUTH_BYPASS`.
 */
export function isTrustedLocalRequest(req: http.IncomingMessage): boolean {
  return isTrustedLocalRequestShared(req, {
    requireLocalAuthEnv: true,
    devAuthBypassEnv: false,
    cloudCheck: "container",
  });
}

/**
 * Resolve the shared service-to-service secret used by the cloud gateways to
 * authenticate inbound forwards to this container. The Discord / webhook
 * gateways attach this value as the `X-Server-Token` header on
 * `POST /agents/:id/message` (see gateway-discord `forwardToServer`). It is the
 * same contract the Kubernetes `agent-server` honours; mirroring it here lets a
 * provisioned container accept gateway-routed messages without the gateway
 * having to know the per-agent inbound API token.
 *
 * Returns an empty string when unconfigured, in which case the X-Server-Token
 * path is disabled and existing Bearer / loopback auth is unaffected.
 *
 * Security: a matching `X-Server-Token` grants full authority (`isAuthorized`),
 * so this secret is a bearer credential — it MUST be a high-entropy random
 * value of at least 32 bytes (≥256 bits; e.g. `openssl rand -hex 32`). Never a
 * human-chosen or dictionary string. The comparison is timing-safe
 * (`tokenMatches`), but that does not protect a low-entropy secret from being
 * guessed offline; entropy is the only defense here. (#12228 L11)
 */
function getServerSharedSecret(): string {
  const raw = process.env.AGENT_SERVER_SHARED_SECRET;
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Extract the `X-Server-Token` header value, if present and non-empty.
 */
function extractServerToken(req: http.IncomingMessage): string | null {
  const value = req.headers["x-server-token"];
  const token = firstHeaderValue(value);
  const trimmed = token?.trim();
  return trimmed ? trimmed : null;
}

/**
 * True when the request carries a valid `X-Server-Token` matching the
 * configured `AGENT_SERVER_SHARED_SECRET`. When the secret is unset this always
 * returns false, so the header carries no authority and there is no regression
 * for deployments that never configure it.
 */
export function isServerTokenAuthorized(req: http.IncomingMessage): boolean {
  const expected = getServerSharedSecret();
  if (!expected) return false;
  const provided = extractServerToken(req);
  if (!provided) return false;
  return tokenMatches(expected, provided);
}

export function isAuthorized(req: http.IncomingMessage): boolean {
  if (isTrustedLocalRequest(req)) return true;

  // Accept the cloud gateway's shared service token first (mirrors the K8s
  // agent-server contract). Disabled automatically when the secret is unset.
  if (isServerTokenAuthorized(req)) return true;

  const expected = getConfiguredApiToken();
  if (!expected) return false;
  const provided = extractAuthToken(req);
  if (!provided) return false;
  return tokenMatches(expected, provided);
}

/** The canonical role at the agent HTTP boundary (#9948 / #12087 Item 13). */
export type BoundaryRole = "OWNER" | "GUEST";

/**
 * #12087 Item 13: the single token→role collapse for agent HTTP routes. An
 * authorized caller (trusted loopback owner or a valid API token) is the OWNER
 * principal; everyone else is GUEST — the server-authoritative unauthenticated
 * tier (#9948). Routes must use this instead of re-deriving `isAuthorized(req) ?
 * "OWNER" : "GUEST"` inline (which drifted to NONE elsewhere). app-core's
 * resolveBoundaryRole is deliberately not importable from the agent, so this is
 * the agent-local equivalent with the same OWNER/GUEST vocabulary.
 */
export function resolveBoundaryRole(req: http.IncomingMessage): BoundaryRole {
  return isAuthorized(req) ? "OWNER" : "GUEST";
}

export function ensureApiTokenForBindHost(host: string): void {
  const { disableAutoApiToken } = resolveApiSecurityConfig(process.env);

  const token = getConfiguredApiToken();
  if (token) return;

  const cloudProvisioned = isCloudProvisionedContainer();
  const wildcardBind = isWildcardBindHost(host);

  // M7 (#12228): a wildcard bind (0.0.0.0 / ::) relaxes both the DNS-rebind
  // Host check (`hostAllowed`) and the CORS origin check (`resolveCorsOrigin`
  // reflects any origin with credentials). With ELIZA_DISABLE_AUTO_API_TOKEN=1
  // and no explicit ELIZA_API_TOKEN that leaves the server listening on every
  // interface with *no* authenticated boundary and both browser-origin
  // protections off — silently wide open. Refuse to honor the disable flag in
  // that exact combo: force a generated token so a real auth boundary exists.
  // (A specific non-loopback IP bind keeps Host+CORS enforced, so the disable
  // flag is still honored there.)
  const forceTokenForWildcard = wildcardBind && disableAutoApiToken;

  // Cloud-provisioned containers must never run without an inbound API token
  // (isAuthorized rejects all requests when no token + cloud flag is set).
  // Override the disable flag for cloud containers so they always get a
  // fallback token rather than dead-locking into 401 on every request.
  if (disableAutoApiToken && !cloudProvisioned && !forceTokenForWildcard) {
    return;
  }
  if (forceTokenForWildcard) {
    logger.warn(
      `[eliza-api] ELIZA_API_BIND=${host} is a wildcard bind and ELIZA_DISABLE_AUTO_API_TOKEN is set with no ELIZA_API_TOKEN. Refusing to start without an authenticated boundary: forcing a generated API token. DNS-rebind + CORS checks stay relaxed for wildcard binds, so this token is the only boundary. Set ELIZA_API_TOKEN explicitly, or bind to 127.0.0.1, to override.`,
    );
  }
  if (!cloudProvisioned && !forceTokenForWildcard && isLoopbackBindHost(host))
    return;

  const generated = crypto.randomBytes(32).toString("hex");
  setApiToken(process.env, generated);

  if (cloudProvisioned) {
    logger.warn(
      "[eliza-api] Steward-managed cloud container started without ELIZA_API_TOKEN; generated a temporary inbound API token for this process.",
    );
  } else {
    logger.warn(
      `[eliza-api] ELIZA_API_BIND=${host} is non-loopback and ELIZA_API_TOKEN is unset.`,
    );
  }
  const tokenFingerprint = `${generated.slice(0, 4)}...${generated.slice(-4)}`;
  logger.warn(
    `[eliza-api] Generated temporary API token (${tokenFingerprint}) for this process. Set ELIZA_API_TOKEN explicitly to override.`,
  );
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

const PAIRING_TTL_MS = 10 * 60 * 1000;
const PAIRING_WINDOW_MS = 10 * 60 * 1000;
const PAIRING_MAX_ATTEMPTS = 5;
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

let pairingCode: string | null = null;
let pairingExpiresAt = 0;
const pairingAttempts = new Map<string, { count: number; resetAt: number }>();

export function pairingEnabled(): boolean {
  return (
    Boolean(getConfiguredApiToken()) &&
    process.env.ELIZA_PAIRING_DISABLED !== "1"
  );
}

export function normalizePairingCode(code: string): string {
  return code.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function generatePairingCode(): string {
  let raw = "";
  for (let i = 0; i < 8; i++) {
    raw += PAIRING_ALPHABET[crypto.randomInt(0, PAIRING_ALPHABET.length)];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

export function ensurePairingCode(): string | null {
  if (!pairingEnabled()) return null;
  const now = Date.now();
  if (!pairingCode || now > pairingExpiresAt) {
    pairingCode = generatePairingCode();
    pairingExpiresAt = now + PAIRING_TTL_MS;
    logger.warn(
      `[eliza-api] Pairing code: ${pairingCode} (valid for 10 minutes)`,
    );
  }
  return pairingCode;
}

export function rateLimitPairing(ip: string | null): boolean {
  const key = ip ?? "unknown";
  const now = Date.now();

  // Lazy sweep: evict expired entries when map grows beyond 100
  sweepExpiredEntries(pairingAttempts, now, 100);

  const current = pairingAttempts.get(key);
  if (!current || now > current.resetAt) {
    pairingAttempts.set(key, { count: 1, resetAt: now + PAIRING_WINDOW_MS });
    return true;
  }
  if (current.count >= PAIRING_MAX_ATTEMPTS) return false;
  current.count += 1;
  return true;
}

export function getPairingExpiresAt(): number {
  return pairingExpiresAt;
}

export function clearPairing(): void {
  pairingCode = null;
  pairingExpiresAt = 0;
}

// ---------------------------------------------------------------------------
// WebSocket client ID
// ---------------------------------------------------------------------------

const SAFE_WS_CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function normalizeWsClientId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!SAFE_WS_CLIENT_ID_RE.test(trimmed)) return null;
  return trimmed;
}

export function resolveTerminalRunClientId(
  req: Pick<http.IncomingMessage, "headers">,
  body: { clientId?: unknown } | null | undefined,
): string | null {
  const headerClientId = normalizeWsClientId(
    firstHeaderValue(req.headers["x-eliza-client-id"]),
  );
  if (headerClientId) return headerClientId;
  return normalizeWsClientId(body?.clientId);
}

const SHARED_TERMINAL_CLIENT_IDS = new Set([
  "runtime-terminal-action",
  "runtime-shell-action",
]);

export function isSharedTerminalClientId(clientId: string): boolean {
  return SHARED_TERMINAL_CLIENT_IDS.has(clientId);
}

// ---------------------------------------------------------------------------
// Terminal run rejection
// ---------------------------------------------------------------------------

interface TerminalRunRequestBody {
  terminalToken?: string;
}

export interface TerminalRunRejection {
  status: 401 | 403;
  reason: string;
}

export function resolveTerminalRunRejection(
  req: http.IncomingMessage,
  body: TerminalRunRequestBody,
): TerminalRunRejection | null {
  const expected = process.env.ELIZA_TERMINAL_RUN_TOKEN?.trim();
  const apiTokenEnabled = Boolean(getConfiguredApiToken());

  // Compatibility mode: local loopback sessions without API token keep
  // existing behavior unless an explicit terminal token is configured.
  if (!expected && !apiTokenEnabled) {
    return null;
  }

  if (!expected) {
    return {
      status: 403,
      reason:
        "Terminal run is disabled for token-authenticated API sessions. Set ELIZA_TERMINAL_RUN_TOKEN to enable command execution.",
    };
  }

  const headerToken =
    typeof req.headers["x-eliza-terminal-token"] === "string"
      ? req.headers["x-eliza-terminal-token"].trim()
      : "";
  const bodyToken =
    typeof body.terminalToken === "string" ? body.terminalToken.trim() : "";
  const provided = headerToken || bodyToken;

  if (!provided) {
    return {
      status: 401,
      reason:
        "Missing terminal token. Provide X-Eliza-Terminal-Token header or terminalToken in request body.",
    };
  }

  if (!tokenMatches(expected, provided)) {
    return {
      status: 401,
      reason: "Invalid terminal token.",
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// WebSocket upgrade
// ---------------------------------------------------------------------------

function extractWsQueryToken(url: URL): string | null {
  const allowQueryToken = process.env.ELIZA_ALLOW_WS_QUERY_TOKEN === "1";
  if (!allowQueryToken) return null;

  const token =
    url.searchParams.get("token") ??
    url.searchParams.get("apiKey") ??
    url.searchParams.get("api_key");
  return token?.trim() || null;
}

function extractWebSocketHandshakeToken(
  request: http.IncomingMessage,
  url: URL,
): string | null {
  const headerToken = extractAuthToken(request);
  if (headerToken) return headerToken;
  return extractWsQueryToken(url);
}

export function isWebSocketAuthorized(
  request: http.IncomingMessage,
  url: URL,
): boolean {
  const expected = getConfiguredApiToken();
  if (!expected) {
    return !isCloudProvisionedContainer() && isTrustedLocalRequest(request);
  }

  const handshakeToken = extractWebSocketHandshakeToken(request, url);
  if (!handshakeToken) return false;
  return tokenMatches(expected, handshakeToken);
}

export interface WebSocketUpgradeRejection {
  status: 401 | 403 | 404;
  reason: string;
}

export function resolveWebSocketUpgradeRejection(
  req: http.IncomingMessage,
  wsUrl: URL,
): WebSocketUpgradeRejection | null {
  if (wsUrl.pathname !== "/ws") {
    return { status: 404, reason: "Not found" };
  }

  const origin =
    typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  const allowedOrigin = resolveCorsOrigin(origin);
  if (origin && !allowedOrigin) {
    return { status: 403, reason: "Origin not allowed" };
  }

  const expected = getConfiguredApiToken();
  if (!expected) {
    return !isCloudProvisionedContainer() && isTrustedLocalRequest(req)
      ? null
      : { status: 401, reason: "Unauthorized" };
  }

  // Note: we used to reject upgrades when a query token was present but
  // ELIZA_ALLOW_WS_QUERY_TOKEN was not "1". That veto was actively harmful —
  // browsers cannot set Authorization on `new WebSocket(url)`, so SPAs have no
  // option but to pass the token in the URL. extractWsQueryToken() already
  // returns null when the flag is off, so handshakeToken simply falls through
  // to header-or-null and the post-open `{type:"auth"}` fallback covers
  // self-hosted setups behind header-aware upstream proxies.

  const handshakeToken = extractWebSocketHandshakeToken(req, wsUrl);
  if (handshakeToken && !tokenMatches(expected, handshakeToken)) {
    return { status: 401, reason: "Unauthorized" };
  }

  // Cloud containers must authenticate at the handshake level because there is
  // no trusted upstream proxy handling auth for the WebSocket path.
  if (!handshakeToken && isCloudProvisionedContainer()) {
    return { status: 401, reason: "Unauthorized" };
  }

  return null;
}

export function rejectWebSocketUpgrade(
  socket: import("node:stream").Duplex,
  statusCode: number,
  message: string,
): void {
  const statusText =
    statusCode === 401
      ? "Unauthorized"
      : statusCode === 403
        ? "Forbidden"
        : statusCode === 404
          ? "Not Found"
          : "Bad Request";
  const body = `${message}\n`;
  socket.write(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "\r\n" +
      body,
    () => socket.end(),
  );
}
