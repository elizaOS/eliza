/**
 * CloudAuthService — Eliza Cloud authentication entry points.
 *
 * Two distinct auth flows live here:
 *
 * 1. **Device auto-signup** (`authenticateWithDevice`) — convenience-only.
 *    Derives a hardware fingerprint and exchanges it for a free-tier API key
 *    against the cloud signup endpoint. The result is treated as opaque and
 *    is **never** trusted as inbound auth for the local Eliza dashboard.
 *    See `docs/security/remote-auth-hardening-plan.md` §7 for the explicit
 *    demotion rationale.
 *
 * 2. **Eliza Cloud SSO** (`getSsoRedirectUrl` / `exchangeCodeForSession`) —
 *    OAuth-style authorization-code flow against the cloud issuer. The
 *    callback handler in `app-core` (`api/auth/cloud-sso.ts`) consumes these
 *    methods to bind a verified cloud user to a local Identity. All error
 *    paths fail closed: the methods throw and the caller MUST refuse the
 *    request. There is no partial-claims fallback.
 */

import {
  type RuntimeEnvRecord,
  type IAgentRuntime,
  logger,
  Service,
  resolveApiSecurityConfig,
  resolveDesktopApiPort,
} from "@elizaos/core";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { CloudCredentials, DeviceAuthResponse, DevicePlatform } from "../types/cloud";
import { DEFAULT_CLOUD_CONFIG } from "../types/cloud";
import { CloudApiClient } from "../utils/cloud-api";
import type { CloudBootstrapService } from "./cloud-bootstrap";

/** SHA-256 hash of hostname + platform + arch + cpu + memory. */
async function deriveDeviceId(): Promise<string> {
  const os = await import("node:os");
  const crypto = await import("node:crypto");
  const cpus = os.cpus();
  const raw = [
    os.hostname(),
    os.platform(),
    os.arch(),
    cpus[0]?.model ?? "?",
    cpus.length,
    os.totalmem(),
  ].join(":");
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function detectPlatform(): DevicePlatform {
  if (typeof process === "undefined") return "web";
  const map: Record<string, DevicePlatform> = {
    darwin: "macos",
    win32: "windows",
    linux: "linux",
  };
  return map[process.platform] ?? "linux";
}

// ─── Eliza Cloud SSO ───────────────────────────────────────────────────────

/**
 * Required ID-token claims for an Eliza Cloud SSO exchange.
 *
 * `sub` is the cloud user id (canonical identity key). `email` and `name`
 * are surfaced for UI display and identity provisioning. Anything else the
 * cloud issuer adds is preserved on `extra` for callers that need it but
 * is never required for auth decisions.
 */
export interface CloudSsoIdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  email: string;
  email_verified?: boolean;
  name: string;
  picture?: string;
  extra: Record<string, unknown>;
}

export interface CloudSsoSession {
  cloudUserId: string;
  email: string;
  displayName: string;
  claims: CloudSsoIdTokenClaims;
}

export interface SsoRedirectArgs {
  /**
   * Local URL the user should land on after the SSO round-trip
   * (e.g. `/onboarding/setup`). The dashboard's callback route forwards
   * to this once the session cookie is set; it is NOT sent to the cloud
   * issuer.
   */
  returnTo?: string;
  /**
   * State nonce. The caller is responsible for generating this with
   * `crypto.randomBytes(32)` and storing it server-side keyed by the
   * issued cookie / pending exchange.
   */
  state: string;
  /**
   * Override for `ELIZA_CLOUD_CLIENT_ID`. Falls through to the env when
   * unset; explicitly throws when neither is provided.
   */
  clientId?: string;
  /** Allows tests to inject a synthetic env record. */
  env?: RuntimeEnvRecord;
}

export interface ExchangeCodeArgs {
  /** Authorization code returned on the SSO callback. */
  code: string;
  /** State value the cloud issuer echoed back on the callback. */
  state: string;
  /**
   * State value the caller originally issued. Compared with `state` and
   * mismatch causes a fail-closed throw before any network call is made.
   */
  expectedState: string;
  /**
   * Source for `getJwksUrl()`. The caller resolves this from the runtime
   * service registry (`runtime.getService("CLOUD_BOOTSTRAP")`) so this
   * file does not import from `app-core` directly.
   */
  bootstrap: CloudBootstrapService;
  /** Allows tests to inject a fake fetch for the token endpoint. */
  fetchImpl?: typeof fetch;
  /** Allows tests to inject a synthetic env record. */
  env?: RuntimeEnvRecord;
  /** Optional override for the redirect URI; defaults to the local callback. */
  redirectUri?: string;
}

interface RawTokenResponse {
  id_token?: unknown;
  access_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

interface ApiKeyAuthInput {
  apiKey: string;
  organizationId?: string;
  userId?: string;
}

interface RawIdTokenPayload {
  iss?: unknown;
  sub?: unknown;
  aud?: unknown;
  exp?: unknown;
  iat?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
  picture?: unknown;
  [otherProperty: string]: unknown;
}

function readEnvKey(env: RuntimeEnvRecord, key: string): string | null {
  const value = env[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function processEnv(): RuntimeEnvRecord {
  if (typeof process === "undefined") return {};
  return process.env as RuntimeEnvRecord;
}

/**
 * Build the local SSO callback URL the cloud issuer will redirect back to.
 *
 * Reads `ELIZA_API_BIND` and the desktop API port from `@elizaos/core`'s
 * runtime-env helper so the redirect_uri matches whatever the dashboard
 * is actually serving on. Loopback binds default to `http://127.0.0.1:<port>`;
 * non-loopback binds (cloud-provisioned containers) use `https://`.
 */
function defaultRedirectUri(env: RuntimeEnvRecord): string {
  const security = resolveApiSecurityConfig(env);
  const port = resolveDesktopApiPort(env);
  const scheme = security.isLoopbackBind ? "http" : "https";
  // Strip any IPv6 brackets the bind host might already include.
  const host = security.bindHost.startsWith("[")
    ? security.bindHost
    : security.bindHost.includes(":") && !security.bindHost.startsWith("[")
      ? `[${security.bindHost}]`
      : security.bindHost;
  return `${scheme}://${host}:${port}/api/auth/login/sso/callback`;
}

/**
 * Returns the absolute URL the dashboard should redirect the user to in
 * order to start an Eliza Cloud SSO authorization-code flow.
 *
 * Throws when `ELIZA_CLOUD_CLIENT_ID` is unset and no `clientId` override
 * is provided — there is no built-in default. `ELIZA_CLOUD_ISSUER` is read
 * via the `CloudBootstrapService`'s service-port and must already be set;
 * if not, this method throws via the bootstrap's existing fail-closed
 * behaviour.
 *
 * The `state` argument MUST be generated by the caller with a cryptographic
 * RNG and stored server-side bound to the issued cookie. This method does
 * NOT generate or persist state.
 *
 * @param bootstrap - Service-port that exposes `getExpectedIssuer()`.
 * @param args - Required `state`, optional `clientId` / `returnTo` / `env`.
 */
export function getSsoRedirectUrl(bootstrap: CloudBootstrapService, args: SsoRedirectArgs): string {
  const env = args.env ?? processEnv();
  const clientId = args.clientId ?? readEnvKey(env, "ELIZA_CLOUD_CLIENT_ID");
  if (!clientId) {
    throw new Error("ELIZA_CLOUD_CLIENT_ID is not configured — cannot start Eliza Cloud SSO");
  }
  if (args.state.length === 0) {
    throw new Error("getSsoRedirectUrl requires a non-empty state nonce");
  }
  const issuer = bootstrap.getExpectedIssuer();
  const redirectUri = defaultRedirectUri(env);
  const params = new URLSearchParams();
  params.set("response_type", "code");
  params.set("client_id", clientId);
  params.set("redirect_uri", redirectUri);
  params.set("scope", "openid profile");
  params.set("state", args.state);
  if (args.returnTo) {
    // Forwarded through state on the cloud side is not safe (issuer-controlled);
    // we surface it as a separate hint that the local callback honours.
    params.set("eliza_return_to", args.returnTo);
  }
  return `${issuer}/oauth/authorize?${params.toString()}`;
}

function shapeIdTokenClaims(payload: RawIdTokenPayload): CloudSsoIdTokenClaims {
  if (typeof payload.iss !== "string" || payload.iss.length === 0) {
    throw new Error("id_token missing issuer claim");
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("id_token missing sub claim");
  }
  if (
    typeof payload.aud !== "string" &&
    !(Array.isArray(payload.aud) && payload.aud.every((value) => typeof value === "string"))
  ) {
    throw new Error("id_token missing or malformed aud claim");
  }
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    throw new Error("id_token missing exp claim");
  }
  if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat)) {
    throw new Error("id_token missing iat claim");
  }
  if (typeof payload.email !== "string" || payload.email.length === 0) {
    throw new Error("id_token missing email claim — Eliza Cloud SSO requires it");
  }
  if (typeof payload.name !== "string" || payload.name.length === 0) {
    throw new Error("id_token missing name claim — Eliza Cloud SSO requires it");
  }
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (
      key !== "iss" &&
      key !== "sub" &&
      key !== "aud" &&
      key !== "exp" &&
      key !== "iat" &&
      key !== "email" &&
      key !== "email_verified" &&
      key !== "name" &&
      key !== "picture"
    ) {
      extra[key] = value;
    }
  }
  return {
    iss: payload.iss,
    sub: payload.sub,
    aud: payload.aud as string | string[],
    exp: payload.exp,
    iat: payload.iat,
    email: payload.email,
    email_verified:
      typeof payload.email_verified === "boolean" ? payload.email_verified : undefined,
    name: payload.name,
    picture: typeof payload.picture === "string" ? payload.picture : undefined,
    extra,
  };
}

function shapeTokenResponse(payload: unknown): { idToken: string } {
  if (!payload || typeof payload !== "object") {
    throw new Error("Eliza Cloud token endpoint returned a non-object body");
  }
  const raw = payload as RawTokenResponse;
  if (typeof raw.id_token !== "string" || raw.id_token.length === 0) {
    throw new Error("Eliza Cloud token endpoint did not return an id_token");
  }
  return { idToken: raw.id_token };
}

/**
 * Exchange an authorization code for a verified Eliza Cloud session.
 *
 * Steps:
 *   1. Compare `state === expectedState`. Mismatch throws.
 *   2. POST to `${ELIZA_CLOUD_ISSUER}/oauth/token` with the code,
 *      `client_id`, and `client_secret` (the latter from
 *      `ELIZA_CLOUD_CLIENT_SECRET`).
 *   3. Verify the returned `id_token` against the JWKS exposed by
 *      `CloudBootstrapService.getJwksUrl()`. RS256 only.
 *   4. Project the claims onto a `CloudSsoSession`.
 *
 * Any error in fetch / signature verify / claim shape throws — this method
 * NEVER returns a partial or fallback session.
 */
export async function exchangeCodeForSession(args: ExchangeCodeArgs): Promise<CloudSsoSession> {
  if (args.code.length === 0) {
    throw new Error("exchangeCodeForSession requires a non-empty code");
  }
  if (!args.state || !args.expectedState || args.state !== args.expectedState) {
    throw new Error("Eliza Cloud SSO state mismatch — refusing to exchange code (possible CSRF)");
  }

  const env = args.env ?? processEnv();
  const clientId = readEnvKey(env, "ELIZA_CLOUD_CLIENT_ID");
  if (!clientId) {
    throw new Error("ELIZA_CLOUD_CLIENT_ID is not configured — cannot complete Eliza Cloud SSO");
  }
  const clientSecret = readEnvKey(env, "ELIZA_CLOUD_CLIENT_SECRET");
  if (!clientSecret) {
    throw new Error(
      "ELIZA_CLOUD_CLIENT_SECRET is not configured — cannot complete Eliza Cloud SSO"
    );
  }

  const issuer = args.bootstrap.getExpectedIssuer();
  const redirectUri = args.redirectUri ?? defaultRedirectUri(env);
  const tokenUrl = `${issuer}/oauth/token`;

  const fetchImpl = args.fetchImpl ?? fetch;
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", args.code);
  body.set("redirect_uri", redirectUri);
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);

  const response = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new Error(
      `Eliza Cloud token endpoint returned HTTP ${response.status} for code exchange`
    );
  }
  const payload: unknown = await response.json();
  const { idToken } = shapeTokenResponse(payload);

  const jwksUrl = args.bootstrap.getJwksUrl();
  const remoteJwks = createRemoteJWKSet(new URL(jwksUrl));

  const verified = await jwtVerify(idToken, remoteJwks, {
    algorithms: ["RS256"],
    issuer,
    audience: clientId,
  });

  const claims = shapeIdTokenClaims(verified.payload as RawIdTokenPayload);

  return {
    cloudUserId: claims.sub,
    email: claims.email,
    displayName: claims.name,
    claims,
  };
}

// ─── Service ───────────────────────────────────────────────────────────────

export class CloudAuthService extends Service {
  static serviceType = "CLOUD_AUTH";
  capabilityDescription = "Eliza Cloud device authentication and SSO session helpers";

  private client: CloudApiClient;
  private credentials: CloudCredentials | null = null;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    this.client = new CloudApiClient(DEFAULT_CLOUD_CONFIG.baseUrl);
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new CloudAuthService(runtime);
    await service.initialize();
    return service;
  }

  async stop(): Promise<void> {
    this.credentials = null;
  }

  private async initialize(): Promise<void> {
    const baseUrl = String(
      this.runtime.getSetting("ELIZAOS_CLOUD_BASE_URL") ?? DEFAULT_CLOUD_CONFIG.baseUrl
    );
    this.client.setBaseUrl(baseUrl);

    // Try existing API key first.  If the key is present in settings
    // (persisted via config file or character secrets in the DB), trust it
    // immediately so the agent is functional even when the cloud API is
    // temporarily unreachable.  A background validation fires to confirm
    // the key — if it turns out to be revoked the next model call will
    // surface the error, but the agent won't stall on startup.
    const existingKey = this.runtime.getSetting("ELIZAOS_CLOUD_API_KEY");
    if (existingKey) {
      const key = String(existingKey);
      this.client.setApiKey(key);

      // Accept the key optimistically — no blocking network call.
      this.credentials = {
        apiKey: key,
        userId: String(this.runtime.getSetting("ELIZAOS_CLOUD_USER_ID") ?? ""),
        organizationId: String(
          this.runtime.getSetting("ELIZAOS_CLOUD_ORG_ID") ??
            this.runtime.getSetting("ELIZA_CLOUD_ORGANIZATION_ID") ??
            ""
        ),
        authenticatedAt: Date.now(),
      };
      logger.info("[CloudAuth] Authenticated with saved API key");

      // Non-blocking validation — if the key is invalid the next model
      // call will surface the error; we just log a warning here.
      this.validateApiKey(key)
        .then((valid) => {
          if (!valid) {
            logger.warn(
              "[CloudAuth] Saved API key could not be validated (cloud may be unreachable or key revoked) — model calls will use the key anyway"
            );
          }
        })
        .catch(() => {
          // Swallow — already logged inside validateApiKey
        });
      return;
    }

    // Device-based auto-signup when explicitly enabled
    const enabled = this.runtime.getSetting("ELIZAOS_CLOUD_ENABLED");
    if (enabled === "true" || enabled === "1") {
      try {
        await this.authenticateWithDevice();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[CloudAuth] Device auth failed (cloud may be unreachable): ${msg}`);
        logger.info(
          "[CloudAuth] Service will start unauthenticated — cloud features disabled until connectivity is restored"
        );
      }
    } else {
      logger.info("[CloudAuth] Cloud not enabled (set ELIZAOS_CLOUD_ENABLED=true)");
    }
  }

  private async validateApiKey(key: string): Promise<boolean> {
    try {
      const validationClient = new CloudApiClient(this.client.getBaseUrl(), key);
      await validationClient.get("/models", { timeoutMs: 10_000 });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[CloudAuth] Could not reach cloud API to validate key: ${msg}`);
      return false;
    }
  }

  /**
   * Free-tier device auto-signup. **Convenience only — not a security
   * primitive.** The hardware fingerprint is treated as opaque material the
   * cloud signup endpoint can use to mint a fresh API key + $5 free credit
   * for new installs. The result is usable for outbound LLM calls; it never
   * authorizes inbound dashboard access.
   *
   * See `docs/security/remote-auth-hardening-plan.md` §7.
   */
  async authenticateWithDevice(): Promise<CloudCredentials> {
    const deviceId = await deriveDeviceId();
    const platform = detectPlatform();
    const appVersion = process.env.ELIZAOS_CLOUD_APP_VERSION ?? "2.0.0-beta.0";
    const os = await import("node:os");

    logger.info(`[CloudAuth] Authenticating device (platform=${platform})`);

    const response = await this.client.postUnauthenticated<DeviceAuthResponse>("/device-auth", {
      deviceId,
      platform,
      appVersion,
      deviceName: os.hostname(),
    });

    this.credentials = {
      apiKey: response.data.apiKey,
      userId: response.data.userId,
      organizationId: response.data.organizationId,
      authenticatedAt: Date.now(),
    };
    this.client.setApiKey(response.data.apiKey);

    const action = response.data.isNew ? "New account created" : "Authenticated";
    logger.info(`[CloudAuth] ${action} (credits: $${response.data.credits.toFixed(2)})`);

    return this.credentials;
  }

  authenticateWithApiKey(input: ApiKeyAuthInput): CloudCredentials {
    const apiKey = input.apiKey.trim();
    if (!apiKey) {
      throw new Error("Eliza Cloud API key is required");
    }

    this.client.setApiKey(apiKey);
    this.credentials = {
      apiKey,
      userId: input.userId ?? "",
      organizationId: input.organizationId ?? "",
      authenticatedAt: Date.now(),
    };

    logger.info("[CloudAuth] Authenticated with API key");
    return this.credentials;
  }

  clearAuth(): void {
    this.credentials = null;
    this.client.setApiKey(undefined);
  }

  isAuthenticated(): boolean {
    return this.credentials !== null;
  }
  getCredentials(): CloudCredentials | null {
    return this.credentials;
  }
  getApiKey(): string | undefined {
    return this.credentials?.apiKey ?? this.client.getApiKey();
  }
  getClient(): CloudApiClient {
    return this.client;
  }
  getUserId(): string | undefined {
    return this.credentials?.userId;
  }
  getOrganizationId(): string | undefined {
    return this.credentials?.organizationId;
  }
}
