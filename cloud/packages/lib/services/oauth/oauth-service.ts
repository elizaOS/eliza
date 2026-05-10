/**
 * OAuth Service
 *
 * Provides a consistent interface for OAuth credential management
 * across multiple platforms (Google, Twitter, Twilio, Blooio).
 */

import { and, eq } from "drizzle-orm";
import { dbRead } from "@/db/client";
import { platformCredentials } from "@/db/schemas/platform-credentials";
import { cache } from "@/lib/cache/client";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import { logger } from "@/lib/utils/logger";
import { getOAuthVersion, incrementOAuthVersion } from "./cache-version";
import { getAdapter, getAllAdapters } from "./connection-adapters";
import { Errors } from "./errors";
import { getProvider, isProviderConfigured, OAUTH_PROVIDERS } from "./provider-registry";
import { initiateOAuth2 } from "./providers";
import { tokenCache } from "./token-cache";
import type {
  GetTokenByPlatformParams,
  GetTokenParams,
  InitiateAuthParams,
  InitiateAuthResult,
  ListConnectionsParams,
  OAuthConnection,
  OAuthConnectionRole,
  OAuthProviderInfo,
  OAuthStandardConnectionRole,
  TokenResult,
} from "./types";
import { formatOAuthConnectionRole, normalizeOAuthConnectionRole } from "./types";

const DEFAULT_REDIRECT = "/dashboard/settings?tab=connections";
const STATE_TTL = 600; // 10 minutes
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type PlatformCredential = typeof platformCredentials.$inferSelect;

export function sortConnectionsByRecency(connections: OAuthConnection[]): OAuthConnection[] {
  return [...connections].sort((a, b) => {
    const aTime = a.lastUsedAt?.getTime() || a.linkedAt.getTime();
    const bTime = b.lastUsedAt?.getTime() || b.linkedAt.getTime();
    return bTime - aTime;
  });
}

export function getMostRecentActiveConnection(
  connections: OAuthConnection[],
): OAuthConnection | null {
  const active = connections.filter((c) => c.status === "active");
  if (active.length === 0) return null;
  return active.reduce((most, conn) => {
    const mostTime = most.lastUsedAt?.getTime() || most.linkedAt.getTime();
    const connTime = conn.lastUsedAt?.getTime() || conn.linkedAt.getTime();
    return connTime > mostTime ? conn : most;
  });
}

export function getPreferredActiveConnection(
  connections: OAuthConnection[],
  userId?: string,
  connectionRole?: OAuthConnectionRole,
): OAuthConnection | null {
  const normalizedRole = connectionRole ? normalizeOAuthConnectionRole(connectionRole) : undefined;
  const scopedByRole = normalizedRole
    ? connections.filter(
        (connection) => normalizeOAuthConnectionRole(connection.connectionRole) === normalizedRole,
      )
    : connections;
  if (!userId) {
    return getMostRecentActiveConnection(scopedByRole);
  }

  const ownedConnection = getMostRecentActiveConnection(
    scopedByRole.filter((connection) => connection.userId === userId),
  );
  if (ownedConnection) {
    return ownedConnection;
  }

  return getMostRecentActiveConnection(
    scopedByRole.filter((connection) => connection.userId === undefined),
  );
}

export function scopeConnectionsForUser(
  connections: OAuthConnection[],
  userId?: string,
  connectionRole?: OAuthConnectionRole,
): OAuthConnection[] {
  const normalizedRole = connectionRole ? normalizeOAuthConnectionRole(connectionRole) : undefined;
  const scopedByRole = normalizedRole
    ? connections.filter(
        (connection) => normalizeOAuthConnectionRole(connection.connectionRole) === normalizedRole,
      )
    : connections;
  if (!userId) {
    return sortConnectionsByRecency(scopedByRole);
  }

  const ownedConnections = sortConnectionsByRecency(
    scopedByRole.filter((connection) => connection.userId === userId),
  );
  const sharedConnections = sortConnectionsByRecency(
    scopedByRole.filter((connection) => connection.userId === undefined),
  );

  if (ownedConnections.length > 0) {
    return [...ownedConnections, ...sharedConnections];
  }

  return sharedConnections;
}

function connectionFromPlatformCredential(cred: PlatformCredential): OAuthConnection {
  return {
    id: cred.id,
    userId: cred.user_id || undefined,
    connectionRole: formatOAuthConnectionRole(getStoredConnectionRole(cred.source_context)),
    platform: cred.platform,
    platformUserId: cred.platform_user_id,
    email: cred.platform_email || undefined,
    username: cred.platform_username || undefined,
    displayName: cred.platform_display_name || undefined,
    avatarUrl: cred.platform_avatar_url || undefined,
    status: cred.status,
    scopes: (cred.scopes as string[]) || [],
    linkedAt: cred.linked_at || cred.created_at,
    lastUsedAt: cred.last_used_at || undefined,
    tokenExpired: cred.token_expires_at ? new Date(cred.token_expires_at) < new Date() : false,
    source: "platform_credentials",
  };
}

function getStoredConnectionRole(sourceContext: unknown): OAuthStandardConnectionRole {
  if (!sourceContext || typeof sourceContext !== "object") {
    return "OWNER";
  }
  const context = sourceContext as Record<string, unknown>;
  return normalizeOAuthConnectionRole(context.connectionRole ?? context.agentGoogleSide);
}

class OAuthService {
  /** List all available OAuth providers with configuration status */
  listProviders(): OAuthProviderInfo[] {
    return Object.values(OAUTH_PROVIDERS).map((provider) => ({
      id: provider.id,
      name: provider.name,
      description: provider.description,
      type: provider.type,
      configured: isProviderConfigured(provider),
      defaultScopes: provider.defaultScopes,
    }));
  }

  /** Initiate OAuth flow for a platform */
  async initiateAuth(params: InitiateAuthParams): Promise<InitiateAuthResult> {
    const { organizationId, userId, platform, redirectUrl, scopes, connectionRole } = params;
    const role = normalizeOAuthConnectionRole(connectionRole);

    const provider = getProvider(platform);
    if (!provider) throw Errors.platformNotSupported(platform);
    if (!isProviderConfigured(provider)) throw Errors.platformNotConfigured(platform);

    // API key providers return a form URL
    if (provider.type === "api_key") {
      return {
        authUrl: provider.routes?.initiate || "",
        requiresCredentials: true,
      };
    }

    // Use generic OAuth2 flow for providers that opt-in
    if (provider.useGenericRoutes && provider.type === "oauth2") {
      const result = await initiateOAuth2(provider, {
        organizationId,
        userId,
        redirectUrl,
        scopes,
        connectionRole: role,
      });
      return { authUrl: result.authUrl, state: result.state };
    }

    // Legacy provider-specific handlers (only Twitter remains - uses OAuth 1.0a)
    switch (platform) {
      case "twitter":
        return this.initiateTwitterAuth(organizationId, userId, redirectUrl, role);
      default:
        throw Errors.platformNotSupported(platform);
    }
  }

  private async initiateTwitterAuth(
    organizationId: string,
    userId: string,
    redirectUrl?: string,
    connectionRole?: OAuthConnectionRole,
  ): Promise<InitiateAuthResult> {
    const { twitterAutomationService } = await import("@/lib/services/twitter-automation");
    const role = normalizeOAuthConnectionRole(connectionRole);
    const twitterRole = role === "AGENT" ? "agent" : "owner";

    const baseUrl = getCloudAwareEnv().NEXT_PUBLIC_APP_URL || "https://www.elizacloud.ai";
    const result = await twitterAutomationService.generateAuthLink(
      `${baseUrl}/api/v1/twitter/callback`,
      twitterRole,
    );

    if (result.flow === "oauth1a") {
      await cache.set(
        `twitter_oauth:${result.oauthToken}`,
        {
          organizationId,
          userId,
          connectionRole: role,
          oauthTokenSecret: result.oauthTokenSecret,
          redirectUrl: redirectUrl || DEFAULT_REDIRECT,
        },
        STATE_TTL,
      );
      return { authUrl: result.url, state: result.oauthToken };
    }

    await cache.set(
      `twitter_oauth2:${result.state}`,
      {
        organizationId,
        userId,
        connectionRole: role,
        codeVerifier: result.codeVerifier,
        redirectUri: result.redirectUri,
        redirectUrl: redirectUrl || DEFAULT_REDIRECT,
      },
      STATE_TTL,
    );

    return { authUrl: result.url, state: result.state };
  }

  /** List all OAuth connections for an organization */
  async listConnections(params: ListConnectionsParams): Promise<OAuthConnection[]> {
    const { organizationId, platform, userId, connectionRole } = params;
    const connections: OAuthConnection[] = [];

    if (!platform) {
      try {
        const credentials = await dbRead
          .select()
          .from(platformCredentials)
          .where(eq(platformCredentials.organization_id, organizationId));
        connections.push(...credentials.map(connectionFromPlatformCredential));
      } catch (error) {
        logger.warn("[OAuthService] Platform credential query failed", {
          organizationId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const adapters = platform
      ? [getAdapter(platform)].filter(Boolean)
      : getAllAdapters().filter(
          (adapter) => getProvider(adapter.platform)?.storage !== "platform_credentials",
        );

    for (const adapter of adapters) {
      try {
        connections.push(...(await adapter!.listConnections(organizationId)));
      } catch (error) {
        logger.warn("[OAuthService] Adapter query failed", {
          platform: adapter?.platform,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return scopeConnectionsForUser(connections, userId, connectionRole);
  }

  /** Get a single connection by ID */
  async getConnection(params: GetTokenParams): Promise<OAuthConnection | null> {
    const adapter = await this.findAdapterForConnection(params.connectionId, params.organizationId);
    if (!adapter) return null;

    const connections = await adapter.listConnections(params.organizationId);
    return connections.find((c) => c.id === params.connectionId) || null;
  }

  /** Revoke/disconnect a connection */
  async revokeConnection(params: GetTokenParams): Promise<void> {
    const { organizationId, connectionId } = params;

    const adapter = await this.findAdapterForConnection(connectionId, organizationId);
    if (!adapter) throw Errors.connectionNotFound(connectionId);

    // Revoke FIRST, then bump version — prevents race where concurrent
    // getValidToken caches a still-active token under the new version key.
    await adapter.revoke(organizationId, connectionId);

    const version = await incrementOAuthVersion(organizationId, adapter.platform);
    await tokenCache.invalidate(organizationId, connectionId, version);

    logger.info("[OAuthService] Connection revoked", {
      organizationId,
      connectionId,
      platform: adapter.platform,
    });
  }

  /** Get a valid access token for a connection (uses cache with version counter) */
  async getValidToken(params: GetTokenParams & { platform?: string }): Promise<TokenResult> {
    const { organizationId, connectionId, platform } = params;

    // Look up adapter to determine platform if not provided
    const adapter = await this.findAdapterForConnection(connectionId, organizationId);
    if (!adapter) throw Errors.connectionNotFound(connectionId);

    const effectivePlatform = platform || adapter.platform;
    const version = await getOAuthVersion(organizationId, effectivePlatform);

    const cached = await tokenCache.get(organizationId, connectionId, version);
    if (cached) {
      logger.debug("[OAuthService] Token from cache", {
        connectionId,
        version,
      });
      return cached;
    }

    const token = await adapter.getToken(organizationId, connectionId);
    await tokenCache.set(organizationId, connectionId, version, token);

    return token;
  }

  /** Get valid token by platform (uses most recently used active connection) */
  async getValidTokenByPlatform(params: GetTokenByPlatformParams): Promise<TokenResult> {
    const { token } = await this.getValidTokenByPlatformWithConnectionId(params);
    return token;
  }

  /** Get valid token by platform with the connection ID that was used */
  async getValidTokenByPlatformWithConnectionId(
    params: GetTokenByPlatformParams,
  ): Promise<{ token: TokenResult; connectionId: string }> {
    const { organizationId, platform, userId, connectionRole } = params;

    const adapter = getAdapter(platform);
    if (!adapter) throw Errors.platformNotSupported(platform);

    const connections = await adapter.listConnections(organizationId);
    const activeConnection = getPreferredActiveConnection(connections, userId, connectionRole);
    if (!activeConnection) throw Errors.platformNotConnected(platform);

    const token = await this.getValidToken({
      organizationId,
      connectionId: activeConnection.id,
      platform,
    });
    return { token, connectionId: activeConnection.id };
  }

  /** Check if a platform has an active connection */
  async isPlatformConnected(
    organizationId: string,
    platform: string,
    userId?: string,
    connectionRole?: OAuthConnectionRole,
  ): Promise<boolean> {
    const adapter = getAdapter(platform);
    if (!adapter) return false;

    const connections = await adapter.listConnections(organizationId);
    return getPreferredActiveConnection(connections, userId, connectionRole) !== null;
  }

  /** Get all platforms with active connections */
  async getConnectedPlatforms(organizationId: string, userId?: string): Promise<string[]> {
    const connections = await this.listConnections({ organizationId, userId });
    return [...new Set(connections.filter((c) => c.status === "active").map((c) => c.platform))];
  }

  /** Invalidate all cached tokens for an organization */
  async invalidateAllTokens(organizationId: string): Promise<void> {
    await tokenCache.invalidateAll(organizationId);
    logger.info("[OAuthService] Invalidated all tokens", { organizationId });
  }

  // --- Private helpers ---

  private async findAdapterForConnection(connectionId: string, organizationId?: string) {
    if (organizationId && UUID_REGEX.test(connectionId)) {
      const [credential] = await dbRead
        .select({ platform: platformCredentials.platform })
        .from(platformCredentials)
        .where(
          and(
            eq(platformCredentials.id, connectionId),
            eq(platformCredentials.organization_id, organizationId),
          ),
        )
        .limit(1);
      if (!credential) return null;
      return getAdapter(credential.platform) ?? null;
    }

    for (const adapter of getAllAdapters()) {
      if (await adapter.ownsConnection(connectionId)) return adapter;
    }
    return null;
  }
  private sortConnectionsByRecency(connections: OAuthConnection[]): OAuthConnection[] {
    return sortConnectionsByRecency(connections);
  }
}

export const oauthService = new OAuthService();
