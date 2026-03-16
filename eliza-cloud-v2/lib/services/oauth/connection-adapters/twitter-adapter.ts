/**
 * Twitter Connection Adapter
 *
 * OAuth 1.0a - tokens don't expire but can be revoked.
 * Connection ID format: twitter:{organizationId}
 */

import { logger } from "@/lib/utils/logger";
import type { ConnectionAdapter } from "./index";
import type { OAuthConnection, TokenResult } from "../types";
import { Errors } from "../errors";
import { OAUTH_PROVIDERS } from "../provider-registry";
import {
  generateConnectionId,
  ownsConnectionId,
  verifyConnectionId,
  fetchPlatformSecrets,
  getSecretValue,
  updateSecretAccessTime,
  deletePlatformSecrets,
  getEarliestSecretDate,
  createSecretsConnection,
} from "./secrets-adapter-utils";

const PLATFORM = "twitter";
const PREFIX = "TWITTER_";
const PATTERNS = OAUTH_PROVIDERS.twitter.secretPatterns!;

export const twitterAdapter: ConnectionAdapter = {
  platform: PLATFORM,

  async listConnections(organizationId: string): Promise<OAuthConnection[]> {
    const platformSecrets = await fetchPlatformSecrets(organizationId, PREFIX);
    const hasAccessToken = platformSecrets.some((s) => s.name === PATTERNS.accessToken);

    if (!hasAccessToken) return [];

    const [username, userId] = await Promise.all([
      getSecretValue(organizationId, PATTERNS.username!),
      getSecretValue(organizationId, PATTERNS.userId!),
    ]);

    return [
      createSecretsConnection(PLATFORM, organizationId, getEarliestSecretDate(platformSecrets), {
        platformUserId: userId || "unknown",
        username: username || undefined,
        displayName: username ? `@${username}` : undefined,
      }),
    ];
  },

  async getToken(organizationId: string, connectionId: string): Promise<TokenResult> {
    verifyConnectionId(PLATFORM, organizationId, connectionId);

    const accessToken = await getSecretValue(organizationId, PATTERNS.accessToken!);
    if (!accessToken) throw Errors.platformNotConnected(PLATFORM);

    const accessTokenSecret = await getSecretValue(organizationId, PATTERNS.accessTokenSecret!);
    await updateSecretAccessTime(organizationId, PATTERNS.accessToken!);

    return {
      accessToken,
      accessTokenSecret: accessTokenSecret || undefined,
      scopes: [],
      refreshed: false,
      fromCache: false,
    };
  },

  async revoke(organizationId: string, connectionId: string): Promise<void> {
    verifyConnectionId(PLATFORM, organizationId, connectionId);
    const count = await deletePlatformSecrets(organizationId, PREFIX, "oauth-service");
    logger.info("[TwitterAdapter] Connection revoked", { connectionId, organizationId, secretsDeleted: count });
  },

  async ownsConnection(connectionId: string): Promise<boolean> {
    return ownsConnectionId(PLATFORM, connectionId);
  },
};
