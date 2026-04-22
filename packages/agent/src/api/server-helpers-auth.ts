/**
 * Auth, CORS, pairing, terminal, and WebSocket auth helpers extracted from server.ts.
 */

import crypto from "node:crypto";
import type http from "node:http";
import {
  isNullOriginAllowed,
  resolveAllowedHosts,
  resolveAllowedOrigins,
  resolveApiBindHost,
  resolveApiSecurityConfig,
  resolveApiToken,
  setApiToken,
  stripOptionalHostPort,
} from "@elizaos/shared/runtime-env";
import { isCloudProvisionedContainer } from "./cloud-provisioning.js";
import { sweepExpiredEntries } from "./memory-bounds.js";

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

const LOCAL_ORIGIN_RE =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|\[0:0:0:0:0:0:0:1\])(:\d+)?$/i;
const APP_ORIGIN_RE =
  /^(capacitor|capacitor-electron|app|tauri|file|electrobun):\/\/.*$/i;

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
      "GET, POST, PUT, DELETE, OPTIONS",
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Eliza-Token, X-Api-Key, X-Eliza-Export-Token, X-Eliza-Client-Id, X-Eliza-Terminal-Token, X-Eliza-UI-Language, X-Browser-Bridge-Companion-Id, X-Eliza-Browser-Companion-Id",
    );
  }

  // Security headers
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
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

export function extractAuthToken(req: http.IncomingMessage): string | null {
  const auth =
    typeof req.headers.authorization === "string"
      ? req.headers.authorization.trim()
      : "";
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    if (match?.[1]) return match[1].trim();
  }

  const header =
    (typeof req.headers["x-eliza-token"] === "string" &&
      req.headers["x-eliza-token"]) ||
    (typeof req.headers["x-eliza-token"] === "string" &&
      req.headers["x-eliza-token"]) ||
    (typeof req.headers["x-api-key"] === "string" && req.headers["x-api-key"]);
  if (typeof header === "string" && header.trim()) return header.trim();

  return null;
}

export function isAuthorized(req: http.IncomingMessage): boolean {
  const expected = getConfiguredApiToken();
  if (!expected) return !isCloudProvisionedContainer();
  const provided = extractAuthToken(req);
  if (!provided) return false;
  return tokenMatches(expected, provided);
}

function isLoopbackBindHost(host: string): boolean {
  let normalized = host.trim().toLowerCase();

  if (!normalized) return true;

  // Allow users to provide full URLs by mistake (e.g. http://localhost:2138)
  if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
    try {
      const parsed = new URL(normalized);
      normalized = parsed.hostname.toLowerCase();
    } catch {
      // Fall through and parse as raw host value.
    }
  }

  // [::1]:2138 -> ::1
  const bracketedIpv6 = /^\[([^\]]+)\](?::\d+)?$/.exec(normalized);
  if (bracketedIpv6?.[1]) {
    normalized = bracketedIpv6[1];
  } else {
    // localhost:2138 -> localhost, 127.0.0.1:2138 -> 127.0.0.1
    const singleColonHostPort = /^([^:]+):(\d+)$/.exec(normalized);
    if (singleColonHostPort?.[1]) {
      normalized = singleColonHostPort[1];
    }
  }

  normalized = normalized.replace(/^\[|\]$/g, "");
  if (!normalized) return true;
  if (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized === "::ffff:127.0.0.1"
  ) {
    return true;
  }
  if (normalized.startsWith("127.")) return true;
  return false;
}

export function ensureApiTokenForBindHost(host: string): void {
  const { disableAutoApiToken } = resolveApiSecurityConfig(process.env);

  const token = getConfiguredApiToken();
  if (token) return;

  const cloudProvisioned = isCloudProvisionedContainer();

  // Cloud-provisioned containers must never run without an inbound API token
  // (isAuthorized rejects all requests when no token + cloud flag is set).
  // Override the disable flag for cloud containers so they always get a
  // fallback token rather than dead-locking into 401 on every request.
  if (disableAutoApiToken && !cloudProvisioned) {
    return;
  }
  if (!cloudProvisioned && isLoopbackBindHost(host)) return;

  const generated = crypto.randomBytes(32).toString("hex");
  setApiToken(process.env, generated);

  if (cloudProvisioned) {
    console.warn(
      "[eliza-api] Steward-managed cloud container started without ELIZA_API_TOKEN/ELIZA_API_TOKEN; generated a temporary inbound API token for this process.",
    );
  } else {
    console.warn(
      `[eliza-api] ELIZA_API_BIND/ELIZA_API_BIND=${host} is non-loopback and ELIZA_API_TOKEN/ELIZA_API_TOKEN is unset.`,
    );
  }
  const tokenFingerprint = `${generated.slice(0, 4)}...${generated.slice(-4)}`;
  console.warn(
    `[eliza-api] Generated temporary API token (${tokenFingerprint}) for this process. Set ELIZA_API_TOKEN or ELIZA_API_TOKEN explicitly to override.`,
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
  const bytes = crypto.randomBytes(8);
  let raw = "";
  for (let i = 0; i < bytes.length; i++) {
    raw += PAIRING_ALPHABET[bytes[i] % PAIRING_ALPHABET.length];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

export function ensurePairingCode(): string | null {
  if (!pairingEnabled()) return null;
  const now = Date.now();
  if (!pairingCode || now > pairingExpiresAt) {
    pairingCode = generatePairingCode();
    pairingExpiresAt = now + PAIRING_TTL_MS;
    console.warn(
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

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
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

function hasWsQueryToken(url: URL): boolean {
  return (
    url.searchParams.has("token") ||
    url.searchParams.has("apiKey") ||
    url.searchParams.has("api_key")
  );
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
  if (!expected) return !isCloudProvisionedContainer();

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
    return isCloudProvisionedContainer()
      ? { status: 401, reason: "Unauthorized" }
      : null;
  }

  if (
    process.env.ELIZA_ALLOW_WS_QUERY_TOKEN !== "1" &&
    hasWsQueryToken(wsUrl)
  ) {
    return { status: 401, reason: "Unauthorized" };
  }

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
