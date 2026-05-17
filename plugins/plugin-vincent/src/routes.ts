/**
 * Vincent OAuth backend routes for Hyperliquid and Polymarket access.
 *
 * POST /api/vincent/start-login — Begin OAuth: register app, generate PKCE, return authUrl
 * GET  /callback/vincent        — OAuth redirect target: exchange code, persist tokens
 * GET  /api/vincent/status      — Check if Vincent is connected
 * POST /api/vincent/disconnect  — Clear stored Vincent tokens
 *
 * The start-login + /callback/vincent pair keeps the PKCE code_verifier on the
 * server so the OAuth redirect can land in the user's external system browser
 * (where sessionStorage is not shared with the desktop webview) and still
 * complete the token exchange.
 */

import crypto from "node:crypto";
import type http from "node:http";
import { saveElizaConfig } from "@elizaos/agent";
import { sendJson, sendJsonError } from "@elizaos/app-core";
import { logger } from "@elizaos/core";
import type { ElizaConfig } from "@elizaos/shared";
import type {
  VincentStartLoginResponse,
  VincentStatusResponse,
  VincentStrategyName,
  VincentStrategyResponse,
  VincentStrategyUpdateRequest,
  VincentStrategyUpdateResponse,
  VincentTradingProfileResponse,
} from "./vincent-contracts";
import { VINCENT_TRADING_VENUES } from "./vincent-contracts";

const VINCENT_API_BASE = "https://heyvincent.ai";

/** Maximum time a pending PKCE login can sit before it is evicted. */
const PENDING_LOGIN_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface PendingLogin {
  clientId: string;
  codeVerifier: string;
  /**
   * Must be echoed back to the Vincent token endpoint verbatim. RFC 6749
   * §4.1.3 requires redirect_uri in the token exchange to exactly match the
   * one in the authorize request when it was present there — Vincent enforces
   * this and rejects with "invalid_request: expected string, received
   * undefined" if the field is missing.
   */
  redirectUri: string;
  createdAt: number;
}

/**
 * In-memory store for in-flight OAuth logins, keyed by OAuth `state` param.
 * Process-local on purpose — Vincent tokens only matter for this runtime.
 */
const pendingLogins = new Map<string, PendingLogin>();

function sweepExpiredLogins(): void {
  const cutoff = Date.now() - PENDING_LOGIN_TTL_MS;
  for (const [state, entry] of pendingLogins) {
    if (entry.createdAt < cutoff) pendingLogins.delete(state);
  }
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generateCodeVerifier(): string {
  return base64UrlEncode(crypto.randomBytes(32));
}

function generateCodeChallenge(verifier: string): string {
  return base64UrlEncode(crypto.createHash("sha256").update(verifier).digest());
}

function resolveServerOrigin(req: http.IncomingMessage): string | null {
  const host = req.headers.host;
  if (!host) return null;
  // All Vincent login traffic is loopback — http is fine and matches the
  // redirect_uri the external browser will actually hit.
  return `http://${host}`;
}

interface VincentTokens {
  accessToken: string;
  refreshToken: string | null;
  clientId: string;
  connectedAt: number;
}

interface VincentConfigState {
  vincent?: VincentTokens;
  trading?: {
    strategy?: VincentStrategyName;
    params?: Record<string, unknown>;
    intervalSeconds?: number;
    dryRun?: boolean;
  };
}

function isVincentTradingConfig(
  value: unknown,
): value is NonNullable<VincentConfigState["trading"]> {
  return (
    isPlainRecord(value) &&
    (value.strategy === undefined ||
      readVincentStrategyName(value.strategy) !== null) &&
    (value.params === undefined || isPlainRecord(value.params)) &&
    (value.intervalSeconds === undefined ||
      typeof value.intervalSeconds === "number") &&
    (value.dryRun === undefined || typeof value.dryRun === "boolean")
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonRecord(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readStringField(
  value: Record<string, unknown> | null,
  key: string,
): string | null {
  const field = value?.[key];
  return typeof field === "string" && field.trim() ? field.trim() : null;
}

function readVincentStrategyName(value: unknown): VincentStrategyName | null {
  return value === "dca" ||
    value === "rebalance" ||
    value === "threshold" ||
    value === "manual"
    ? value
    : null;
}

function getVincentTokens(config: ElizaConfig): VincentTokens | undefined {
  const vincent: unknown = Reflect.get(config, "vincent");
  return isPlainRecord(vincent) &&
    typeof vincent.accessToken === "string" &&
    typeof vincent.clientId === "string" &&
    typeof vincent.connectedAt === "number"
    ? {
        accessToken: vincent.accessToken,
        refreshToken:
          typeof vincent.refreshToken === "string"
            ? vincent.refreshToken
            : null,
        clientId: vincent.clientId,
        connectedAt: vincent.connectedAt,
      }
    : undefined;
}

function setVincentTokens(
  config: ElizaConfig,
  tokens: VincentTokens | undefined,
): void {
  Reflect.set(config, "vincent", tokens);
}

function getVincentTradingConfig(
  config: ElizaConfig,
): VincentConfigState["trading"] | undefined {
  const trading: unknown = Reflect.get(config, "trading");
  return isVincentTradingConfig(trading) ? trading : undefined;
}

function setVincentTradingConfig(
  config: ElizaConfig,
  trading: VincentConfigState["trading"],
): void {
  Reflect.set(config, "trading", trading);
}

export interface VincentRouteState {
  config: ElizaConfig;
}

/**
 * Handle all /api/vincent/* routes.
 * Returns true if the route was handled, false otherwise.
 */
export async function handleVincentRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  state: VincentRouteState,
): Promise<boolean> {
  // ── POST /api/vincent/start-login ───────────────────────────────
  // Server-side PKCE: register with Vincent, generate verifier/challenge,
  // store the verifier keyed by a fresh `state` param, and return the
  // authorization URL. The browser visits this URL, authenticates, and is
  // redirected back to GET /callback/vincent on this same origin.
  if (method === "POST" && pathname === "/api/vincent/start-login") {
    try {
      sweepExpiredLogins();

      const origin = resolveServerOrigin(req);
      if (!origin) {
        sendJsonError(res, 400, "Missing Host header");
        return true;
      }
      const redirectUri = `${origin}/callback/vincent`;

      const body = await readBody(req).catch(() => "");
      const parsed = body ? parseJsonRecord(body) : null;
      const appName = readStringField(parsed, "appName") ?? "Eliza";

      const registerRes = await fetch(
        `${VINCENT_API_BASE}/api/oauth/public/register`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_name: appName,
            redirect_uris: [redirectUri],
          }),
        },
      );
      if (!registerRes.ok) {
        const text = await registerRes.text().catch(() => "");
        sendJsonError(
          res,
          registerRes.status,
          `Vincent register failed: ${text}`,
        );
        return true;
      }
      const registerJson = parseJsonRecord(
        await registerRes.text().catch(() => ""),
      );
      const clientId = readStringField(registerJson, "client_id");
      if (!clientId) {
        sendJsonError(res, 502, "Vincent register returned an invalid payload");
        return true;
      }

      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const stateParam = crypto.randomUUID();

      pendingLogins.set(stateParam, {
        clientId,
        codeVerifier,
        redirectUri,
        createdAt: Date.now(),
      });

      const params = new URLSearchParams({
        client_id: clientId,
        response_type: "code",
        redirect_uri: redirectUri,
        scope: "all",
        resource: VINCENT_API_BASE,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state: stateParam,
      });
      const authUrl = `${VINCENT_API_BASE}/api/oauth/public/authorize?${params.toString()}`;
      const payload: VincentStartLoginResponse = {
        authUrl,
        state: stateParam,
        redirectUri,
      };

      sendJson(res, 200, payload);
    } catch (err) {
      logger.error(
        `[vincent/start-login] ${err instanceof Error ? err.message : String(err)}`,
      );
      sendJsonError(res, 500, "Vincent start-login failed");
    }
    return true;
  }

  // ── GET /callback/vincent ───────────────────────────────────────
  // OAuth redirect target for the Vincent authorization flow.  Loads in the
  // user's external browser (not the desktop webview), so it returns a small
  // HTML page that tells the user to close the tab — the desktop app is
  // polling /api/vincent/status and will flip to connected on its own.
  if (method === "GET" && pathname === "/callback/vincent") {
    try {
      sweepExpiredLogins();

      const url = new URL(req.url ?? "/callback/vincent", "http://localhost");
      const code = url.searchParams.get("code");
      const stateParam = url.searchParams.get("state");
      const oauthError = url.searchParams.get("error");

      if (oauthError) {
        // `sendCallbackHtml` escapes `message` wholesale — don't escape the
        // `error` param here or it ends up double-encoded (&amp;lt; instead
        // of &lt;).
        sendCallbackHtml(
          res,
          400,
          "Vincent login failed",
          `Vincent returned an error: ${oauthError}. You may close this window.`,
        );
        return true;
      }
      if (!code) {
        sendCallbackHtml(
          res,
          400,
          "Vincent login failed",
          "The Vincent redirect did not include an authorization code. You may close this window.",
        );
        return true;
      }

      // Require a state param that matches a pending login exactly. This
      // prevents any local process that can reach loopback from completing a
      // login flow it did not initiate — only start-login can seed an entry
      // in pendingLogins, and only the state value we returned from it can
      // unlock the associated code_verifier. (PKCE already prevents cross-
      // session token theft via Vincent's challenge/verifier check, but
      // rejecting unknown state is the cheaper, clearer gate.)
      if (!stateParam) {
        sendCallbackHtml(
          res,
          400,
          "Vincent login failed",
          "The Vincent redirect did not include a state parameter. Please return to the app and try again.",
        );
        return true;
      }
      const pending = pendingLogins.get(stateParam);
      if (!pending) {
        sendCallbackHtml(
          res,
          400,
          "Vincent login expired",
          "No pending login was found for this callback. Please return to the app and try again.",
        );
        return true;
      }
      pendingLogins.delete(stateParam);

      const tokenRes = await fetch(
        `${VINCENT_API_BASE}/api/oauth/public/token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "authorization_code",
            code,
            client_id: pending.clientId,
            code_verifier: pending.codeVerifier,
            // RFC 6749 §4.1.3: redirect_uri MUST match the one used in the
            // authorize request. Vincent rejects the exchange with
            // "invalid_request: expected string, received undefined" without
            // this field.
            redirect_uri: pending.redirectUri,
          }),
        },
      );
      if (!tokenRes.ok) {
        const text = await tokenRes.text().catch(() => "");
        logger.error(
          `[vincent/callback] token exchange failed: ${tokenRes.status} ${text}`,
        );
        sendCallbackHtml(
          res,
          502,
          "Vincent login failed",
          "Token exchange with Vincent failed. Please return to the app and try again.",
        );
        return true;
      }

      const tokenJson = parseJsonRecord(await tokenRes.text().catch(() => ""));
      const accessToken = readStringField(tokenJson, "access_token");
      if (!accessToken) {
        logger.error(
          "[vincent/callback] token response was missing access_token",
        );
        sendCallbackHtml(
          res,
          502,
          "Vincent login failed",
          "Token exchange with Vincent returned an invalid payload. Please return to the app and try again.",
        );
        return true;
      }
      const refreshToken = readStringField(tokenJson, "refresh_token");

      const config = state.config;
      setVincentTokens(config, {
        accessToken,
        refreshToken,
        clientId: pending.clientId,
        connectedAt: Math.floor(Date.now() / 1000),
      });
      await saveElizaConfig(config);

      logger.info("[vincent/callback] Vincent connected successfully");
      sendCallbackHtml(
        res,
        200,
        "Vincent connected",
        "You're signed in. You can close this window and return to the app.",
      );
    } catch (err) {
      logger.error(
        `[vincent/callback] ${err instanceof Error ? err.message : String(err)}`,
      );
      sendCallbackHtml(
        res,
        500,
        "Vincent login failed",
        "An unexpected error occurred completing the Vincent login. You may close this window and try again.",
      );
    }
    return true;
  }

  // ── GET /api/vincent/status ─────────────────────────────────────
  if (method === "GET" && pathname === "/api/vincent/status") {
    const vincent = getVincentTokens(state.config);
    const payload: VincentStatusResponse = {
      connected: Boolean(vincent?.accessToken),
      connectedAt: vincent?.connectedAt ?? null,
      tradingVenues: VINCENT_TRADING_VENUES,
    };
    sendJson(res, 200, payload);
    return true;
  }

  // ── POST /api/vincent/disconnect ────────────────────────────────
  if (method === "POST" && pathname === "/api/vincent/disconnect") {
    try {
      const config = state.config;
      setVincentTokens(config, undefined);
      await saveElizaConfig(config);
      logger.info("[vincent/disconnect] Vincent disconnected");
      sendJson(res, 200, { ok: true });
    } catch (err) {
      logger.error(
        `[vincent/disconnect] ${err instanceof Error ? err.message : String(err)}`,
      );
      sendJsonError(res, 500, "Vincent disconnect failed");
    }
    return true;
  }

  // ── GET /api/vincent/trading-profile ───────────────────────────
  if (method === "GET" && pathname === "/api/vincent/trading-profile") {
    const vincent = getVincentTokens(state.config);
    if (!vincent?.accessToken) {
      sendJson(res, 200, { connected: false, profile: null });
      return true;
    }
    const payload: VincentTradingProfileResponse = {
      connected: true,
      profile: null,
    };
    sendJson(res, 200, payload);
    return true;
  }

  // ── GET /api/vincent/strategy ──────────────────────────────────
  // Current trading strategy configuration.
  if (method === "GET" && pathname === "/api/vincent/strategy") {
    const vincent = getVincentTokens(state.config);
    if (!vincent?.accessToken) {
      sendJson(res, 200, { connected: false, strategy: null });
      return true;
    }
    const tradingConfig = getVincentTradingConfig(state.config);
    if (!tradingConfig) {
      sendJson(res, 200, { connected: true, strategy: null });
      return true;
    }
    const payload: VincentStrategyResponse = {
      connected: true,
      strategy: {
        name: tradingConfig?.strategy ?? "manual",
        venues: VINCENT_TRADING_VENUES,
        params: tradingConfig?.params ?? {},
        intervalSeconds: tradingConfig?.intervalSeconds ?? 60,
        dryRun: tradingConfig?.dryRun ?? false,
        running: false,
      },
    };
    sendJson(res, 200, payload);
    return true;
  }

  // ── POST /api/vincent/strategy ─────────────────────────────────
  // Update trading strategy configuration.
  if (method === "POST" && pathname === "/api/vincent/strategy") {
    try {
      const vincent = getVincentTokens(state.config);
      if (!vincent?.accessToken) {
        sendJsonError(res, 401, "Vincent not connected");
        return true;
      }
      const body = await readBody(req);
      const parsed = parseJsonRecord(body);
      const updates: VincentStrategyUpdateRequest = {
        strategy: readVincentStrategyName(parsed?.strategy) ?? undefined,
        params: isPlainRecord(parsed?.params) ? parsed.params : undefined,
        intervalSeconds:
          typeof parsed?.intervalSeconds === "number"
            ? parsed.intervalSeconds
            : undefined,
        dryRun: typeof parsed?.dryRun === "boolean" ? parsed.dryRun : undefined,
      };
      const config = getVincentTradingConfig(state.config);
      const nextTrading = {
        ...(config ?? {}),
        ...(updates.strategy !== undefined && { strategy: updates.strategy }),
        ...(updates.params !== undefined && { params: updates.params }),
        ...(updates.intervalSeconds !== undefined && {
          intervalSeconds: updates.intervalSeconds,
        }),
        ...(updates.dryRun !== undefined && { dryRun: updates.dryRun }),
      };
      setVincentTradingConfig(state.config, nextTrading);
      await saveElizaConfig(state.config);
      const payload: VincentStrategyUpdateResponse = {
        ok: true,
        strategy: {
          name: nextTrading.strategy ?? "manual",
          venues: VINCENT_TRADING_VENUES,
          params: nextTrading.params ?? {},
          intervalSeconds: nextTrading.intervalSeconds ?? 60,
          dryRun: nextTrading.dryRun ?? false,
          running: false,
        },
      };
      sendJson(res, 200, payload);
    } catch (err) {
      logger.error(
        `[vincent/strategy] ${err instanceof Error ? err.message : String(err)}`,
      );
      sendJsonError(res, 500, "Strategy update failed");
    }
    return true;
  }

  return false;
}

// ── Helpers ───────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sendCallbackHtml(
  res: http.ServerResponse,
  status: number,
  title: string,
  message: string,
): void {
  if (res.headersSent) return;
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${safeTitle} · Eliza</title>
<style>
  :root { color-scheme: light dark; }
  html, body { height: 100%; margin: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    display: flex; align-items: center; justify-content: center;
    background: #0b0b0f; color: #f4f4f5;
  }
  .card {
    max-width: 420px; padding: 32px 36px; border-radius: 16px;
    background: #17171c; border: 1px solid #2a2a33;
    box-shadow: 0 20px 60px rgba(0,0,0,0.4);
    text-align: center;
  }
  h1 { margin: 0 0 12px; font-size: 20px; font-weight: 600; }
  p  { margin: 0; font-size: 14px; line-height: 1.5; color: #b4b4bd; }
</style>
</head>
<body>
  <main class="card">
    <h1>${safeTitle}</h1>
    <p>${safeMessage}</p>
  </main>
  <script>setTimeout(() => { try { window.close(); } catch (_) {} }, 1500);</script>
</body>
</html>`;
  res.statusCode = status;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(html);
}
