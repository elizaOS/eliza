import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveOAuthDir } from "@elizaos/agent";
import type {
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsHealthConnectorCapability,
  LifeOpsHealthConnectorProvider,
  StartLifeOpsHealthConnectorResponse,
} from "../contracts/health.js";
import {
  decryptTokenEnvelope,
  encryptTokenPayload,
  isEncryptedTokenEnvelope,
  resolveTokenEncryptionKey,
} from "../util/token-encryption.js";

const HEALTH_OAUTH_SESSION_TTL_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

const pendingHealthOAuthSessions = new Map<string, PendingHealthOAuthSession>();

export class HealthOAuthError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HealthOAuthError";
  }
}

export interface StoredHealthConnectorToken {
  provider: LifeOpsHealthConnectorProvider;
  agentId: string;
  side: LifeOpsConnectorSide;
  mode: LifeOpsConnectorMode;
  clientId: string;
  clientSecret: string | null;
  redirectUri: string;
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  grantedScopes: string[];
  expiresAt: number | null;
  identity: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface HealthConnectorCallbackResult {
  agentId: string;
  provider: LifeOpsHealthConnectorProvider;
  side: LifeOpsConnectorSide;
  mode: LifeOpsConnectorMode;
  tokenRef: string;
  identity: Record<string, unknown>;
  grantedCapabilities: LifeOpsHealthConnectorCapability[];
  grantedScopes: string[];
  expiresAt: string | null;
  hasRefreshToken: boolean;
}

export interface ResolvedHealthOAuthConfig {
  provider: LifeOpsHealthConnectorProvider;
  mode: LifeOpsConnectorMode;
  defaultMode: LifeOpsConnectorMode;
  availableModes: LifeOpsConnectorMode[];
  configured: boolean;
  clientId: string | null;
  clientSecret: string | null;
  redirectUri: string;
}

interface PendingHealthOAuthSession {
  state: string;
  provider: LifeOpsHealthConnectorProvider;
  agentId: string;
  side: LifeOpsConnectorSide;
  mode: LifeOpsConnectorMode;
  clientId: string;
  clientSecret: string | null;
  redirectUri: string;
  codeVerifier: string | null;
  requestedCapabilities: LifeOpsHealthConnectorCapability[];
  createdAt: number;
}

interface HealthOAuthProviderSpec {
  provider: LifeOpsHealthConnectorProvider;
  authUrl: string;
  tokenUrl: string;
  revokeUrl: string | null;
  envPrefix: string;
  defaultScopes: readonly string[];
  capabilities: readonly LifeOpsHealthConnectorCapability[];
  scopeSeparator: "space" | "comma";
  usePkce: boolean;
  tokenRequestStyle: "form" | "basic" | "withings";
}

interface HealthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  expires_at?: number;
  scope?: string;
  athlete?: Record<string, unknown>;
  user_id?: string;
  userid?: string | number;
}

type HealthTokenApiResponse =
  | HealthTokenResponse
  | { status?: number; body?: HealthTokenResponse; error?: string };

function isWrappedHealthTokenResponse(
  value: HealthTokenApiResponse,
): value is { status?: number; body?: HealthTokenResponse; error?: string } {
  return "status" in value || "body" in value || "error" in value;
}

function unwrapHealthTokenResponse(
  value: HealthTokenApiResponse,
  provider: LifeOpsHealthConnectorProvider,
): HealthTokenResponse {
  if (isWrappedHealthTokenResponse(value)) {
    if (value.status !== undefined && value.status !== 0) {
      throw new HealthOAuthError(502, `Token exchange failed for ${provider}`);
    }
    if (value.body) {
      return value.body;
    }
  }
  return value as HealthTokenResponse;
}

const HEALTH_OAUTH_SPECS: Record<
  LifeOpsHealthConnectorProvider,
  HealthOAuthProviderSpec
> = {
  strava: {
    provider: "strava",
    authUrl: "https://www.strava.com/oauth/authorize",
    tokenUrl: "https://www.strava.com/oauth/token",
    revokeUrl: "https://www.strava.com/oauth/deauthorize",
    envPrefix: "STRAVA",
    defaultScopes: ["read", "profile:read_all", "activity:read_all"],
    capabilities: ["health.activity.read", "health.workouts.read"],
    scopeSeparator: "comma",
    usePkce: false,
    tokenRequestStyle: "form",
  },
  fitbit: {
    provider: "fitbit",
    authUrl: "https://www.fitbit.com/oauth2/authorize",
    tokenUrl: "https://api.fitbit.com/oauth2/token",
    revokeUrl: "https://api.fitbit.com/oauth2/revoke",
    envPrefix: "FITBIT",
    defaultScopes: ["profile", "activity", "heartrate", "sleep", "weight"],
    capabilities: [
      "health.activity.read",
      "health.workouts.read",
      "health.sleep.read",
      "health.body.read",
      "health.vitals.read",
    ],
    scopeSeparator: "space",
    usePkce: true,
    tokenRequestStyle: "basic",
  },
  withings: {
    provider: "withings",
    authUrl: "https://account.withings.com/oauth2_user/authorize2",
    tokenUrl: "https://wbsapi.withings.net/v2/oauth2",
    revokeUrl: null,
    envPrefix: "WITHINGS",
    defaultScopes: [
      "user.info",
      "user.metrics",
      "user.activity",
      "user.sleepevents",
    ],
    capabilities: [
      "health.activity.read",
      "health.sleep.read",
      "health.body.read",
      "health.vitals.read",
    ],
    scopeSeparator: "comma",
    usePkce: false,
    tokenRequestStyle: "withings",
  },
  oura: {
    provider: "oura",
    authUrl: "https://cloud.ouraring.com/oauth/authorize",
    tokenUrl: "https://api.ouraring.com/oauth/token",
    revokeUrl: "https://api.ouraring.com/oauth/revoke",
    envPrefix: "OURA",
    defaultScopes: [
      "email",
      "personal",
      "daily",
      "heartrate",
      "workout",
      "spo2",
    ],
    capabilities: [
      "health.activity.read",
      "health.workouts.read",
      "health.sleep.read",
      "health.readiness.read",
      "health.body.read",
      "health.vitals.read",
    ],
    scopeSeparator: "space",
    usePkce: false,
    tokenRequestStyle: "basic",
  },
};

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

function readEnv(
  env: NodeJS.ProcessEnv,
  provider: LifeOpsHealthConnectorProvider,
  suffix: "CLIENT_ID" | "CLIENT_SECRET" | "PUBLIC_BASE_URL",
): string | null {
  const spec = HEALTH_OAUTH_SPECS[provider];
  const keys = [
    `ELIZA_${spec.envPrefix}_${suffix}`,
    `ELIZA_${spec.envPrefix}_${suffix}`,
  ];
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return null;
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function healthConnectorCapabilities(
  provider: LifeOpsHealthConnectorProvider,
): LifeOpsHealthConnectorCapability[] {
  return [...HEALTH_OAUTH_SPECS[provider].capabilities];
}

export function healthConnectorScopes(
  provider: LifeOpsHealthConnectorProvider,
): string[] {
  return [...HEALTH_OAUTH_SPECS[provider].defaultScopes];
}

export function healthScopesToCapabilities(
  provider: LifeOpsHealthConnectorProvider,
  scopes: readonly string[],
): LifeOpsHealthConnectorCapability[] {
  const set = new Set(scopes);
  if (provider === "strava") {
    return set.has("activity:read") || set.has("activity:read_all")
      ? ["health.activity.read", "health.workouts.read"]
      : [];
  }
  if (provider === "oura") {
    const capabilities: LifeOpsHealthConnectorCapability[] = [];
    if (set.has("daily")) {
      capabilities.push(
        "health.activity.read",
        "health.sleep.read",
        "health.readiness.read",
      );
    }
    if (set.has("workout")) capabilities.push("health.workouts.read");
    if (set.has("heartrate") || set.has("spo2"))
      capabilities.push("health.vitals.read");
    if (set.has("personal")) capabilities.push("health.body.read");
    return [...new Set(capabilities)];
  }
  if (provider === "fitbit") {
    const capabilities: LifeOpsHealthConnectorCapability[] = [];
    if (set.has("activity")) {
      capabilities.push("health.activity.read", "health.workouts.read");
    }
    if (set.has("sleep")) capabilities.push("health.sleep.read");
    if (set.has("heartrate")) capabilities.push("health.vitals.read");
    if (set.has("weight")) capabilities.push("health.body.read");
    return [...new Set(capabilities)];
  }
  const capabilities: LifeOpsHealthConnectorCapability[] = [];
  if (set.has("user.activity")) {
    capabilities.push("health.activity.read", "health.sleep.read");
  }
  if (set.has("user.sleepevents")) capabilities.push("health.sleep.read");
  if (set.has("user.metrics")) {
    capabilities.push("health.body.read", "health.vitals.read");
  }
  return [...new Set(capabilities)];
}

export function resolveHealthOAuthConfig(
  provider: LifeOpsHealthConnectorProvider,
  requestUrl: URL,
  requestedMode?: LifeOpsConnectorMode,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedHealthOAuthConfig {
  const localClientId = readEnv(env, provider, "CLIENT_ID");
  const localClientSecret = readEnv(env, provider, "CLIENT_SECRET");
  const publicBaseUrl = readEnv(env, provider, "PUBLIC_BASE_URL");
  const availableModes: LifeOpsConnectorMode[] = [];
  if (localClientId && localClientSecret) {
    availableModes.push("local");
  }
  if (localClientId && localClientSecret && publicBaseUrl) {
    availableModes.push("remote");
  }
  const defaultMode =
    isLoopbackHostname(requestUrl.hostname) && availableModes.includes("local")
      ? "local"
      : (availableModes[0] ??
        (isLoopbackHostname(requestUrl.hostname) ? "local" : "remote"));
  const mode = requestedMode ?? defaultMode;
  const port =
    requestUrl.port || (requestUrl.protocol === "https:" ? "443" : "80");
  const redirectUri =
    mode === "remote" && publicBaseUrl
      ? `${normalizeBaseUrl(publicBaseUrl)}/api/lifeops/connectors/health/${provider}/callback`
      : `http://127.0.0.1:${port}/api/lifeops/connectors/health/${provider}/callback`;

  return {
    provider,
    mode,
    defaultMode,
    availableModes,
    configured: Boolean(localClientId && localClientSecret),
    clientId: localClientId,
    clientSecret: localClientSecret,
    redirectUri,
  };
}

function requireHealthOAuthConfig(
  config: ResolvedHealthOAuthConfig,
  requestUrl: URL,
): asserts config is ResolvedHealthOAuthConfig & {
  clientId: string;
  clientSecret: string;
} {
  if (config.mode === "local" && !isLoopbackHostname(requestUrl.hostname)) {
    throw new HealthOAuthError(
      400,
      "Local health OAuth requires the API to be addressed over a loopback host.",
    );
  }
  if (!config.configured || !config.clientId || !config.clientSecret) {
    throw new HealthOAuthError(
      503,
      `${config.provider} OAuth ${config.mode} mode is not configured.`,
    );
  }
}

function base64Url(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function sha256Base64Url(value: string): string {
  return base64Url(crypto.createHash("sha256").update(value).digest());
}

function parseGrantedScopes(
  provider: LifeOpsHealthConnectorProvider,
  value: unknown,
): string[] {
  if (typeof value !== "string") {
    return healthConnectorScopes(provider);
  }
  return value
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function tokenExpiresAt(response: HealthTokenResponse): number | null {
  if (typeof response.expires_at === "number") {
    return response.expires_at * 1_000;
  }
  if (typeof response.expires_in === "number") {
    return Date.now() + response.expires_in * 1_000;
  }
  return null;
}

function tokenRefFor(args: {
  provider: LifeOpsHealthConnectorProvider;
  agentId: string;
  side: LifeOpsConnectorSide;
  mode: LifeOpsConnectorMode;
}): string {
  return path.join(args.agentId, args.side, args.mode, `${args.provider}.json`);
}

function tokenStorageRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveOAuthDir(env), "lifeops", "health");
}

function tokenPath(tokenRef: string, env: NodeJS.ProcessEnv): string {
  return path.join(tokenStorageRoot(env), tokenRef);
}

function writeStoredHealthToken(
  tokenRef: string,
  token: StoredHealthConnectorToken,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const filePath = tokenPath(tokenRef, env);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const key = resolveTokenEncryptionKey(tokenStorageRoot(env), env);
  const payload = JSON.stringify(token, null, 2);
  const encoded = JSON.stringify(encryptTokenPayload(payload, key), null, 2);
  fs.writeFileSync(filePath, encoded, { mode: 0o600 });
}

export function readStoredHealthToken(
  tokenRef: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): StoredHealthConnectorToken | null {
  if (!tokenRef) {
    return null;
  }
  const filePath = tokenPath(tokenRef, env);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isEncryptedTokenEnvelope(parsed)) {
    throw new Error("Stored health token is not encrypted. Re-link the account.");
  }
  const text = decryptTokenEnvelope(
    parsed,
    resolveTokenEncryptionKey(tokenStorageRoot(env), env),
  );
  return JSON.parse(text) as StoredHealthConnectorToken;
}

export function deleteStoredHealthToken(
  tokenRef: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!tokenRef) {
    return;
  }
  fs.rmSync(tokenPath(tokenRef, env), { force: true });
}

async function exchangeToken(
  session: PendingHealthOAuthSession,
  code: string,
): Promise<HealthTokenResponse> {
  const spec = HEALTH_OAUTH_SPECS[session.provider];
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: session.redirectUri,
  });
  if (spec.tokenRequestStyle === "withings") {
    body.set("action", "requesttoken");
  }
  if (spec.tokenRequestStyle !== "basic") {
    body.set("client_id", session.clientId);
    if (session.clientSecret) body.set("client_secret", session.clientSecret);
  }
  if (session.codeVerifier) {
    body.set("code_verifier", session.codeVerifier);
  }

  const response = await fetch(spec.tokenUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      ...(spec.tokenRequestStyle === "basic" && session.clientSecret
        ? {
            Authorization: `Basic ${Buffer.from(
              `${session.clientId}:${session.clientSecret}`,
            ).toString("base64")}`,
          }
        : {}),
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await response.json()) as HealthTokenApiResponse;
  if (!response.ok) {
    throw new HealthOAuthError(
      response.status,
      `Token exchange failed for ${session.provider}`,
    );
  }
  return unwrapHealthTokenResponse(json, session.provider);
}

export async function refreshStoredHealthToken(
  tokenRef: string | null | undefined,
): Promise<StoredHealthConnectorToken | null> {
  const token = readStoredHealthToken(tokenRef);
  if (!token?.refreshToken) {
    return token;
  }
  if (
    token.expiresAt !== null &&
    token.expiresAt - ACCESS_TOKEN_REFRESH_BUFFER_MS > Date.now()
  ) {
    return token;
  }
  const spec = HEALTH_OAUTH_SPECS[token.provider];
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: token.refreshToken,
  });
  if (spec.tokenRequestStyle === "withings") {
    body.set("action", "requesttoken");
    body.set("client_id", token.clientId);
    if (token.clientSecret) body.set("client_secret", token.clientSecret);
  } else if (spec.tokenRequestStyle !== "basic") {
    body.set("client_id", token.clientId);
    if (token.clientSecret) body.set("client_secret", token.clientSecret);
  }
  const response = await fetch(spec.tokenUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      ...(spec.tokenRequestStyle === "basic" && token.clientSecret
        ? {
            Authorization: `Basic ${Buffer.from(
              `${token.clientId}:${token.clientSecret}`,
            ).toString("base64")}`,
          }
        : {}),
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new HealthOAuthError(
      response.status,
      `${token.provider} token refresh failed`,
    );
  }
  const json = (await response.json()) as HealthTokenApiResponse;
  const payload = unwrapHealthTokenResponse(json, token.provider);
  if (!payload.access_token) {
    throw new HealthOAuthError(502, `${token.provider} token refresh failed`);
  }
  const next: StoredHealthConnectorToken = {
    ...token,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? token.refreshToken,
    tokenType: payload.token_type ?? token.tokenType,
    grantedScopes: parseGrantedScopes(token.provider, payload.scope),
    expiresAt: tokenExpiresAt(payload),
    updatedAt: new Date().toISOString(),
  };
  writeStoredHealthToken(tokenRef ?? tokenRefFor(token), next);
  return next;
}

export function startHealthConnectorOAuth(args: {
  provider: LifeOpsHealthConnectorProvider;
  agentId: string;
  side: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  requestUrl: URL;
  redirectUrl?: string;
  capabilities?: LifeOpsHealthConnectorCapability[];
}): StartLifeOpsHealthConnectorResponse {
  const config = resolveHealthOAuthConfig(
    args.provider,
    args.requestUrl,
    args.mode,
  );
  requireHealthOAuthConfig(config, args.requestUrl);
  const spec = HEALTH_OAUTH_SPECS[args.provider];
  const state = crypto.randomBytes(24).toString("hex");
  const codeVerifier = spec.usePkce ? base64Url(crypto.randomBytes(32)) : null;
  const scopes = healthConnectorScopes(args.provider);
  pendingHealthOAuthSessions.set(state, {
    state,
    provider: args.provider,
    agentId: args.agentId,
    side: args.side,
    mode: config.mode,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
    codeVerifier,
    requestedCapabilities:
      args.capabilities && args.capabilities.length > 0
        ? [...new Set(args.capabilities)]
        : healthConnectorCapabilities(args.provider),
    createdAt: Date.now(),
  });

  const authUrl = new URL(spec.authUrl);
  authUrl.searchParams.set("client_id", config.clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", config.redirectUri);
  authUrl.searchParams.set(
    "scope",
    scopes.join(spec.scopeSeparator === "comma" ? "," : " "),
  );
  authUrl.searchParams.set("state", state);
  if (args.provider === "strava") {
    authUrl.searchParams.set("approval_prompt", "auto");
  }
  if (codeVerifier) {
    authUrl.searchParams.set("code_challenge", sha256Base64Url(codeVerifier));
    authUrl.searchParams.set("code_challenge_method", "S256");
  }

  return {
    provider: args.provider,
    side: args.side,
    mode: config.mode,
    requestedCapabilities:
      args.capabilities && args.capabilities.length > 0
        ? [...new Set(args.capabilities)]
        : healthConnectorCapabilities(args.provider),
    redirectUri: config.redirectUri,
    authUrl: authUrl.toString(),
  };
}

export async function completeHealthConnectorOAuth(
  callbackUrl: URL,
): Promise<HealthConnectorCallbackResult> {
  const state = callbackUrl.searchParams.get("state") ?? "";
  const session = pendingHealthOAuthSessions.get(state);
  if (!session) {
    throw new HealthOAuthError(400, "Unknown or expired health OAuth session.");
  }
  pendingHealthOAuthSessions.delete(state);
  if (Date.now() - session.createdAt > HEALTH_OAUTH_SESSION_TTL_MS) {
    throw new HealthOAuthError(400, "Health OAuth session expired.");
  }
  const error = callbackUrl.searchParams.get("error");
  if (error) {
    throw new HealthOAuthError(
      400,
      `${session.provider} authorization failed: ${error}`,
    );
  }
  const code = callbackUrl.searchParams.get("code");
  if (!code) {
    throw new HealthOAuthError(400, "Missing health OAuth authorization code.");
  }

  const payload = await exchangeToken(session, code);
  if (!payload.access_token) {
    throw new HealthOAuthError(
      502,
      `${session.provider} token response missing access token.`,
    );
  }
  const scopes = parseGrantedScopes(session.provider, payload.scope);
  const identity =
    session.provider === "strava" && payload.athlete
      ? payload.athlete
      : {
          userId:
            payload.user_id ??
            payload.userid ??
            callbackUrl.searchParams.get("userid") ??
            null,
        };
  const nowIso = new Date().toISOString();
  const tokenRef = tokenRefFor(session);
  const token: StoredHealthConnectorToken = {
    provider: session.provider,
    agentId: session.agentId,
    side: session.side,
    mode: session.mode,
    clientId: session.clientId,
    clientSecret: session.clientSecret,
    redirectUri: session.redirectUri,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    tokenType: payload.token_type ?? "Bearer",
    grantedScopes: scopes,
    expiresAt: tokenExpiresAt(payload),
    identity,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  writeStoredHealthToken(tokenRef, token);
  return {
    agentId: session.agentId,
    provider: session.provider,
    side: session.side,
    mode: session.mode,
    tokenRef,
    identity,
    grantedCapabilities: healthScopesToCapabilities(session.provider, scopes),
    grantedScopes: scopes,
    expiresAt: token.expiresAt ? new Date(token.expiresAt).toISOString() : null,
    hasRefreshToken: Boolean(token.refreshToken),
  };
}
