/**
 * Twitter Automation Service
 *
 * Handles OAuth 1.0a and OAuth2 flows for X/Twitter integration.
 * OAuth 1.0a requires API key/secret plus per-user access token/secret.
 * OAuth2 requires a client ID and optionally a client secret depending on app type.
 */

import { type TOAuth2Scope, TwitterApi } from "twitter-api-v2";
import {
  buildRedisClient,
  type CompatibleRedis,
  isCloudflareWorkerRuntime,
  supportsRedisEval,
} from "../../cache/redis-factory";
import { logger } from "../../utils/logger";
import type { OAuthConnectionRole } from "../oauth/types";
import { secretsService } from "../secrets";
import {
  getTwitterOAuth2ClientAuthMode,
  hasTwitterOAuth2ClientId,
  normalizeTwitterOAuth2AuthorizeUrl,
  parseTwitterOAuth2Scope,
  requestTwitterOAuth2Token,
  requireTwitterOAuth2ClientId,
} from "./oauth2-client";

// Platform app credentials from environment
const TWITTER_API_KEY = process.env.TWITTER_API_KEY!;
const TWITTER_API_SECRET_KEY = process.env.TWITTER_API_SECRET_KEY!;

type TwitterOAuthFlow = "oauth1a" | "oauth2";

const TWITTER_OAUTH2_SCOPES: TOAuth2Scope[] = [
  "tweet.read",
  "tweet.write",
  "users.read",
  "dm.read",
  "dm.write",
  "offline.access",
];

interface TwitterApiErrorShape {
  code?: number;
  data?: {
    status?: number;
    detail?: string;
    title?: string;
    error?: string;
    errors?: Array<{
      detail?: string;
      message?: string;
      title?: string;
      errors?: Array<{ message?: string }>;
    }>;
  };
}

const TWITTER_SECRET_FIELDS = {
  accessToken: "ACCESS_TOKEN",
  accessTokenSecret: "ACCESS_TOKEN_SECRET",
  oauth2AccessToken: "OAUTH2_ACCESS_TOKEN",
  oauth2RefreshToken: "OAUTH2_REFRESH_TOKEN",
  oauth2Scope: "OAUTH2_SCOPE",
  oauth2ExpiresAt: "OAUTH2_EXPIRES_AT",
  authMode: "AUTH_MODE",
  username: "USERNAME",
  userId: "USER_ID",
} as const;

const LEGACY_TWITTER_SECRET_NAMES: Partial<
  Record<keyof typeof TWITTER_SECRET_FIELDS, string | readonly string[]>
> = {
  accessToken: "TWITTER_ACCESS_TOKEN",
  accessTokenSecret: "TWITTER_ACCESS_TOKEN_SECRET",
  oauth2AccessToken: "TWITTER_OAUTH_ACCESS_TOKEN",
  oauth2RefreshToken: ["TWITTER_OAUTH_REFRESH_TOKEN", "TWITTER_OAUTH_RERESH_TOKEN"],
  username: "TWITTER_USERNAME",
  userId: "TWITTER_USER_ID",
} as const;

function normalizeConnectionRole(role?: OAuthConnectionRole): OAuthConnectionRole {
  return role === "agent" ? "agent" : "owner";
}

/** Converts an OAuth2 `expires_in` lifetime into an absolute epoch-seconds deadline. */
function oauth2ExpiryFromLifetime(expiresInSeconds: number | undefined): number | null {
  return typeof expiresInSeconds === "number" && Number.isFinite(expiresInSeconds)
    ? Math.floor(Date.now() / 1000) + Math.floor(expiresInSeconds)
    : null;
}

/** Refresh this many seconds ahead of the stored expiry so vended tokens outlive transit. */
const OAUTH2_BROKER_REFRESH_MARGIN_SECONDS = 5 * 60;

/**
 * Cross-isolate mutual exclusion for OAuth2 refresh (#19873 P1): the
 * refresh token is SINGLE-USE, and the per-instance `refreshRequests` map
 * cannot stop two Worker isolates from burning the same one (the second
 * gets invalid_grant and X may revoke the whole grant family). The TTL sits
 * far above the worst observed token round-trip + secret writes; hard
 * serialization beyond TTL expiry (a Durable Object per org+role) remains an
 * open architecture option with the #20016 reviewer.
 */
const OAUTH2_REFRESH_LEASE_MS = 120_000;
const OAUTH2_REFRESH_WAIT_POLL_MS = 1_500;

/** Release-only-what-you-own: delete iff the stored owner token is ours. */
const OAUTH2_REFRESH_LEASE_RELEASE_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

function refreshLeaseKey(organizationId: string, role: OAuthConnectionRole): string {
  return `x-oauth2-refresh:${organizationId}:${role}`;
}

let cachedLeaseRedis: CompatibleRedis | null = null;

/**
 * Runtime-aware Redis for the refresh lease, used DIRECTLY instead of the
 * cache client: the cache's Worker path prefers CACHE_KV, whose `set nx`
 * emulation is documented non-atomic and eventually consistent (#20016
 * review P1) — useless for mutual exclusion. Redis SET NX PX is atomic on
 * both supported transports. Selection mirrors jwt-internal-denylist:
 * Workers build a per-call REST-only client (cached TCP sockets belong to
 * the request that opened them, and inherited TCP REDIS_URLs are
 * unreachable from workerd); Node caches the normal client.
 */
function getRefreshLeaseRedis(): CompatibleRedis | null {
  if (!isCloudflareWorkerRuntime()) {
    if (cachedLeaseRedis) return cachedLeaseRedis;
    const client = buildRedisClient(process.env);
    if (client) cachedLeaseRedis = client;
    return client;
  }
  return buildRedisClient({
    MOCK_REDIS: process.env.MOCK_REDIS,
    KV_REST_API_URL: process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
}

function freshStoredOAuth2Broker(stored: Awaited<ReturnType<typeof getRoleCredentials>>): {
  authMode: "oauth2";
  accessToken: string;
  expiresAt: number | null;
  scope: string | null;
  twitterUserId: string | null;
} | null {
  if (!stored.oauth2AccessToken) return null;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (
    stored.oauth2ExpiresAt === null ||
    nowSeconds >= stored.oauth2ExpiresAt - OAUTH2_BROKER_REFRESH_MARGIN_SECONDS
  ) {
    return null;
  }
  return {
    authMode: "oauth2",
    accessToken: stored.oauth2AccessToken,
    expiresAt: stored.oauth2ExpiresAt,
    scope: stored.oauth2Scope,
    twitterUserId: stored.twitterUserId,
  };
}

function roleSecretName(
  role: OAuthConnectionRole,
  field: keyof typeof TWITTER_SECRET_FIELDS,
): string {
  return `TWITTER_${role.toUpperCase()}_${TWITTER_SECRET_FIELDS[field]}`;
}

async function getRoleSecret(
  organizationId: string,
  role: OAuthConnectionRole,
  field: keyof typeof TWITTER_SECRET_FIELDS,
): Promise<string | null> {
  const roleScoped = await secretsService.get(organizationId, roleSecretName(role, field));
  if (roleScoped || role !== "owner") {
    return roleScoped;
  }
  const legacyNames = LEGACY_TWITTER_SECRET_NAMES[field];
  const names = Array.isArray(legacyNames) ? legacyNames : legacyNames ? [legacyNames] : [];
  for (const name of names) {
    const legacy = await secretsService.get(organizationId, name);
    if (legacy) return legacy;
  }
  return null;
}

function normalizeOptionalCredentialValue(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function addTwitterApiErrorPart(parts: string[], value: unknown): void {
  if (typeof value === "string" && value.trim().length > 0) {
    parts.push(value.trim());
  }
}

function getTwitterApiErrorStatus(error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  const errorShape = error as TwitterApiErrorShape;
  return errorShape.data?.status ?? errorShape.code ?? null;
}

function formatTwitterApiError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const errorShape = error as TwitterApiErrorShape;
  const parts = [error.message || fallback];

  addTwitterApiErrorPart(parts, errorShape.data?.detail);
  addTwitterApiErrorPart(parts, errorShape.data?.title);
  addTwitterApiErrorPart(parts, errorShape.data?.error);

  const errors = Array.isArray(errorShape.data?.errors) ? errorShape.data.errors : [];
  for (const item of errors) {
    addTwitterApiErrorPart(parts, item.detail);
    addTwitterApiErrorPart(parts, item.message);
    addTwitterApiErrorPart(parts, item.title);

    const nestedErrors = Array.isArray(item.errors) ? item.errors : [];
    for (const nested of nestedErrors) {
      addTwitterApiErrorPart(parts, nested.message);
    }
  }

  return [...new Set(parts)].join(" - ");
}

async function getRoleCredentials(
  organizationId: string,
  role: OAuthConnectionRole,
): Promise<{
  accessToken: string | null;
  accessSecret: string | null;
  oauth2AccessToken: string | null;
  oauth2RefreshToken: string | null;
  oauth2Scope: string | null;
  oauth2ExpiresAt: number | null;
  authMode: string | null;
  username: string | null;
  twitterUserId: string | null;
}> {
  const [
    accessToken,
    accessSecret,
    oauth2AccessToken,
    oauth2RefreshToken,
    oauth2Scope,
    oauth2ExpiresAtRaw,
    authMode,
    username,
    twitterUserId,
  ] = await Promise.all([
    getRoleSecret(organizationId, role, "accessToken"),
    getRoleSecret(organizationId, role, "accessTokenSecret"),
    getRoleSecret(organizationId, role, "oauth2AccessToken"),
    getRoleSecret(organizationId, role, "oauth2RefreshToken"),
    getRoleSecret(organizationId, role, "oauth2Scope"),
    getRoleSecret(organizationId, role, "oauth2ExpiresAt"),
    getRoleSecret(organizationId, role, "authMode"),
    getRoleSecret(organizationId, role, "username"),
    getRoleSecret(organizationId, role, "userId"),
  ]);
  const oauth2ExpiresAtParsed = Number.parseInt(oauth2ExpiresAtRaw ?? "", 10);
  return {
    accessToken,
    accessSecret,
    oauth2AccessToken,
    oauth2RefreshToken,
    oauth2Scope,
    oauth2ExpiresAt: Number.isFinite(oauth2ExpiresAtParsed) ? oauth2ExpiresAtParsed : null,
    authMode,
    username,
    twitterUserId,
  };
}

async function upsertRoleSecret(args: {
  organizationId: string;
  userId: string;
  name: string;
  value: string;
  audit: {
    actorType: "user";
    actorId: string;
    source: string;
  };
}): Promise<void> {
  try {
    await secretsService.create(
      {
        organizationId: args.organizationId,
        name: args.name,
        value: args.value,
        scope: "organization",
        createdBy: args.userId,
      },
      args.audit,
    );
    return;
  } catch (error) {
    // error-policy:J1 optimistic upsert — a unique-constraint/duplicate conflict is the expected
    // "already stored, rotate instead" branch handled below; every other create failure rethrows.
    const message = error instanceof Error ? error.message : String(error);
    if (
      !message.includes("already exists") &&
      !message.includes("duplicate") &&
      !message.includes("unique constraint")
    ) {
      throw error;
    }
  }

  const existingSecret = (await secretsService.list(args.organizationId)).find(
    (secret) => secret.name === args.name,
  );
  if (!existingSecret) {
    throw new Error(`Secret '${args.name}' already exists but could not be loaded for rotation`);
  }
  await secretsService.rotate(existingSecret.id, args.organizationId, args.value, args.audit);
}

async function deleteRoleSecret(
  organizationId: string,
  role: OAuthConnectionRole,
  field: keyof typeof TWITTER_SECRET_FIELDS,
  audit: {
    actorType: "user";
    actorId: string;
    source: string;
  },
): Promise<void> {
  await secretsService.deleteByName(organizationId, roleSecretName(role, field), audit);
}

export interface TwitterOAuthState {
  oauthToken: string;
  oauthTokenSecret: string;
  organizationId: string;
  userId: string;
  connectionRole?: OAuthConnectionRole;
  redirectUrl?: string;
}

export type TwitterAuthLink =
  | {
      flow: "oauth1a";
      url: string;
      oauthToken: string;
      oauthTokenSecret: string;
    }
  | {
      flow: "oauth2";
      url: string;
      state: string;
      codeVerifier: string;
      redirectUri: string;
      scopes: string[];
    };

export interface TwitterConnectionStatus {
  connected: boolean;
  username?: string;
  userId?: string;
  avatarUrl?: string;
  error?: string;
}

export interface TwitterAutomationSettings {
  enabled: boolean;
  autoPost: boolean;
  autoReply: boolean;
  autoEngage: boolean;
  discovery: boolean;
  postIntervalMin: number;
  postIntervalMax: number;
  dryRun: boolean;
  targetUsers?: string;
}

class TwitterAutomationService {
  private readonly removeRequests = new Map<string, Promise<void>>();
  private readonly refreshRequests = new Map<
    string,
    Promise<{
      authMode: "oauth2";
      accessToken: string;
      expiresAt: number | null;
      scope: string | null;
      twitterUserId: string | null;
    }>
  >();

  private getOAuth2Client(): TwitterApi {
    return new TwitterApi({
      clientId: requireTwitterOAuth2ClientId(),
    });
  }

  private resolveOAuthFlow(): TwitterOAuthFlow {
    const configured = (process.env.TWITTER_OAUTH_FLOW ?? process.env.TWITTER_OAUTH_MODE ?? "")
      .trim()
      .toLowerCase();
    if (configured === "oauth1" || configured === "oauth1a") {
      return "oauth1a";
    }
    if (configured === "oauth2") {
      return "oauth2";
    }
    return hasTwitterOAuth2ClientId() ? "oauth2" : "oauth1a";
  }

  /**
   * Generate an authorization URL.
   *
   * X supports OAuth 1.0a and OAuth2 user-context auth. Prefer OAuth2 when
   * a client ID is configured because LifeOps reads/writes v2 endpoints and
   * the deployment secrets include OAuth2 app credentials.
   *
   * Step 1 of the 3-legged OAuth flow
   */
  async generateAuthLink(
    callbackUrl: string,
    connectionRole: OAuthConnectionRole = "owner",
  ): Promise<TwitterAuthLink> {
    const role = normalizeConnectionRole(connectionRole);
    if (this.resolveOAuthFlow() === "oauth2") {
      const authLink = this.getOAuth2Client().generateOAuth2AuthLink(callbackUrl, {
        scope: TWITTER_OAUTH2_SCOPES,
      });

      logger.info("[TwitterAutomation] Generated OAuth2 auth link", {
        state: authLink.state,
        connectionRole: role,
      });

      return {
        flow: "oauth2",
        url: normalizeTwitterOAuth2AuthorizeUrl(authLink.url),
        state: authLink.state,
        codeVerifier: authLink.codeVerifier,
        redirectUri: callbackUrl,
        scopes: TWITTER_OAUTH2_SCOPES,
      };
    }

    if (!TWITTER_API_KEY || !TWITTER_API_SECRET_KEY) {
      throw new Error(
        "Twitter API credentials not configured. Set TWITTER_API_KEY and TWITTER_API_SECRET_KEY in environment.",
      );
    }

    const client = new TwitterApi({
      appKey: TWITTER_API_KEY,
      appSecret: TWITTER_API_SECRET_KEY,
    });

    const authLink = await client.generateAuthLink(callbackUrl, {
      linkMode: "authorize",
    });

    logger.info("[TwitterAutomation] Generated auth link", {
      oauthToken: authLink.oauth_token,
      connectionRole: role,
    });

    return {
      flow: "oauth1a",
      url: authLink.url,
      oauthToken: authLink.oauth_token,
      oauthTokenSecret: authLink.oauth_token_secret,
    };
  }

  /**
   * Exchange OAuth verifier for access tokens
   * Step 3 of the 3-legged OAuth flow (after user authorizes)
   */
  async exchangeToken(
    oauthToken: string,
    oauthTokenSecret: string,
    oauthVerifier: string,
  ): Promise<{
    accessToken: string;
    accessSecret: string;
    screenName: string;
    userId: string;
  }> {
    if (!TWITTER_API_KEY || !TWITTER_API_SECRET_KEY) {
      throw new Error("Twitter API credentials not configured");
    }

    const client = new TwitterApi({
      appKey: TWITTER_API_KEY,
      appSecret: TWITTER_API_SECRET_KEY,
      accessToken: oauthToken,
      accessSecret: oauthTokenSecret,
    });

    const loginResult = await client.login(oauthVerifier);

    logger.info("[TwitterAutomation] Token exchange successful", {
      screenName: loginResult.screenName,
      userId: loginResult.userId,
    });

    return {
      accessToken: loginResult.accessToken,
      accessSecret: loginResult.accessSecret,
      screenName: loginResult.screenName,
      userId: loginResult.userId,
    };
  }

  async exchangeOAuth2Token(
    code: string,
    codeVerifier: string,
    redirectUri: string,
  ): Promise<{
    accessToken: string;
    refreshToken: string | null;
    scope: string[];
    /** Unix epoch seconds at which the access token expires, when X reported a lifetime. */
    expiresAt: number | null;
    screenName?: string;
    userId?: string;
    identityLookupError?: string;
  }> {
    const tokenResponse = await requestTwitterOAuth2Token({
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    });
    if (typeof tokenResponse.access_token !== "string" || tokenResponse.access_token.length === 0) {
      throw new Error("Twitter OAuth2 token response did not include an access token");
    }

    const client = new TwitterApi(tokenResponse.access_token);
    const scope = parseTwitterOAuth2Scope(tokenResponse.scope);
    let screenName: string | undefined;
    let userId: string | undefined;
    let identityLookupError: string | undefined;

    try {
      const me = await client.v2.me();
      screenName = me.data.username;
      userId = me.data.id;
    } catch (error) {
      // error-policy:J7 profile lookup is best-effort enrichment after a successful token
      // exchange; the failure is surfaced to the caller via identityLookupError (never faked as a
      // resolved identity) so the already-valid access token still flows through.
      identityLookupError = formatTwitterApiError(error, "Failed to fetch X profile");
      logger.warn("[TwitterAutomation] OAuth2 profile lookup failed after token exchange", {
        error: identityLookupError,
        status: getTwitterApiErrorStatus(error),
        clientAuthMode: getTwitterOAuth2ClientAuthMode(),
      });
    }

    logger.info("[TwitterAutomation] OAuth2 token exchange successful", {
      screenName,
      userId,
      identityResolved: Boolean(screenName && userId),
      clientAuthMode: getTwitterOAuth2ClientAuthMode(),
    });

    return {
      accessToken: tokenResponse.access_token,
      refreshToken:
        typeof tokenResponse.refresh_token === "string" && tokenResponse.refresh_token.length > 0
          ? tokenResponse.refresh_token
          : null,
      scope: scope.length > 0 ? scope : TWITTER_OAUTH2_SCOPES,
      expiresAt: oauth2ExpiryFromLifetime(tokenResponse.expires_in),
      screenName,
      userId,
      identityLookupError,
    };
  }

  /**
   * Store user's Twitter credentials in secrets
   */
  async storeCredentials(
    organizationId: string,
    userId: string,
    credentials: {
      accessToken: string;
      accessSecret?: string | null;
      refreshToken?: string | null;
      scope?: string[] | null;
      /** Unix epoch seconds at which an OAuth2 access token expires. */
      expiresAt?: number | null;
      screenName?: string;
      twitterUserId?: string;
      authMode?: TwitterOAuthFlow;
    },
    connectionRole: OAuthConnectionRole = "owner",
  ): Promise<void> {
    const role = normalizeConnectionRole(connectionRole);
    const authMode = credentials.authMode ?? (credentials.accessSecret ? "oauth1a" : "oauth2");
    const screenName = normalizeOptionalCredentialValue(credentials.screenName);
    const twitterUserId = normalizeOptionalCredentialValue(credentials.twitterUserId);
    const audit = {
      actorType: "user" as const,
      actorId: userId,
      source: "twitter-automation",
    };

    if (authMode === "oauth1a" && (!screenName || !twitterUserId)) {
      throw new Error("OAuth 1.0a credentials require a screen name and user ID");
    }

    const writes: Promise<void>[] = [
      screenName
        ? upsertRoleSecret({
            organizationId,
            userId,
            name: roleSecretName(role, "username"),
            value: screenName,
            audit,
          })
        : deleteRoleSecret(organizationId, role, "username", audit),
      twitterUserId
        ? upsertRoleSecret({
            organizationId,
            userId,
            name: roleSecretName(role, "userId"),
            value: twitterUserId,
            audit,
          })
        : deleteRoleSecret(organizationId, role, "userId", audit),
      upsertRoleSecret({
        organizationId,
        userId,
        name: roleSecretName(role, "authMode"),
        value: authMode,
        audit,
      }),
    ];

    if (authMode === "oauth1a") {
      if (!credentials.accessSecret) {
        throw new Error("OAuth 1.0a credentials require an access token secret");
      }
      writes.push(
        upsertRoleSecret({
          organizationId,
          userId,
          name: roleSecretName(role, "accessToken"),
          value: credentials.accessToken,
          audit,
        }),
        upsertRoleSecret({
          organizationId,
          userId,
          name: roleSecretName(role, "accessTokenSecret"),
          value: credentials.accessSecret,
          audit,
        }),
        deleteRoleSecret(organizationId, role, "oauth2AccessToken", audit),
        deleteRoleSecret(organizationId, role, "oauth2RefreshToken", audit),
        deleteRoleSecret(organizationId, role, "oauth2Scope", audit),
        deleteRoleSecret(organizationId, role, "oauth2ExpiresAt", audit),
      );
    } else {
      // The refresh token is the only irreplaceable value in the rotated
      // tuple: the previous one is burned at X the moment the rotation
      // succeeds. Persist it FIRST, alone, and awaited — if any later write
      // fails, the stored refresh token is already the new valid one and the
      // next refresh self-heals. The prior all-parallel write could persist a
      // new access token while LOSING the new refresh token, permanently
      // stranding the account on the burned one (#19873 P1). Note the
      // sibling writes below start executing at creation, so sequencing
      // requires awaiting here, not reordering the array.
      if (credentials.refreshToken) {
        await upsertRoleSecret({
          organizationId,
          userId,
          name: roleSecretName(role, "oauth2RefreshToken"),
          value: credentials.refreshToken,
          audit,
        });
      } else if (credentials.refreshToken === null) {
        await deleteRoleSecret(organizationId, role, "oauth2RefreshToken", audit);
      }
      writes.push(
        upsertRoleSecret({
          organizationId,
          userId,
          name: roleSecretName(role, "oauth2AccessToken"),
          value: credentials.accessToken,
          audit,
        }),
        upsertRoleSecret({
          organizationId,
          userId,
          name: roleSecretName(role, "oauth2Scope"),
          value: (credentials.scope ?? TWITTER_OAUTH2_SCOPES).join(" "),
          audit,
        }),
        deleteRoleSecret(organizationId, role, "accessToken", audit),
        deleteRoleSecret(organizationId, role, "accessTokenSecret", audit),
        typeof credentials.expiresAt === "number"
          ? upsertRoleSecret({
              organizationId,
              userId,
              name: roleSecretName(role, "oauth2ExpiresAt"),
              value: String(credentials.expiresAt),
              audit,
            })
          : deleteRoleSecret(organizationId, role, "oauth2ExpiresAt", audit),
      );
    }

    await Promise.all(writes);

    logger.info("[TwitterAutomation] Credentials stored", {
      organizationId,
      connectionRole: role,
      authMode,
      screenName,
    });
  }

  /**
   * Remove Twitter credentials (disconnect)
   */
  async removeCredentials(
    organizationId: string,
    userId: string,
    connectionRole: OAuthConnectionRole = "owner",
  ): Promise<void> {
    const role = normalizeConnectionRole(connectionRole);
    const requestKey = `${organizationId}:${role}`;
    const pending = this.removeRequests.get(requestKey);
    if (pending) return pending;

    const request = this.removeCredentialsNow(organizationId, userId, role).finally(() => {
      this.removeRequests.delete(requestKey);
    });
    this.removeRequests.set(requestKey, request);
    return request;
  }

  private async removeCredentialsNow(
    organizationId: string,
    userId: string,
    role: OAuthConnectionRole,
  ): Promise<void> {
    const audit = {
      actorType: "user" as const,
      actorId: userId,
      source: "twitter-automation",
    };

    const secretNames = [
      roleSecretName(role, "accessToken"),
      roleSecretName(role, "accessTokenSecret"),
      roleSecretName(role, "oauth2AccessToken"),
      roleSecretName(role, "oauth2RefreshToken"),
      roleSecretName(role, "oauth2Scope"),
      roleSecretName(role, "oauth2ExpiresAt"),
      roleSecretName(role, "authMode"),
      roleSecretName(role, "username"),
      roleSecretName(role, "userId"),
      ...(role === "owner"
        ? Object.values(LEGACY_TWITTER_SECRET_NAMES).flatMap((name) =>
            Array.isArray(name) ? name : name ? [name] : [],
          )
        : []),
    ];

    const existingSecrets = await secretsService.list(organizationId);
    const uniqueSecretNames = [...new Set(secretNames)];

    for (const name of uniqueSecretNames) {
      const secret = existingSecrets.find((item) => item.name === name);
      if (!secret) continue;

      try {
        await secretsService.delete(secret.id, organizationId, audit);
        logger.info("[TwitterAutomation] Deleted secret", {
          name,
          organizationId,
          connectionRole: role,
        });
      } catch (error) {
        // error-policy:J6 idempotent disconnect teardown — a not-found/already-deleted secret is
        // an acceptable no-op; any other delete failure rethrows so a genuine failure surfaces.
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("Secret not found") && !message.includes("Failed to delete secret")) {
          throw error;
        }
        logger.debug("[TwitterAutomation] Secret already removed during disconnect", {
          name,
          organizationId,
          connectionRole: role,
          error: message,
        });
      }
    }

    logger.info("[TwitterAutomation] Credentials removed", {
      organizationId,
      connectionRole: role,
    });
  }

  /**
   * Check if Twitter is connected for an organization
   */
  async getConnectionStatus(
    organizationId: string,
    connectionRole: OAuthConnectionRole = "owner",
  ): Promise<TwitterConnectionStatus> {
    const role = normalizeConnectionRole(connectionRole);
    const { accessToken, accessSecret, oauth2AccessToken, username, twitterUserId } =
      await getRoleCredentials(organizationId, role);

    if ((!accessToken || !accessSecret) && !oauth2AccessToken) {
      return { connected: false };
    }

    // Optionally validate the token is still valid
    try {
      const client =
        accessToken && accessSecret
          ? new TwitterApi({
              appKey: TWITTER_API_KEY,
              appSecret: TWITTER_API_SECRET_KEY,
              accessToken,
              accessSecret,
            })
          : new TwitterApi(oauth2AccessToken!);

      const me = await client.v2.me({
        "user.fields": ["profile_image_url"],
      });

      return {
        connected: true,
        username: me.data.username,
        userId: me.data.id,
        avatarUrl: me.data.profile_image_url,
      };
    } catch (error) {
      // error-policy:J4 token-validation failure degrades to a distinguishable connection status
      // carrying an explicit error field — never a silent healthy/empty state. A missing-credentials
      // case returns { connected:false } with no error above; this branch always sets error.
      const errorMessage = formatTwitterApiError(error, "Token validation failed");
      logger.warn("[TwitterAutomation] Token validation failed", {
        organizationId,
        connectionRole: role,
        error: errorMessage,
        status: getTwitterApiErrorStatus(error),
      });

      if (oauth2AccessToken && getTwitterApiErrorStatus(error) === 403) {
        return {
          connected: true,
          username: username ?? undefined,
          userId: twitterUserId ?? undefined,
          error: `X rejected profile validation, but OAuth2 credentials are stored: ${errorMessage}`,
        };
      }

      return {
        connected: false,
        username: username ?? undefined,
        userId: twitterUserId ?? undefined,
        error: "Token may be expired. Try reconnecting.",
      };
    }
  }

  /** Reads the stored account identity without contacting X or refreshing tokens. */
  async getStoredConnectionIdentity(
    organizationId: string,
    connectionRole: OAuthConnectionRole = "owner",
  ): Promise<{ username: string | null; twitterUserId: string | null }> {
    const stored = await getRoleCredentials(
      organizationId,
      normalizeConnectionRole(connectionRole),
    );
    return { username: stored.username, twitterUserId: stored.twitterUserId };
  }

  /**
   * Get credentials for injecting into character settings
   * Used by agent-loader when Twitter is enabled
   */
  async getCredentialsForAgent(
    organizationId: string,
    connectionRole: OAuthConnectionRole = "agent",
  ): Promise<Record<string, string> | null> {
    const role = normalizeConnectionRole(connectionRole);
    const credentials = await getRoleCredentials(organizationId, role);
    const {
      accessToken,
      accessSecret,
      oauth2AccessToken,
      oauth2RefreshToken,
      oauth2Scope,
      oauth2ExpiresAt,
      twitterUserId,
    } = credentials;

    if (accessToken && accessSecret) {
      return {
        TWITTER_AUTH_MODE: "oauth1a",
        TWITTER_API_KEY,
        TWITTER_API_SECRET_KEY,
        TWITTER_ACCESS_TOKEN: accessToken,
        TWITTER_ACCESS_TOKEN_SECRET: accessSecret,
        ...(twitterUserId ? { TWITTER_USER_ID: twitterUserId } : {}),
      };
    }

    if (oauth2AccessToken) {
      return {
        TWITTER_AUTH_MODE: "oauth2",
        TWITTER_OAUTH_ACCESS_TOKEN: oauth2AccessToken,
        ...(oauth2RefreshToken ? { TWITTER_OAUTH_REFRESH_TOKEN: oauth2RefreshToken } : {}),
        ...(oauth2Scope ? { TWITTER_OAUTH_SCOPE: oauth2Scope } : {}),
        ...(oauth2ExpiresAt !== null ? { TWITTER_OAUTH_EXPIRES_AT: String(oauth2ExpiresAt) } : {}),
        ...(twitterUserId ? { TWITTER_USER_ID: twitterUserId } : {}),
      };
    }

    return null;
  }

  /**
   * Vends broker credentials for `GET /api/v1/twitter/token`, owning the
   * OAuth2 refresh-and-rotate contract: when the stored access token is past
   * (or within the margin of) its recorded expiry — or has no recorded expiry,
   * which means it predates expiry tracking and X's two-hour token life has
   * certainly elapsed — and a refresh token exists, the token is refreshed
   * against X, the rotated access/refresh/expiry secrets are persisted, and
   * the fresh token is returned. Concurrent callers share one refresh so X's
   * single-use refresh tokens are never burned twice. A refresh failure
   * throws; it is never masked by vending a token known to be stale.
   */
  async getBrokerCredentials(
    organizationId: string,
    userId: string,
    connectionRole: OAuthConnectionRole = "agent",
  ): Promise<
    | { authMode: "oauth1a"; credentials: Record<string, string> }
    | {
        authMode: "oauth2";
        accessToken: string;
        expiresAt: number | null;
        scope: string | null;
        twitterUserId: string | null;
      }
    | null
  > {
    const role = normalizeConnectionRole(connectionRole);
    const stored = await getRoleCredentials(organizationId, role);

    if (stored.accessToken && stored.accessSecret) {
      const oauth1 = await this.getCredentialsForAgent(organizationId, role);
      return oauth1 ? { authMode: "oauth1a", credentials: oauth1 } : null;
    }
    if (!stored.oauth2AccessToken) {
      return null;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const needsRefresh =
      stored.oauth2ExpiresAt === null ||
      nowSeconds >= stored.oauth2ExpiresAt - OAUTH2_BROKER_REFRESH_MARGIN_SECONDS;

    if (!needsRefresh) {
      return {
        authMode: "oauth2",
        accessToken: stored.oauth2AccessToken,
        expiresAt: stored.oauth2ExpiresAt,
        scope: stored.oauth2Scope,
        twitterUserId: stored.twitterUserId,
      };
    }
    if (!stored.oauth2RefreshToken) {
      throw new Error(
        `Stored X OAuth2 ${role} token is expired but has no refresh token; reconnect the X account`,
      );
    }

    const refreshKey = `${organizationId}:${role}`;
    const pending = this.refreshRequests.get(refreshKey);
    if (pending) return pending;
    const request = this.refreshOAuth2BrokerTokenExclusive(
      organizationId,
      userId,
      role,
      stored.oauth2RefreshToken,
    ).finally(() => {
      this.refreshRequests.delete(refreshKey);
    });
    this.refreshRequests.set(refreshKey, request);
    return request;
  }

  /**
   * Cross-isolate wrapper around {@link refreshOAuth2BrokerToken} (#19873 P1).
   * The in-memory `refreshRequests` map dedupes only within one isolate; this
   * lease serializes refreshes ACROSS isolates so the single-use refresh token
   * is burned exactly once. The loser never contacts X: it waits for the
   * winner's store write and returns the freshly stored token. When no shared
   * cache backend exists, per-isolate dedupe is the honest ceiling and the
   * refresh proceeds as before.
   */
  private async refreshOAuth2BrokerTokenExclusive(
    organizationId: string,
    userId: string,
    role: OAuthConnectionRole,
    refreshToken: string,
  ): Promise<{
    authMode: "oauth2";
    accessToken: string;
    expiresAt: number | null;
    scope: string | null;
    twitterUserId: string | null;
  }> {
    const leaseKey = refreshLeaseKey(organizationId, role);
    const redis = getRefreshLeaseRedis();
    if (!redis) {
      // No Redis backend — cross-isolate exclusion is genuinely unsupported;
      // per-isolate dedupe is the honest ceiling (denylist-documented class).
      return this.refreshOAuth2BrokerToken(organizationId, userId, role, refreshToken);
    }

    const owner = crypto.randomUUID();
    let acquired = false;
    try {
      const result = await redis.set(leaseKey, owner, {
        nx: true,
        px: OAUTH2_REFRESH_LEASE_MS,
      });
      acquired = result === "OK";
    } catch {
      // Lease infrastructure failure must not fail the auth path closed;
      // degrade to per-isolate dedupe.
      return this.refreshOAuth2BrokerToken(organizationId, userId, role, refreshToken);
    }

    if (acquired) {
      try {
        // Double-check under the lease: another isolate may have completed a
        // refresh between our staleness read and the lease grant. Returning
        // the stored token avoids burning the (now stale) refresh token.
        const alreadyFresh = freshStoredOAuth2Broker(
          await getRoleCredentials(organizationId, role),
        );
        if (alreadyFresh) return alreadyFresh;
        return await this.refreshOAuth2BrokerToken(organizationId, userId, role, refreshToken);
      } finally {
        // Owner-fenced release: delete ONLY when the stored value is our own
        // owner token — a lease that expired mid-work and was reacquired by
        // another isolate must never be deleted by us (#20016 review P1).
        // Without eval support the TTL is the release.
        if (supportsRedisEval(redis)) {
          await redis
            .eval(OAUTH2_REFRESH_LEASE_RELEASE_SCRIPT, [leaseKey], [owner])
            .catch(() => undefined);
        }
      }
    }

    // Lease lost: an isolate elsewhere is mid-refresh with the same
    // single-use token. Wait for its store write instead of racing it.
    const deadline = Date.now() + OAUTH2_REFRESH_LEASE_MS + OAUTH2_REFRESH_WAIT_POLL_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, OAUTH2_REFRESH_WAIT_POLL_MS));
      const refreshed = freshStoredOAuth2Broker(await getRoleCredentials(organizationId, role));
      if (refreshed) return refreshed;
    }
    throw new Error(
      `X OAuth2 ${role} refresh is contended and the winning isolate did not persist a fresh token in time; retry shortly`,
    );
  }

  private async refreshOAuth2BrokerToken(
    organizationId: string,
    userId: string,
    role: OAuthConnectionRole,
    refreshToken: string,
  ): Promise<{
    authMode: "oauth2";
    accessToken: string;
    expiresAt: number | null;
    scope: string | null;
    twitterUserId: string | null;
  }> {
    const tokenResponse = await requestTwitterOAuth2Token({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    if (typeof tokenResponse.access_token !== "string" || tokenResponse.access_token.length === 0) {
      throw new Error("Twitter OAuth2 refresh response did not include an access token");
    }

    const stored = await getRoleCredentials(organizationId, role);
    const scope = parseTwitterOAuth2Scope(tokenResponse.scope);
    const expiresAt = oauth2ExpiryFromLifetime(tokenResponse.expires_in);
    await this.storeCredentials(
      organizationId,
      userId,
      {
        accessToken: tokenResponse.access_token,
        refreshToken:
          typeof tokenResponse.refresh_token === "string" && tokenResponse.refresh_token.length > 0
            ? tokenResponse.refresh_token
            : refreshToken,
        scope: scope.length > 0 ? scope : parseTwitterOAuth2Scope(stored.oauth2Scope ?? undefined),
        expiresAt,
        screenName: stored.username ?? undefined,
        twitterUserId: stored.twitterUserId ?? undefined,
        authMode: "oauth2",
      },
      role,
    );

    logger.info("[TwitterAutomation] OAuth2 broker token refreshed", {
      organizationId,
      connectionRole: role,
      expiresAt,
    });

    return {
      authMode: "oauth2",
      accessToken: tokenResponse.access_token,
      expiresAt,
      scope: scope.length > 0 ? scope.join(" ") : stored.oauth2Scope,
      twitterUserId: stored.twitterUserId,
    };
  }

  hasOAuth1AppCredentials(): boolean {
    return Boolean(TWITTER_API_KEY && TWITTER_API_SECRET_KEY);
  }

  hasOAuth2AppCredentials(): boolean {
    return hasTwitterOAuth2ClientId();
  }

  getDefaultOAuthFlow(): TwitterOAuthFlow {
    return this.resolveOAuthFlow();
  }

  isConfigured(): boolean {
    return this.hasOAuth1AppCredentials() || this.hasOAuth2AppCredentials();
  }
}

export const twitterAutomationService = new TwitterAutomationService();

// Re-export app automation service
export {
  type GeneratedTweet,
  type TwitterAutomationConfig,
  twitterAppAutomationService,
} from "./app-automation";
