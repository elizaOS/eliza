/**
 * Unified OAuth Service
 *
 * Provides a consistent interface for OAuth credential management
 * across multiple platforms (Google, Twitter, Twilio, Blooio).
 */

import { cache } from "@/lib/cache/client";
import { logger } from "@/lib/utils/logger";
import { OAUTH_PROVIDERS, getProvider, isProviderConfigured } from "./provider-registry";
import { getAllAdapters, getAdapter } from "./connection-adapters";
import { tokenCache } from "./token-cache";
import { Errors } from "./errors";
import { initiateOAuth2 } from "./providers";
import type {
  OAuthProviderInfo,
  OAuthConnection,
  TokenResult,
  InitiateAuthParams,
  InitiateAuthResult,
  ListConnectionsParams,
  GetTokenParams,
  GetTokenByPlatformParams,
} from "./types";

const DEFAULT_REDIRECT = "/dashboard/settings?tab=connections";
const STATE_TTL = 600; // 10 minutes

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
    const { organizationId, userId, platform, redirectUrl, scopes } = params;

    const provider = getProvider(platform);
    if (!provider) throw Errors.platformNotSupported(platform);
    if (!isProviderConfigured(provider)) throw Errors.platformNotConfigured(platform);

    // API key providers return a form URL
    if (provider.type === "api_key") {
      return { authUrl: provider.routes?.initiate || "", requiresCredentials: true };
    }

    // Use generic OAuth2 flow for providers that opt-in
    if (provider.useGenericRoutes && provider.type === "oauth2") {
      const result = await initiateOAuth2(provider, {
        organizationId,
        userId,
        redirectUrl,
        scopes,
      });
      return { authUrl: result.authUrl, state: result.state };
    }

    // Legacy provider-specific handlers (only Twitter remains - uses OAuth 1.0a)
    switch (platform) {
      case "twitter":
        return this.initiateTwitterAuth(organizationId, userId, redirectUrl);
      default:
        throw Errors.platformNotSupported(platform);
    }
  }

  private async initiateTwitterAuth(organizationId: string, userId: string, redirectUrl?: string): Promise<InitiateAuthResult> {
    const { twitterAutomationService } = await import("@/lib/services/twitter-automation");

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://elizacloud.ai";
    const result = await twitterAutomationService.generateAuthLink(`${baseUrl}/api/v1/twitter/callback`);

    await cache.set(
      `twitter_oauth:${result.oauthToken}`,
      { organizationId, userId, oauthTokenSecret: result.oauthTokenSecret, redirectUrl: redirectUrl || DEFAULT_REDIRECT },
      STATE_TTL,
    );

    return { authUrl: result.url, state: result.oauthToken };
  }

  /** List all OAuth connections for an organization */
  async listConnections(params: ListConnectionsParams): Promise<OAuthConnection[]> {
    const { organizationId, platform } = params;
    const adapters = platform ? [getAdapter(platform)].filter(Boolean) : getAllAdapters();
    const results = await Promise.allSettled(adapters.map((a) => a!.listConnections(organizationId)));

    const connections = results.flatMap((r) => {
      if (r.status === "fulfilled") return r.value;
      logger.warn("[OAuthService] Adapter query failed", { error: r.reason?.message || String(r.reason) });
      return [];
    });

    return this.sortConnectionsByRecency(connections);
  }

  /** Get a single connection by ID */
  async getConnection(params: GetTokenParams): Promise<OAuthConnection | null> {
    const adapter = await this.findAdapterForConnection(params.connectionId);
    if (!adapter) return null;

    const connections = await adapter.listConnections(params.organizationId);
    return connections.find((c) => c.id === params.connectionId) || null;
  }

  /** Revoke/disconnect a connection */
  async revokeConnection(params: GetTokenParams): Promise<void> {
    const { organizationId, connectionId } = params;

    const adapter = await this.findAdapterForConnection(connectionId);
    if (!adapter) throw Errors.connectionNotFound(connectionId);

    await adapter.revoke(organizationId, connectionId);
    await tokenCache.invalidate(organizationId, connectionId);

    logger.info("[OAuthService] Connection revoked", { organizationId, connectionId, platform: adapter.platform });
  }

  /** Get a valid access token for a connection (uses cache) */
  async getValidToken(params: GetTokenParams): Promise<TokenResult> {
    const { organizationId, connectionId } = params;

    const cached = await tokenCache.get(organizationId, connectionId);
    if (cached) {
      logger.debug("[OAuthService] Token from cache", { connectionId });
      return cached;
    }

    const adapter = await this.findAdapterForConnection(connectionId);
    if (!adapter) throw Errors.connectionNotFound(connectionId);

    const token = await adapter.getToken(organizationId, connectionId);
    await tokenCache.set(organizationId, connectionId, token);

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
    const { organizationId, platform } = params;

    const adapter = getAdapter(platform);
    if (!adapter) throw Errors.platformNotSupported(platform);

    const connections = await adapter.listConnections(organizationId);
    const activeConnection = this.getMostRecentActive(connections);
    if (!activeConnection) throw Errors.platformNotConnected(platform);

    const token = await this.getValidToken({ organizationId, connectionId: activeConnection.id });
    return { token, connectionId: activeConnection.id };
  }

  /** Check if a platform has an active connection */
  async isPlatformConnected(organizationId: string, platform: string): Promise<boolean> {
    const adapter = getAdapter(platform);
    if (!adapter) return false;

    const connections = await adapter.listConnections(organizationId);
    return connections.some((c) => c.status === "active");
  }

  /** Get all platforms with active connections */
  async getConnectedPlatforms(organizationId: string): Promise<string[]> {
    const connections = await this.listConnections({ organizationId });
    return [...new Set(connections.filter((c) => c.status === "active").map((c) => c.platform))];
  }

  /** Invalidate all cached tokens for an organization */
  async invalidateAllTokens(organizationId: string): Promise<void> {
    await tokenCache.invalidateAll(organizationId);
    logger.info("[OAuthService] Invalidated all tokens", { organizationId });
  }

  // --- Private helpers ---

  private async findAdapterForConnection(connectionId: string) {
    for (const adapter of getAllAdapters()) {
      if (await adapter.ownsConnection(connectionId)) return adapter;
    }
    return null;
  }

  private getMostRecentActive(connections: OAuthConnection[]): OAuthConnection | null {
    const active = connections.filter((c) => c.status === "active");
    if (active.length === 0) return null;
    return active.reduce((most, conn) => {
      const mostTime = most.lastUsedAt?.getTime() || most.linkedAt.getTime();
      const connTime = conn.lastUsedAt?.getTime() || conn.linkedAt.getTime();
      return connTime > mostTime ? conn : most;
    });
  }

  private sortConnectionsByRecency(connections: OAuthConnection[]): OAuthConnection[] {
    return connections.sort((a, b) => {
      const aTime = a.lastUsedAt?.getTime() || a.linkedAt.getTime();
      const bTime = b.lastUsedAt?.getTime() || b.linkedAt.getTime();
      return bTime - aTime;
    });
  }
}

export const oauthService = new OAuthService();
