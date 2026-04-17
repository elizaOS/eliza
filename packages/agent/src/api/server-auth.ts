/**
 * Auth, security, and WebSocket authorization helpers extracted from server.ts.
 */

import crypto from "node:crypto";
import type http from "node:http";
import path from "node:path";
import type { AgentRuntime, UUID } from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  resolveApiSecurityConfig,
  resolveApiToken,
  setApiToken,
} from "@elizaos/shared/runtime-env";
import { isCloudProvisionedContainer } from "./cloud-provisioning.js";
import { sendJsonError } from "./http-helpers.js";
import { BLOCKED_ENV_KEYS } from "./plugin-discovery-helpers.js";
import type { ConversationMeta } from "./server-helpers.js";

// ---------------------------------------------------------------------------
// Auth token extraction
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Token / API auth helpers
// ---------------------------------------------------------------------------

export function tokenMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function getConfiguredApiToken(): string | undefined {
  return resolveApiToken(process.env) ?? undefined;
}

export function isLoopbackBindHost(host: string): boolean {
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
  if (resolveApiSecurityConfig(process.env).disableAutoApiToken) {
    return;
  }

  const token = getConfiguredApiToken();
  if (token) return;
  const cloudProvisioned = isCloudProvisionedContainer();
  if (!cloudProvisioned && isLoopbackBindHost(host)) return;

  const generated = crypto.randomBytes(32).toString("hex");
  setApiToken(process.env, generated);

  if (cloudProvisioned) {
    logger.warn(
      "[eliza-api] Steward-managed cloud container started without ELIZA_API_TOKEN/ELIZA_API_TOKEN; generated a temporary inbound API token for this process.",
    );
  } else {
    logger.warn(
      `[eliza-api] ELIZA_API_BIND/ELIZA_API_BIND=${host} is non-loopback and ELIZA_API_TOKEN/ELIZA_API_TOKEN is unset.`,
    );
  }
  const tokenFingerprint = `${generated.slice(0, 4)}...${generated.slice(-4)}`;
  logger.warn(
    `[eliza-api] Generated temporary API token (${tokenFingerprint}) for this process. Set ELIZA_API_TOKEN or ELIZA_API_TOKEN explicitly to override.`,
  );
}

export function isAuthorized(req: http.IncomingMessage): boolean {
  const expected = getConfiguredApiToken();
  if (!expected) return !isCloudProvisionedContainer();
  const provided = extractAuthToken(req);
  if (!provided) return false;
  return tokenMatches(expected, provided);
}

// ---------------------------------------------------------------------------
// Plugin config mutation rejection
// ---------------------------------------------------------------------------

export interface PluginConfigMutationRejection {
  field: string;
  message: string;
}

export function resolvePluginConfigMutationRejections(
  pluginParams: Array<{ key: string }>,
  config: Record<string, unknown>,
): PluginConfigMutationRejection[] {
  const allowedParamKeys = new Set(
    pluginParams.map((p) => p.key.toUpperCase().trim()),
  );
  const rejections: PluginConfigMutationRejection[] = [];

  for (const key of Object.keys(config)) {
    const normalized = key.toUpperCase().trim();

    if (!allowedParamKeys.has(normalized)) {
      rejections.push({
        field: key,
        message: `${key} is not a declared config key for this plugin`,
      });
      continue;
    }

    if (BLOCKED_ENV_KEYS.has(normalized)) {
      rejections.push({
        field: key,
        message: `${key} is blocked for security reasons`,
      });
    }
  }

  return rejections;
}

// ---------------------------------------------------------------------------
// Wallet export rejection
// ---------------------------------------------------------------------------

import type {
  WalletExportRejection,
  WalletExportRequestBody,
} from "@elizaos/shared/contracts";

export type { WalletExportRejection };

export function resolveWalletExportRejection(
  req: http.IncomingMessage,
  body: WalletExportRequestBody,
): WalletExportRejection | null {
  if (!body.confirm) {
    return {
      status: 403,
      reason:
        'Export requires explicit confirmation. Send { "confirm": true } in the request body.',
    };
  }

  const expected =
    process.env.ELIZA_WALLET_EXPORT_TOKEN?.trim() ||
    process.env.ELIZA_WALLET_EXPORT_TOKEN?.trim();
  if (!expected) {
    return {
      status: 403,
      reason:
        "Wallet export is disabled. Set ELIZA_WALLET_EXPORT_TOKEN (or ELIZA_WALLET_EXPORT_TOKEN) to enable secure exports.",
    };
  }

  const headerToken =
    typeof req.headers["x-eliza-export-token"] === "string"
      ? req.headers["x-eliza-export-token"].trim()
      : "";
  const bodyToken =
    typeof body.exportToken === "string" ? body.exportToken.trim() : "";
  const provided = headerToken || bodyToken;

  if (!provided) {
    return {
      status: 401,
      reason:
        "Missing export token. Provide X-Eliza-Export-Token header or exportToken in request body.",
    };
  }

  if (!tokenMatches(expected, provided)) {
    return { status: 401, reason: "Invalid export token." };
  }

  return null;
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
// WebSocket auth helpers
// ---------------------------------------------------------------------------

export function extractWsQueryToken(url: URL): string | null {
  const allowQueryToken = process.env.ELIZA_ALLOW_WS_QUERY_TOKEN === "1";
  if (!allowQueryToken) return null;

  const token =
    url.searchParams.get("token") ??
    url.searchParams.get("apiKey") ??
    url.searchParams.get("api_key");
  return token?.trim() || null;
}

export function hasWsQueryToken(url: URL): boolean {
  return (
    url.searchParams.has("token") ||
    url.searchParams.has("apiKey") ||
    url.searchParams.has("api_key")
  );
}

export function extractWebSocketHandshakeToken(
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
  resolveCorsOrigin: (origin?: string) => string | null = () => null,
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

// ---------------------------------------------------------------------------
// State dir safety check
// ---------------------------------------------------------------------------

const RESET_STATE_ALLOWED_SEGMENTS = new Set([
  ".eliza",
  "eliza",
  ".eliza",
  "eliza",
]);

function hasAllowedResetSegment(resolvedState: string): boolean {
  return resolvedState
    .split(path.sep)
    .some((segment) =>
      RESET_STATE_ALLOWED_SEGMENTS.has(segment.trim().toLowerCase()),
    );
}

export function isSafeResetStateDir(
  resolvedState: string,
  homeDir: string,
): boolean {
  const normalizedState = path.resolve(resolvedState);
  const normalizedHome = path.resolve(homeDir);
  const parsedRoot = path.parse(normalizedState).root;

  if (normalizedState === parsedRoot) return false;
  if (normalizedState === normalizedHome) return false;

  const relativeToHome = path.relative(normalizedHome, normalizedState);
  const isUnderHome =
    relativeToHome.length > 0 &&
    !relativeToHome.startsWith("..") &&
    !path.isAbsolute(relativeToHome);
  if (!isUnderHome) return false;

  return hasAllowedResetSegment(normalizedState);
}

// ---------------------------------------------------------------------------
// Conversation room title persistence
// ---------------------------------------------------------------------------

type ConversationRoomTitleRef = Pick<
  ConversationMeta,
  "id" | "title" | "roomId"
>;

export async function persistConversationRoomTitle(
  runtime: Pick<AgentRuntime, "getRoom" | "adapter"> | null | undefined,
  conversation: ConversationRoomTitleRef,
): Promise<boolean> {
  if (!runtime) return false;
  const room = await runtime.getRoom(conversation.roomId);
  if (!room) return false;
  if (room.name === conversation.title) return false;

  const adapter = runtime.adapter as {
    updateRoom?: (nextRoom: typeof room) => Promise<void>;
  };
  if (typeof adapter.updateRoom !== "function") return false;

  await adapter.updateRoom({ ...room, name: conversation.title });
  return true;
}

// ---------------------------------------------------------------------------
// WebSocket rejection & path decoding
// ---------------------------------------------------------------------------

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

export function decodePathComponent(
  raw: string,
  res: http.ServerResponse,
  fieldName: string,
): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    sendJsonError(res, `Invalid ${fieldName}: malformed URL encoding`, 400);
    return null;
  }
}
