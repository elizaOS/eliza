import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  LifeOpsConnectorSide,
} from "@elizaos/shared/contracts/lifeops";
import { resolveOAuthDir } from "@elizaos/agent/config/paths";

const DISCORD_AUTHORIZATION_ENDPOINT =
  "https://discord.com/api/oauth2/authorize";
const DISCORD_TOKEN_ENDPOINT = "https://discord.com/api/oauth2/token";
const DISCORD_USERINFO_ENDPOINT = "https://discord.com/api/users/@me";
const DISCORD_OAUTH_SESSION_TTL_MS = 10 * 60 * 1000;
const DISCORD_ACCESS_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

const DISCORD_SCOPES = "identify guilds messages.read";

const pendingDiscordOAuthSessions = new Map<
  string,
  PendingDiscordOAuthSession
>();

export class DiscordOAuthError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DiscordOAuthError";
  }
}

export interface ResolvedDiscordOAuthConfig {
  configured: boolean;
  clientId: string | null;
  clientSecret: string | null;
  redirectUri: string;
}

interface PendingDiscordOAuthSession {
  state: string;
  agentId: string;
  side: LifeOpsConnectorSide;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  codeVerifier: string;
  createdAt: number;
}

export interface StoredDiscordConnectorToken {
  provider: "discord";
  agentId: string;
  side: LifeOpsConnectorSide;
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  grantedScopes: string[];
  expiresAt: number;
  createdAt: string;
  updatedAt: string;
}

interface DiscordTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

export interface DiscordConnectorCallbackResult {
  agentId: string;
  side: LifeOpsConnectorSide;
  tokenRef: string;
  identity: Record<string, unknown>;
  grantedScopes: string[];
  expiresAt: string | null;
  hasRefreshToken: boolean;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function tokenStorageRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveOAuthDir(env), "lifeops", "discord");
}

function ensureTokenStorageDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function buildDiscordTokenRef(
  agentId: string,
  side: LifeOpsConnectorSide,
): string {
  return path.join(
    sanitizePathSegment(agentId),
    sanitizePathSegment(side),
    "local.json",
  );
}

function resolveTokenPath(
  tokenRef: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(tokenStorageRoot(env), tokenRef);
}

function readStoredDiscordTokenFile(
  tokenRef: string,
  env: NodeJS.ProcessEnv = process.env,
): StoredDiscordConnectorToken | null {
  const filePath = resolveTokenPath(tokenRef, env);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<StoredDiscordConnectorToken>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return {
      ...(parsed as StoredDiscordConnectorToken),
      side: parsed.side === "agent" ? "agent" : "owner",
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function writeStoredDiscordTokenFile(
  tokenRef: string,
  token: StoredDiscordConnectorToken,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const filePath = resolveTokenPath(tokenRef, env);
  ensureTokenStorageDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(token, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Non-fatal on platforms without chmod semantics.
  }
}

export function deleteStoredDiscordToken(
  tokenRef: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const filePath = resolveTokenPath(tokenRef, env);
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export function readStoredDiscordToken(
  tokenRef: string,
  env: NodeJS.ProcessEnv = process.env,
): StoredDiscordConnectorToken | null {
  return readStoredDiscordTokenFile(tokenRef, env);
}

function createCodeVerifier(): string {
  return crypto.randomBytes(64).toString("base64url");
}

function createCodeChallenge(codeVerifier: string): string {
  return crypto.createHash("sha256").update(codeVerifier).digest("base64url");
}

function createState(): string {
  return crypto.randomBytes(32).toString("hex");
}

function cleanupExpiredDiscordOAuthSessions(now = Date.now()): void {
  for (const [state, session] of pendingDiscordOAuthSessions.entries()) {
    if (now - session.createdAt > DISCORD_OAUTH_SESSION_TTL_MS) {
      pendingDiscordOAuthSessions.delete(state);
    }
  }
}

function clearPendingSessionsForAgent(
  agentId: string,
  side: LifeOpsConnectorSide,
): void {
  for (const [state, session] of pendingDiscordOAuthSessions.entries()) {
    if (session.agentId === agentId && session.side === side) {
      pendingDiscordOAuthSessions.delete(state);
    }
  }
}

function splitScopes(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

async function readDiscordErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) {
    return `Discord request failed with ${response.status}`;
  }

  try {
    const parsed = JSON.parse(text) as {
      error?: string;
      error_description?: string;
    };
    return parsed.error_description || parsed.error || text;
  } catch {
    return text;
  }
}

async function exchangeDiscordToken(
  params: URLSearchParams,
): Promise<DiscordTokenResponse> {
  const response = await fetch(DISCORD_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    throw new DiscordOAuthError(502, await readDiscordErrorMessage(response));
  }

  const parsed = (await response.json()) as DiscordTokenResponse;
  if (!parsed.access_token || !Number.isFinite(parsed.expires_in)) {
    throw new DiscordOAuthError(
      502,
      "Discord token exchange returned an invalid payload.",
    );
  }
  return parsed;
}

async function fetchDiscordUserInfo(
  accessToken: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(DISCORD_USERINFO_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!response.ok) {
    return {};
  }
  const parsed = (await response.json()) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

export function resolveDiscordOAuthConfig(
  requestUrl: URL,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedDiscordOAuthConfig {
  const clientId = env.ELIZA_DISCORD_OAUTH_CLIENT_ID?.trim() ?? null;
  const clientSecret = env.ELIZA_DISCORD_OAUTH_CLIENT_SECRET?.trim() ?? null;
  const port =
    requestUrl.port || (requestUrl.protocol === "https:" ? "443" : "80");

  return {
    configured: Boolean(clientId && clientSecret),
    clientId,
    clientSecret,
    redirectUri: `http://127.0.0.1:${port}/api/lifeops/connectors/discord/callback`,
  };
}

export function startDiscordConnectorOAuth(args: {
  agentId: string;
  side?: LifeOpsConnectorSide;
  requestUrl: URL;
  redirectUrl?: string;
  env?: NodeJS.ProcessEnv;
}): { provider: "discord"; side: LifeOpsConnectorSide; authUrl: string } {
  cleanupExpiredDiscordOAuthSessions();

  const env = args.env ?? process.env;
  const config = resolveDiscordOAuthConfig(args.requestUrl, env);
  if (!config.configured || !config.clientId || !config.clientSecret) {
    throw new DiscordOAuthError(
      503,
      "Discord OAuth is not configured. Set ELIZA_DISCORD_OAUTH_CLIENT_ID and ELIZA_DISCORD_OAUTH_CLIENT_SECRET.",
    );
  }

  const side = args.side ?? "owner";
  clearPendingSessionsForAgent(args.agentId, side);

  const state = createState();
  const codeVerifier = createCodeVerifier();
  const codeChallenge = createCodeChallenge(codeVerifier);
  const redirectUri = args.redirectUrl ?? config.redirectUri;

  pendingDiscordOAuthSessions.set(state, {
    state,
    agentId: args.agentId,
    side,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri,
    codeVerifier,
    createdAt: Date.now(),
  });

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: DISCORD_SCOPES,
    state,
    prompt: "consent",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return {
    provider: "discord",
    side,
    authUrl: `${DISCORD_AUTHORIZATION_ENDPOINT}?${params.toString()}`,
  };
}

export async function completeDiscordConnectorOAuth(args: {
  callbackUrl: URL;
  env?: NodeJS.ProcessEnv;
}): Promise<DiscordConnectorCallbackResult> {
  cleanupExpiredDiscordOAuthSessions();

  const state = args.callbackUrl.searchParams.get("state")?.trim();
  if (!state) {
    throw new DiscordOAuthError(400, "Discord callback is missing state.");
  }

  const session = pendingDiscordOAuthSessions.get(state);
  if (!session) {
    throw new DiscordOAuthError(
      400,
      "Discord callback does not match an active login session.",
    );
  }
  pendingDiscordOAuthSessions.delete(state);

  if (Date.now() - session.createdAt > DISCORD_OAUTH_SESSION_TTL_MS) {
    throw new DiscordOAuthError(
      410,
      "Discord login session expired. Start the connection flow again.",
    );
  }

  const upstreamError = args.callbackUrl.searchParams.get("error")?.trim();
  if (upstreamError) {
    const description =
      args.callbackUrl.searchParams.get("error_description")?.trim() ||
      upstreamError;
    throw new DiscordOAuthError(400, description);
  }

  const code = args.callbackUrl.searchParams.get("code")?.trim();
  if (!code) {
    throw new DiscordOAuthError(
      400,
      "Discord callback is missing an authorization code.",
    );
  }

  const params = new URLSearchParams({
    client_id: session.clientId,
    client_secret: session.clientSecret,
    code,
    code_verifier: session.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: session.redirectUri,
  });

  const token = await exchangeDiscordToken(params);
  const grantedScopes = splitScopes(token.scope);
  const normalizedScopes =
    grantedScopes.length > 0 ? grantedScopes : DISCORD_SCOPES.split(" ");

  const identity = await fetchDiscordUserInfo(token.access_token);

  const tokenRef = buildDiscordTokenRef(session.agentId, session.side);
  const existing = readStoredDiscordTokenFile(tokenRef, args.env);
  const now = new Date();

  const storedToken: StoredDiscordConnectorToken = {
    provider: "discord",
    agentId: session.agentId,
    side: session.side,
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? existing?.refreshToken ?? null,
    tokenType: token.token_type || existing?.tokenType || "Bearer",
    grantedScopes: normalizedScopes,
    expiresAt: Date.now() + token.expires_in * 1000,
    createdAt: existing?.createdAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
  };
  writeStoredDiscordTokenFile(tokenRef, storedToken, args.env);

  return {
    agentId: session.agentId,
    side: session.side,
    tokenRef,
    identity,
    grantedScopes: normalizedScopes,
    expiresAt: new Date(storedToken.expiresAt).toISOString(),
    hasRefreshToken: Boolean(storedToken.refreshToken),
  };
}

/**
 * In-flight refresh promises keyed by tokenRef. Deduplicates concurrent
 * callers so only one token exchange runs per tokenRef at a time.
 */
const inflightRefreshes = new Map<
  string,
  Promise<StoredDiscordConnectorToken>
>();

export async function ensureFreshDiscordAccessToken(
  tokenRef: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StoredDiscordConnectorToken> {
  const stored = readStoredDiscordTokenFile(tokenRef, env);
  if (!stored) {
    throw new DiscordOAuthError(404, "Discord connector token is missing.");
  }
  if (
    stored.expiresAt >
    Date.now() + DISCORD_ACCESS_TOKEN_REFRESH_BUFFER_MS
  ) {
    return stored;
  }
  if (!stored.refreshToken) {
    throw new DiscordOAuthError(
      401,
      "Discord connector needs re-authentication.",
    );
  }

  const existing = inflightRefreshes.get(tokenRef);
  if (existing) {
    return existing;
  }

  const refreshPromise = refreshDiscordAccessTokenImpl(tokenRef, stored, env);
  inflightRefreshes.set(tokenRef, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    inflightRefreshes.delete(tokenRef);
  }
}

async function refreshDiscordAccessTokenImpl(
  tokenRef: string,
  stored: StoredDiscordConnectorToken,
  env: NodeJS.ProcessEnv,
): Promise<StoredDiscordConnectorToken> {
  const clientId = env.ELIZA_DISCORD_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.ELIZA_DISCORD_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new DiscordOAuthError(
      503,
      "Discord OAuth credentials are not configured for token refresh.",
    );
  }

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: stored.refreshToken!,
  });

  const token = await exchangeDiscordToken(params);
  const grantedScopes = splitScopes(token.scope);
  const now = new Date();

  const refreshedToken: StoredDiscordConnectorToken = {
    provider: "discord",
    agentId: stored.agentId,
    side: stored.side,
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? stored.refreshToken,
    tokenType: token.token_type || stored.tokenType || "Bearer",
    grantedScopes:
      grantedScopes.length > 0 ? grantedScopes : stored.grantedScopes,
    expiresAt: Date.now() + token.expires_in * 1000,
    createdAt: stored.createdAt,
    updatedAt: now.toISOString(),
  };
  writeStoredDiscordTokenFile(tokenRef, refreshedToken, env);
  return refreshedToken;
}
