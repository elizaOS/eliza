/**
 * GitHub PAT routes — power the "GitHub" connection card in Settings →
 * Coding Agents and surface the same token to the orchestrator's
 * sub-agent spawn env.
 *
 * Exposes:
 *   GET    /api/github/token   — `{ connected: bool, username?, scopes?, savedAt? }`.
 *                                 Token itself is never returned.
 *   POST   /api/github/token   — body `{ token }`. Validates by calling
 *                                 GitHub's `/user` endpoint, then persists
 *                                 the credential record to disk.
 *   DELETE /api/github/token   — clears the saved credential and returns
 *                                 `{ connected: false }`.
 *
 * `handleGitHubRoutes` is the pure dispatcher — no auth, no runtime deps.
 * The runtime adapter (`createGitHubRouteHandler`) lives in index.ts where
 * it can import the heavier app-core auth surface without polluting this
 * module's import graph (and breaking tests that only need the pure handler).
 */

import type http from "node:http";
import {
  buildCredentialsFromUserResponse,
  clearCredentials,
  type GitHubCredentialMetadata,
  loadMetadata,
  saveCredentials,
} from "@elizaos/app-core/services/github-credentials";
import { logger } from "@elizaos/core";

const GITHUB_USER_URL = "https://api.github.com/user";
const VALIDATION_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 8 * 1024;

async function readJsonBody(
  req: http.IncomingMessage,
): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) return null;
    chunks.push(buf);
  }
  if (chunks.length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
interface GitHubUserResponse {
  login: string;
}

export interface GitHubRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  /** Inject for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  json?: (status: number, body: unknown) => void;
}

interface TokenStatusResponse {
  connected: boolean;
  username?: string;
  scopes?: string[];
  savedAt?: number;
}

function sendJson(
  ctx: GitHubRouteContext,
  status: number,
  body: unknown,
): void {
  if (ctx.json) {
    ctx.json(status, body);
    return;
  }
  ctx.res.statusCode = status;
  ctx.res.setHeader("Content-Type", "application/json; charset=utf-8");
  ctx.res.end(JSON.stringify(body));
}

function metadataToStatus(
  metadata: GitHubCredentialMetadata | null,
): TokenStatusResponse {
  if (!metadata) return { connected: false };
  return {
    connected: true,
    username: metadata.username,
    scopes: metadata.scopes,
    savedAt: metadata.savedAt,
  };
}

async function validateToken(
  token: string,
  fetchImpl: typeof fetch,
): Promise<{ user: GitHubUserResponse; scopes: string[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(GITHUB_USER_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "eliza-github-connection",
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401) {
    throw new Error("Token rejected by GitHub: bad credentials.");
  }
  if (response.status === 403) {
    throw new Error(
      "Token rejected by GitHub: forbidden. Check the token has at least `read:user` scope.",
    );
  }
  if (!response.ok) {
    throw new Error(
      `GitHub returned ${response.status} validating the token. Try again or generate a new token.`,
    );
  }

  const body = (await response.json()) as GitHubUserResponse;
  if (typeof body?.login !== "string" || body.login.length === 0) {
    throw new Error("GitHub /user response was missing the login field.");
  }

  const scopesHeader = response.headers.get("x-oauth-scopes") ?? "";
  const scopes = scopesHeader
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return { user: body, scopes };
}

async function handleGetToken(ctx: GitHubRouteContext): Promise<boolean> {
  const metadata = await loadMetadata();
  sendJson(ctx, 200, metadataToStatus(metadata));
  return true;
}

async function handlePostToken(ctx: GitHubRouteContext): Promise<boolean> {
  const body = await readJsonBody(ctx.req);
  const token = body && typeof body.token === "string" ? body.token.trim() : "";
  if (token.length === 0) {
    sendJson(ctx, 400, { error: "Missing `token` in request body." });
    return true;
  }

  const fetchImpl = ctx.fetch ?? fetch;
  let validated: Awaited<ReturnType<typeof validateToken>>;
  try {
    validated = await validateToken(token, fetchImpl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[github-routes] token validation failed: ${message}`);
    sendJson(ctx, 400, { error: message });
    return true;
  }

  const credentials = buildCredentialsFromUserResponse(
    token,
    validated.user,
    validated.scopes,
  );
  await saveCredentials(credentials);
  logger.info(
    `[github-routes] saved github token for @${validated.user.login} (scopes=${validated.scopes.join(",") || "(none)"})`,
  );
  sendJson(ctx, 200, metadataToStatus(credentials));
  return true;
}

async function handleDeleteToken(ctx: GitHubRouteContext): Promise<boolean> {
  await clearCredentials();
  logger.info("[github-routes] cleared saved github token");
  sendJson(ctx, 200, { connected: false });
  return true;
}

/**
 * Dispatch entry point. Returns `true` when this module owned the request.
 * Caller is responsible for auth (mirrors `/api/workflow/*` in server.ts).
 */
export async function handleGitHubRoutes(
  ctx: GitHubRouteContext,
): Promise<boolean> {
  if (ctx.pathname !== "/api/github/token") return false;
  switch (ctx.method) {
    case "GET":
      return handleGetToken(ctx);
    case "POST":
      return handlePostToken(ctx);
    case "DELETE":
      return handleDeleteToken(ctx);
    default:
      sendJson(ctx, 405, { error: "Method not allowed" });
      return true;
  }
}
