/**
 * Blooio Connection Adapter
 *
 * API key-based authentication for iMessage integration.
 * Connection ID format: blooio:{organizationId}
 */

import { blooioAutomationService } from "@/lib/services/blooio-automation";
import { logger } from "@/lib/utils/logger";
import { Errors } from "../errors";
import { OAUTH_PROVIDERS } from "../provider-registry";
import type { OAuthConnection, TokenResult } from "../types";
import {
  createSecretsConnection,
  deletePlatformSecrets,
  fetchPlatformSecrets,
  getEarliestSecretDate,
  getOptionalSecretValue,
  getSecretValue,
  ownsConnectionId,
  updateSecretAccessTime,
  verifyConnectionId,
} from "./secrets-adapter-utils";
import type { ConnectionAdapter } from "./types";

const PLATFORM = "blooio";
const PREFIX = "BLOOIO_";
const PATTERNS = OAUTH_PROVIDERS.blooio.secretPatterns!;

export const blooioAdapter: ConnectionAdapter = {
  platform: PLATFORM,

  async listConnections(organizationId: string): Promise<OAuthConnection[]> {
    const platformSecrets = await fetchPlatformSecrets(organizationId, PREFIX);
    const hasApiKey = platformSecrets.some((s) => s.name === PATTERNS.apiKey);

    if (!hasApiKey) return [];

    const fromNumber = await getOptionalSecretValue(
      organizationId,
      PATTERNS.fromNumber!,
      "blooio.fromNumber",
    );

    return [
      createSecretsConnection(PLATFORM, organizationId, getEarliestSecretDate(platformSecrets), {
        platformUserId: "blooio-user",
        displayName: fromNumber ? `Blooio (${fromNumber})` : "Blooio iMessage",
      }),
    ];
  },

  async getToken(organizationId: string, connectionId: string): Promise<TokenResult> {
    verifyConnectionId(PLATFORM, organizationId, connectionId);

    const apiKey = await getSecretValue(organizationId, PATTERNS.apiKey!);
    if (!apiKey) throw Errors.platformNotConnected(PLATFORM);

    await updateSecretAccessTime(organizationId, PATTERNS.apiKey!);

    return {
      accessToken: apiKey,
      scopes: [],
      refreshed: false,
      fromCache: false,
    };
  },

  async revoke(organizationId: string, connectionId: string): Promise<void> {
    verifyConnectionId(PLATFORM, organizationId, connectionId);
    const count = await deletePlatformSecrets(organizationId, PREFIX, "oauth-service");
    blooioAutomationService.invalidateStatusCache(organizationId);
    logger.info("[BlooioAdapter] Connection revoked", {
      connectionId,
      organizationId,
      secretsDeleted: count,
    });
  },

  async ownsConnection(connectionId: string): Promise<boolean> {
    return ownsConnectionId(PLATFORM, connectionId);
  },
};
