/**
 * Twitter Connection Adapter
 *
 * OAuth 1.0a - tokens don't expire but can be revoked.
 * Connection ID format: twitter:{organizationId}:{owner|agent|team}
 */

import { secretsService } from "@/lib/services/secrets";
import { logger } from "@/lib/utils/logger";
import { Errors } from "../errors";
import { OAUTH_PROVIDERS } from "../provider-registry";
import type { OAuthConnection, OAuthStandardConnectionRole, TokenResult } from "../types";
import { formatOAuthConnectionRole } from "../types";
import {
  deletePlatformSecrets,
  fetchPlatformSecrets,
  getEarliestSecretDate,
  getOptionalSecretValue,
  getSecretValue,
  updateSecretAccessTime,
} from "./secrets-adapter-utils";
import type { ConnectionAdapter } from "./types";

const PLATFORM = "twitter";
const PREFIX = "TWITTER_";
const PATTERNS = OAUTH_PROVIDERS.twitter.secretPatterns!;
const ROLES: OAuthStandardConnectionRole[] = ["OWNER", "AGENT", "TEAM"];
type TwitterConnectionRole = OAuthStandardConnectionRole;

const LEGACY_SECRET_NAMES = {
  accessToken: PATTERNS.accessToken!,
  accessTokenSecret: PATTERNS.accessTokenSecret!,
  oauth2AccessToken: "TWITTER_OAUTH_ACCESS_TOKEN",
  oauth2RefreshToken: "TWITTER_OAUTH_REFRESH_TOKEN",
  oauth2RefreshTokenTypo: "TWITTER_OAUTH_RERESH_TOKEN",
  oauth2Scope: "TWITTER_OAUTH_SCOPE",
  authMode: "TWITTER_AUTH_MODE",
  username: PATTERNS.username!,
  userId: PATTERNS.userId!,
} as const;

function roleSecretName(role: TwitterConnectionRole, suffix: string): string {
  return `TWITTER_${role.toUpperCase()}_${suffix.replace(/^TWITTER_/, "")}`;
}

function roleSecretNames(role: TwitterConnectionRole) {
  return {
    accessToken: roleSecretName(role, LEGACY_SECRET_NAMES.accessToken),
    accessTokenSecret: roleSecretName(role, LEGACY_SECRET_NAMES.accessTokenSecret),
    oauth2AccessToken: roleSecretName(role, "TWITTER_OAUTH2_ACCESS_TOKEN"),
    oauth2RefreshToken: roleSecretName(role, "TWITTER_OAUTH2_REFRESH_TOKEN"),
    oauth2Scope: roleSecretName(role, "TWITTER_OAUTH2_SCOPE"),
    authMode: roleSecretName(role, "TWITTER_AUTH_MODE"),
    username: roleSecretName(role, LEGACY_SECRET_NAMES.username),
    userId: roleSecretName(role, LEGACY_SECRET_NAMES.userId),
  } as const;
}

function connectionId(organizationId: string, role: TwitterConnectionRole): string {
  return `${PLATFORM}:${organizationId}:${role.toLowerCase()}`;
}

function parseConnectionId(organizationId: string, rawConnectionId: string): TwitterConnectionRole {
  for (const role of ROLES) {
    if (rawConnectionId === connectionId(organizationId, role)) {
      return role;
    }
  }
  throw Errors.connectionNotFound(rawConnectionId);
}

function ownsTwitterConnectionId(rawConnectionId: string): boolean {
  return rawConnectionId.startsWith(`${PLATFORM}:`);
}

function hasSecret(platformSecrets: { name: string }[], secretName: string): boolean {
  return platformSecrets.some((secret) => secret.name === secretName);
}

export const twitterAdapter: ConnectionAdapter = {
  platform: PLATFORM,

  async listConnections(organizationId: string): Promise<OAuthConnection[]> {
    const platformSecrets = await fetchPlatformSecrets(organizationId, PREFIX);
    const connections: OAuthConnection[] = [];

    for (const role of ROLES) {
      const names = roleSecretNames(role);
      const hasOAuth1Token = hasSecret(platformSecrets, names.accessToken);
      const hasOAuth2Token = hasSecret(platformSecrets, names.oauth2AccessToken);
      if (!hasOAuth1Token && !hasOAuth2Token) {
        continue;
      }
      const username = await getOptionalSecretValue(
        organizationId,
        names.username,
        "twitter.role.username",
      );
      const userId = await getOptionalSecretValue(
        organizationId,
        names.userId,
        "twitter.role.userId",
      );
      const oauth2Scope = await getOptionalSecretValue(
        organizationId,
        names.oauth2Scope,
        "twitter.role.oauth2Scope",
      );
      const roleSecrets = platformSecrets.filter((secret) =>
        Object.values(names).includes(secret.name as (typeof names)[keyof typeof names]),
      );
      connections.push({
        id: connectionId(organizationId, role),
        connectionRole: formatOAuthConnectionRole(role),
        platform: PLATFORM,
        platformUserId: userId || "unknown",
        username: username || undefined,
        displayName: username ? `@${username}` : undefined,
        status: "active",
        scopes: oauth2Scope ? oauth2Scope.split(/\s+/).filter(Boolean) : [],
        linkedAt: getEarliestSecretDate(roleSecrets.length > 0 ? roleSecrets : platformSecrets),
        tokenExpired: false,
        source: "secrets",
      });
    }

    if (
      connections.length === 0 &&
      (hasSecret(platformSecrets, LEGACY_SECRET_NAMES.accessToken) ||
        hasSecret(platformSecrets, LEGACY_SECRET_NAMES.oauth2AccessToken))
    ) {
      const username = await getOptionalSecretValue(
        organizationId,
        LEGACY_SECRET_NAMES.username,
        "twitter.legacy.username",
      );
      const userId = await getOptionalSecretValue(
        organizationId,
        LEGACY_SECRET_NAMES.userId,
        "twitter.legacy.userId",
      );
      const oauth2Scope = await getOptionalSecretValue(
        organizationId,
        LEGACY_SECRET_NAMES.oauth2Scope,
        "twitter.legacy.oauth2Scope",
      );
      connections.push({
        id: connectionId(organizationId, "OWNER"),
        connectionRole: "owner",
        platform: PLATFORM,
        platformUserId: userId || "unknown",
        username: username || undefined,
        displayName: username ? `@${username}` : undefined,
        status: "active",
        scopes: oauth2Scope ? oauth2Scope.split(/\s+/).filter(Boolean) : [],
        linkedAt: getEarliestSecretDate(platformSecrets),
        tokenExpired: false,
        source: "secrets",
      });
    }

    return connections;
  },

  async getToken(organizationId: string, connectionId: string): Promise<TokenResult> {
    const role = parseConnectionId(organizationId, connectionId);
    const names = roleSecretNames(role);

    const oauth1AccessToken =
      (await getSecretValue(organizationId, names.accessToken)) ??
      (role === "OWNER"
        ? await getSecretValue(organizationId, LEGACY_SECRET_NAMES.accessToken)
        : null);
    if (oauth1AccessToken) {
      const accessTokenSecret =
        (await getSecretValue(organizationId, names.accessTokenSecret)) ??
        (role === "OWNER"
          ? await getSecretValue(organizationId, LEGACY_SECRET_NAMES.accessTokenSecret)
          : null);
      await updateSecretAccessTime(organizationId, names.accessToken);

      return {
        accessToken: oauth1AccessToken,
        accessTokenSecret: accessTokenSecret || undefined,
        scopes: [],
        refreshed: false,
        fromCache: false,
      };
    }

    const oauth2AccessToken =
      (await getSecretValue(organizationId, names.oauth2AccessToken)) ??
      (role === "OWNER"
        ? await getSecretValue(organizationId, LEGACY_SECRET_NAMES.oauth2AccessToken)
        : null);
    if (!oauth2AccessToken) throw Errors.platformNotConnected(PLATFORM);
    const oauth2Scope =
      (await getSecretValue(organizationId, names.oauth2Scope)) ??
      (role === "OWNER"
        ? await getSecretValue(organizationId, LEGACY_SECRET_NAMES.oauth2Scope)
        : null);
    await updateSecretAccessTime(organizationId, names.oauth2AccessToken);

    return {
      accessToken: oauth2AccessToken,
      scopes: oauth2Scope ? oauth2Scope.split(/\s+/).filter(Boolean) : [],
      refreshed: false,
      fromCache: false,
    };
  },

  async revoke(organizationId: string, connectionId: string): Promise<void> {
    const role = parseConnectionId(organizationId, connectionId);
    const roleScopedCount = await deletePlatformSecrets(
      organizationId,
      `TWITTER_${role.toUpperCase()}_`,
      "oauth-service",
    );
    let legacyCount = 0;
    if (role === "OWNER") {
      const audit = {
        actorType: "system" as const,
        actorId: "oauth-service",
        source: "revoke-connection",
      };
      const legacyNames = new Set(Object.values(LEGACY_SECRET_NAMES));
      const legacySecrets = (await fetchPlatformSecrets(organizationId, PREFIX)).filter((secret) =>
        legacyNames.has(secret.name),
      );
      for (const secret of legacySecrets) {
        await secretsService.delete(secret.id, organizationId, audit);
        legacyCount += 1;
      }
    }
    logger.info("[TwitterAdapter] Connection revoked", {
      connectionId,
      organizationId,
      connectionRole: role,
      secretsDeleted: roleScopedCount + legacyCount,
    });
  },

  async ownsConnection(connectionId: string): Promise<boolean> {
    return ownsTwitterConnectionId(connectionId);
  },
};
