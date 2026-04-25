import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsGoogleCapability,
  StartLifeOpsGoogleConnectorResponse,
} from "@elizaos/app-lifeops/contracts";
import { resolveOAuthDir } from "@elizaos/agent/config/paths";
import {
  googleCapabilitiesToScopes,
  googleScopesToCapabilities,
  normalizeGoogleCapabilities,
  unionGoogleCapabilities,
} from "./google-scopes.js";
import { rewriteGoogleUrlForMock } from "./google-fetch.js";

const GOOGLE_AUTHORIZATION_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_ENDPOINT =
  "https://openidconnect.googleapis.com/v1/userinfo";
const GOOGLE_OAUTH_SESSION_TTL_MS = 10 * 60 * 1000;
const GOOGLE_ACCESS_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

const pendingGoogleOAuthSessions = new Map<string, PendingGoogleOAuthSession>();

const DESKTOP_CLIENT_ID_KEYS = [
  "ELIZA_GOOGLE_OAUTH_DESKTOP_CLIENT_ID",
  "ELIZA_GOOGLE_OAUTH_DESKTOP_CLIENT_ID",
] as const;
const DESKTOP_CLIENT_SECRET_KEYS = [
  "ELIZA_GOOGLE_OAUTH_DESKTOP_CLIENT_SECRET",
  "ELIZA_GOOGLE_OAUTH_DESKTOP_CLIENT_SECRET",
] as const;
const WEB_CLIENT_ID_KEYS = [
  "ELIZA_GOOGLE_OAUTH_WEB_CLIENT_ID",
  "ELIZA_GOOGLE_OAUTH_WEB_CLIENT_ID",
] as const;
const WEB_CLIENT_SECRET_KEYS = [
  "ELIZA_GOOGLE_OAUTH_WEB_CLIENT_SECRET",
  "ELIZA_GOOGLE_OAUTH_WEB_CLIENT_SECRET",
] as const;
const PUBLIC_BASE_URL_KEYS = [
  "ELIZA_GOOGLE_OAUTH_PUBLIC_BASE_URL",
  "ELIZA_GOOGLE_OAUTH_PUBLIC_BASE_URL",
] as const;

export class GoogleOAuthError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GoogleOAuthError";
  }
}

export interface ResolvedGoogleOAuthConfig {
  mode: LifeOpsConnectorMode;
  defaultMode: LifeOpsConnectorMode;
  availableModes: LifeOpsConnectorMode[];
  configured: boolean;
  clientId: string | null;
  clientSecret: string | null;
  redirectUri: string;
}

interface PendingGoogleOAuthSession {
  state: string;
  agentId: string;
  side: LifeOpsConnectorSide;
  mode: LifeOpsConnectorMode;
  clientId: string;
  clientSecret: string | null;
  redirectUri: string;
  requestedCapabilities: LifeOpsGoogleCapability[];
  codeVerifier: string;
  createdAt: number;
  /** When re-authenticating an existing account, carries its grant ID. */
  grantId?: string;
}

export interface StoredGoogleConnectorToken {
  provider: "google";
  agentId: string;
  side: LifeOpsConnectorSide;
  mode: LifeOpsConnectorMode;
  clientId: string;
  redirectUri: string;
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  grantedScopes: string[];
  expiresAt: number;
  refreshTokenExpiresAt: number | null;
  createdAt: string;
  updatedAt: string;
}

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
  token_type?: string;
  id_token?: string;
}

export interface GoogleConnectorCallbackResult {
  agentId: string;
  side: LifeOpsConnectorSide;
  mode: LifeOpsConnectorMode;
  /** Set when re-authenticating an existing account. */
  grantId?: string;
  tokenRef: string;
  identity: Record<string, unknown>;
  grantedCapabilities: LifeOpsGoogleCapability[];
  grantedScopes: string[];
  expiresAt: string | null;
  hasRefreshToken: boolean;
}

function readEnvOverride(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function resolveConfiguredGoogleModes(
  env: NodeJS.ProcessEnv = process.env,
): LifeOpsConnectorMode[] {
  const modes: LifeOpsConnectorMode[] = [];
  if (readEnvOverride(env, DESKTOP_CLIENT_ID_KEYS)) {
    modes.push("local");
  }
  if (
    readEnvOverride(env, WEB_CLIENT_ID_KEYS) &&
    readEnvOverride(env, WEB_CLIENT_SECRET_KEYS) &&
    readEnvOverride(env, PUBLIC_BASE_URL_KEYS)
  ) {
    modes.push("remote");
  }
  return modes;
}

export function resolveGoogleDefaultMode(
  requestUrl: URL,
  env: NodeJS.ProcessEnv = process.env,
): LifeOpsConnectorMode {
  const configuredModes = resolveConfiguredGoogleModes(env);
  const loopbackRequest = isLoopbackHostname(requestUrl.hostname);

  if (loopbackRequest && configuredModes.includes("local")) {
    return "local";
  }
  if (!loopbackRequest && configuredModes.includes("remote")) {
    return "remote";
  }
  if (configuredModes.length > 0) {
    return configuredModes[0] ?? "local";
  }
  return loopbackRequest ? "local" : "remote";
}

export function resolveGoogleOAuthConfig(
  requestUrl: URL,
  requestedMode?: LifeOpsConnectorMode,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedGoogleOAuthConfig {
  const availableModes = resolveConfiguredGoogleModes(env);
  const defaultMode = resolveGoogleDefaultMode(requestUrl, env);
  const mode = requestedMode ?? defaultMode;

  if (mode === "local") {
    const clientId = readEnvOverride(env, DESKTOP_CLIENT_ID_KEYS) ?? null;
    const clientSecret =
      readEnvOverride(env, DESKTOP_CLIENT_SECRET_KEYS) ?? null;
    const port =
      requestUrl.port || (requestUrl.protocol === "https:" ? "443" : "80");
    return {
      mode,
      defaultMode,
      availableModes,
      configured: clientId !== null,
      clientId,
      clientSecret,
      redirectUri: `http://127.0.0.1:${port}/api/lifeops/connectors/google/callback`,
    };
  }

  const clientId = readEnvOverride(env, WEB_CLIENT_ID_KEYS) ?? null;
  const clientSecret = readEnvOverride(env, WEB_CLIENT_SECRET_KEYS) ?? null;
  const publicBaseUrl = readEnvOverride(env, PUBLIC_BASE_URL_KEYS);

  return {
    mode,
    defaultMode,
    availableModes,
    configured: Boolean(clientId && clientSecret && publicBaseUrl),
    clientId,
    clientSecret,
    redirectUri: publicBaseUrl
      ? `${normalizeBaseUrl(publicBaseUrl)}/api/lifeops/connectors/google/callback`
      : `${requestUrl.origin}/api/lifeops/connectors/google/callback`,
  };
}

function requireGoogleOAuthConfig(
  config: ResolvedGoogleOAuthConfig,
  requestUrl: URL,
): asserts config is ResolvedGoogleOAuthConfig & {
  clientId: string;
} {
  if (config.mode === "local" && !isLoopbackHostname(requestUrl.hostname)) {
    throw new GoogleOAuthError(
      400,
      "Local Google OAuth requires the API to be addressed over a loopback host.",
    );
  }
  if (!config.configured || !config.clientId) {
    throw new GoogleOAuthError(
      503,
      `Google OAuth ${config.mode} mode is not configured.`,
    );
  }
  if (config.mode === "remote" && !config.clientSecret) {
    throw new GoogleOAuthError(
      503,
      "Google OAuth remote mode is missing the web client secret.",
    );
  }
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

function pendingGoogleOAuthSessionDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveOAuthDir(env), "lifeops", "google", "pending-sessions");
}

function pendingGoogleOAuthSessionPath(
  state: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(
    pendingGoogleOAuthSessionDir(env),
    `${sanitizePathSegment(state)}.json`,
  );
}

function writePendingGoogleOAuthSession(
  session: PendingGoogleOAuthSession,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const filePath = pendingGoogleOAuthSessionPath(session.state, env);
  ensureTokenStorageDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

function readPendingGoogleOAuthSession(
  state: string,
  env: NodeJS.ProcessEnv = process.env,
): PendingGoogleOAuthSession | null {
  const filePath = pendingGoogleOAuthSessionPath(state, env);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      fs.readFileSync(filePath, "utf8"),
    ) as PendingGoogleOAuthSession;
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.state === state &&
      typeof parsed.agentId === "string" &&
      typeof parsed.clientId === "string" &&
      typeof parsed.redirectUri === "string" &&
      typeof parsed.codeVerifier === "string" &&
      typeof parsed.createdAt === "number"
    ) {
      return parsed;
    }
  } catch {
    // Invalid pending-session state is treated as absent and will be overwritten
    // by a fresh auth flow.
  }
  fs.rmSync(filePath, { force: true });
  return null;
}

function deletePendingGoogleOAuthSession(
  state: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  fs.rmSync(pendingGoogleOAuthSessionPath(state, env), { force: true });
}

function cleanupExpiredGoogleOAuthSessions(
  now = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const [state, session] of pendingGoogleOAuthSessions.entries()) {
    if (now - session.createdAt > GOOGLE_OAUTH_SESSION_TTL_MS) {
      pendingGoogleOAuthSessions.delete(state);
    }
  }

  const dir = pendingGoogleOAuthSessionDir(env);
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const entry of fs.readdirSync(dir)) {
    const filePath = path.join(dir, entry);
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
        state?: string;
        createdAt?: number;
      };
      if (
        typeof raw.state !== "string" ||
        typeof raw.createdAt !== "number" ||
        now - raw.createdAt > GOOGLE_OAUTH_SESSION_TTL_MS
      ) {
        fs.rmSync(filePath, { force: true });
      }
    } catch {
      fs.rmSync(filePath, { force: true });
    }
  }
}

function clearPendingSessionsForAgent(
  agentId: string,
  side: LifeOpsConnectorSide,
  mode: LifeOpsConnectorMode,
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const [state, session] of pendingGoogleOAuthSessions.entries()) {
    if (
      session.agentId === agentId &&
      session.side === side &&
      session.mode === mode
    ) {
      pendingGoogleOAuthSessions.delete(state);
      deletePendingGoogleOAuthSession(state, env);
    }
  }

  const dir = pendingGoogleOAuthSessionDir(env);
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const entry of fs.readdirSync(dir)) {
    const filePath = path.join(dir, entry);
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
        state?: string;
        agentId?: string;
        side?: LifeOpsConnectorSide;
        mode?: LifeOpsConnectorMode;
      };
      if (raw.agentId === agentId && raw.side === side && raw.mode === mode) {
        fs.rmSync(filePath, { force: true });
      }
    } catch {
      fs.rmSync(filePath, { force: true });
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

async function readGoogleErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) {
    return `Google request failed with ${response.status}`;
  }

  try {
    const parsed = JSON.parse(text) as {
      error?: string;
      error_description?: string;
      error_description_internal?: string;
    };
    return (
      parsed.error_description ||
      parsed.error_description_internal ||
      parsed.error ||
      text
    );
  } catch {
    return text;
  }
}

function tokenStorageRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveOAuthDir(env), "lifeops", "google");
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function ensureTokenStorageDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function buildGoogleTokenRef(
  agentId: string,
  side: LifeOpsConnectorSide,
  mode: LifeOpsConnectorMode,
  grantId?: string,
): string {
  const filename = grantId ? `${mode}_${grantId}.json` : `${mode}.json`;
  return path.join(
    sanitizePathSegment(agentId),
    sanitizePathSegment(side),
    filename,
  );
}

function resolveTokenPath(
  tokenRef: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(tokenStorageRoot(env), tokenRef);
}

function readStoredGoogleTokenFile(
  tokenRef: string,
  env: NodeJS.ProcessEnv = process.env,
): StoredGoogleConnectorToken | null {
  const filePath = resolveTokenPath(tokenRef, env);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<StoredGoogleConnectorToken>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return {
      ...(parsed as StoredGoogleConnectorToken),
      side: parsed.side === "agent" ? "agent" : "owner",
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function writeStoredGoogleTokenFile(
  tokenRef: string,
  token: StoredGoogleConnectorToken,
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

export function deleteStoredGoogleToken(
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

export function readStoredGoogleToken(
  tokenRef: string,
  env: NodeJS.ProcessEnv = process.env,
): StoredGoogleConnectorToken | null {
  return readStoredGoogleTokenFile(tokenRef, env);
}

function parseIdTokenClaims(
  idToken: string | undefined,
): Record<string, unknown> {
  if (!idToken) {
    return {};
  }
  const segments = idToken.split(".");
  if (segments.length < 2) {
    return {};
  }
  try {
    const json = Buffer.from(segments[1] ?? "", "base64url").toString("utf-8");
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function fetchGoogleUserInfo(
  accessToken: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(rewriteGoogleUrlForMock(GOOGLE_USERINFO_ENDPOINT), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!response.ok) {
    throw new GoogleOAuthError(502, await readGoogleErrorMessage(response));
  }
  const parsed = (await response.json()) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GoogleOAuthError(
      502,
      "Google userinfo returned an invalid payload.",
    );
  }
  return parsed as Record<string, unknown>;
}

function readGoogleIdentityEmail(identity: Record<string, unknown>): string | null {
  const value = identity.email ?? identity.emailAddress ?? identity.primaryEmail;
  if (typeof value !== "string") {
    return null;
  }
  const email = value.trim();
  return email.length > 0 ? email : null;
}

function requireGoogleIdentity(
  identity: Record<string, unknown>,
): Record<string, unknown> {
  const email = readGoogleIdentityEmail(identity);
  if (!email) {
    throw new GoogleOAuthError(
      502,
      "Google identity payload did not include an email address.",
    );
  }
  return {
    ...identity,
    email,
  };
}

async function exchangeGoogleToken(
  params: URLSearchParams,
): Promise<GoogleTokenResponse> {
  const response = await fetch(rewriteGoogleUrlForMock(GOOGLE_TOKEN_ENDPOINT), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    throw new GoogleOAuthError(502, await readGoogleErrorMessage(response));
  }

  const parsed = (await response.json()) as GoogleTokenResponse;
  if (!parsed.access_token || !Number.isFinite(parsed.expires_in)) {
    throw new GoogleOAuthError(
      502,
      "Google token exchange returned an invalid payload.",
    );
  }
  return parsed;
}

function buildStoredGoogleToken(
  session: PendingGoogleOAuthSession,
  token: GoogleTokenResponse,
  grantedScopes: string[],
  existing: StoredGoogleConnectorToken | null,
): StoredGoogleConnectorToken {
  const now = new Date();
  const refreshTokenExpiresAt =
    typeof token.refresh_token_expires_in === "number" &&
    Number.isFinite(token.refresh_token_expires_in)
      ? Date.now() + token.refresh_token_expires_in * 1000
      : (existing?.refreshTokenExpiresAt ?? null);

  return {
    provider: "google",
    agentId: session.agentId,
    side: session.side,
    mode: session.mode,
    clientId: session.clientId,
    redirectUri: session.redirectUri,
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? existing?.refreshToken ?? null,
    tokenType: token.token_type || existing?.tokenType || "Bearer",
    grantedScopes,
    expiresAt: Date.now() + token.expires_in * 1000,
    refreshTokenExpiresAt,
    createdAt: existing?.createdAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export function startGoogleConnectorOAuth(args: {
  agentId: string;
  side?: LifeOpsConnectorSide;
  requestUrl: URL;
  mode?: LifeOpsConnectorMode;
  requestedCapabilities?: readonly LifeOpsGoogleCapability[];
  existingCapabilities?: readonly LifeOpsGoogleCapability[];
  /** When re-authenticating an existing account, pass its grant ID. */
  grantId?: string;
  env?: NodeJS.ProcessEnv;
}): StartLifeOpsGoogleConnectorResponse {
  cleanupExpiredGoogleOAuthSessions(Date.now(), args.env);

  const config = resolveGoogleOAuthConfig(args.requestUrl, args.mode, args.env);
  requireGoogleOAuthConfig(config, args.requestUrl);
  const side = args.side ?? "owner";
  clearPendingSessionsForAgent(args.agentId, side, config.mode, args.env);

  const requestedCapabilities = unionGoogleCapabilities(
    args.existingCapabilities,
    args.requestedCapabilities
      ? normalizeGoogleCapabilities(args.requestedCapabilities)
      : undefined,
  );
  const scopes = googleCapabilitiesToScopes(requestedCapabilities);
  const state = createState();
  const codeVerifier = createCodeVerifier();
  const codeChallenge = createCodeChallenge(codeVerifier);

  const pendingSession: PendingGoogleOAuthSession = {
    state,
    agentId: args.agentId,
    side,
    mode: config.mode,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
    requestedCapabilities,
    codeVerifier,
    createdAt: Date.now(),
    grantId: args.grantId,
  };
  pendingGoogleOAuthSessions.set(state, pendingSession);
  writePendingGoogleOAuthSession(pendingSession, args.env);

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    state,
    access_type: "offline",
    prompt: "consent",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    include_granted_scopes: "true",
  });

  return {
    provider: "google",
    side,
    mode: config.mode,
    requestedCapabilities,
    redirectUri: config.redirectUri,
    authUrl: `${GOOGLE_AUTHORIZATION_ENDPOINT}?${params.toString()}`,
  };
}

export async function completeGoogleConnectorOAuth(args: {
  callbackUrl: URL;
  env?: NodeJS.ProcessEnv;
}): Promise<GoogleConnectorCallbackResult> {
  cleanupExpiredGoogleOAuthSessions(Date.now(), args.env);

  const state = args.callbackUrl.searchParams.get("state")?.trim();
  if (!state) {
    throw new GoogleOAuthError(400, "Google callback is missing state.");
  }

  const session =
    pendingGoogleOAuthSessions.get(state) ??
    readPendingGoogleOAuthSession(state, args.env);
  if (!session) {
    throw new GoogleOAuthError(
      400,
      "Google callback does not match an active login session.",
    );
  }
  pendingGoogleOAuthSessions.set(state, session);
  pendingGoogleOAuthSessions.delete(state);
  deletePendingGoogleOAuthSession(state, args.env);

  if (Date.now() - session.createdAt > GOOGLE_OAUTH_SESSION_TTL_MS) {
    throw new GoogleOAuthError(
      410,
      "Google login session expired. Start the connection flow again.",
    );
  }

  const upstreamError = args.callbackUrl.searchParams.get("error")?.trim();
  if (upstreamError) {
    const description =
      args.callbackUrl.searchParams.get("error_description")?.trim() ||
      upstreamError;
    throw new GoogleOAuthError(400, description);
  }

  const code = args.callbackUrl.searchParams.get("code")?.trim();
  if (!code) {
    throw new GoogleOAuthError(
      400,
      "Google callback is missing an authorization code.",
    );
  }

  const params = new URLSearchParams({
    client_id: session.clientId,
    code,
    code_verifier: session.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: session.redirectUri,
  });
  if (session.clientSecret) {
    params.set("client_secret", session.clientSecret);
  }

  const token = await exchangeGoogleToken(params);
  const grantedScopes = splitScopes(token.scope);
  const normalizedScopes =
    grantedScopes.length > 0
      ? grantedScopes
      : googleCapabilitiesToScopes(session.requestedCapabilities);
  const grantedCapabilities =
    googleScopesToCapabilities(normalizedScopes).length > 0
      ? googleScopesToCapabilities(normalizedScopes)
      : normalizeGoogleCapabilities(session.requestedCapabilities);

  let identity = parseIdTokenClaims(token.id_token);
  if (Object.keys(identity).length === 0) {
    identity = await fetchGoogleUserInfo(token.access_token);
  }
  identity = requireGoogleIdentity(identity);

  const tokenRef = buildGoogleTokenRef(
    session.agentId,
    session.side,
    session.mode,
    session.grantId,
  );
  const existing = readStoredGoogleTokenFile(tokenRef, args.env);
  const storedToken = buildStoredGoogleToken(
    session,
    token,
    normalizedScopes,
    existing,
  );
  writeStoredGoogleTokenFile(tokenRef, storedToken, args.env);

  return {
    agentId: session.agentId,
    side: session.side,
    mode: session.mode,
    grantId: session.grantId,
    tokenRef,
    identity,
    grantedCapabilities,
    grantedScopes: normalizedScopes,
    expiresAt: new Date(storedToken.expiresAt).toISOString(),
    hasRefreshToken: Boolean(storedToken.refreshToken),
  };
}

/**
 * In-flight refresh promises keyed by tokenRef. Deduplicates concurrent
 * callers so only one token exchange runs per tokenRef at a time — prevents
 * the race where parallel refreshes overwrite each other's tokens on disk.
 */
const inflightRefreshes = new Map<
  string,
  Promise<StoredGoogleConnectorToken>
>();

export async function ensureFreshGoogleAccessToken(
  tokenRef: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StoredGoogleConnectorToken> {
  const stored = readStoredGoogleTokenFile(tokenRef, env);
  if (!stored) {
    throw new GoogleOAuthError(404, "Google connector token is missing.");
  }
  if (stored.expiresAt > Date.now() + GOOGLE_ACCESS_TOKEN_REFRESH_BUFFER_MS) {
    return stored;
  }
  if (!stored.refreshToken) {
    throw new GoogleOAuthError(
      401,
      "Google connector needs re-authentication.",
    );
  }

  // Deduplicate concurrent refreshes for the same tokenRef
  const existing = inflightRefreshes.get(tokenRef);
  if (existing) {
    return existing;
  }

  const refreshPromise = refreshGoogleAccessTokenImpl(tokenRef, stored, env);
  inflightRefreshes.set(tokenRef, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    inflightRefreshes.delete(tokenRef);
  }
}

async function refreshGoogleAccessTokenImpl(
  tokenRef: string,
  stored: StoredGoogleConnectorToken,
  env: NodeJS.ProcessEnv,
): Promise<StoredGoogleConnectorToken> {
  const params = new URLSearchParams({
    client_id: stored.clientId,
    grant_type: "refresh_token",
    refresh_token: stored.refreshToken!,
  });
  if (stored.mode === "remote") {
    const clientSecret = readEnvOverride(env, WEB_CLIENT_SECRET_KEYS);
    if (!clientSecret) {
      throw new GoogleOAuthError(
        503,
        "Google OAuth remote mode is missing the web client secret.",
      );
    }
    params.set("client_secret", clientSecret);
  } else if (stored.mode === "local") {
    const clientSecret = readEnvOverride(env, DESKTOP_CLIENT_SECRET_KEYS);
    if (clientSecret) {
      params.set("client_secret", clientSecret);
    }
  }

  const token = await exchangeGoogleToken(params);
  const grantedScopes = splitScopes(token.scope);
  const storedToken = buildStoredGoogleToken(
    {
      state: "refresh",
      agentId: stored.agentId,
      side: stored.side,
      mode: stored.mode,
      clientId: stored.clientId,
      clientSecret:
        stored.mode === "remote"
          ? (readEnvOverride(env, WEB_CLIENT_SECRET_KEYS) ?? null)
          : null,
      redirectUri: stored.redirectUri,
      requestedCapabilities: googleScopesToCapabilities(stored.grantedScopes),
      codeVerifier: "",
      createdAt: Date.now(),
    },
    token,
    grantedScopes.length > 0 ? grantedScopes : stored.grantedScopes,
    stored,
  );
  writeStoredGoogleTokenFile(tokenRef, storedToken, env);
  return storedToken;
}
