/**
 * Twilio Connection Adapter
 *
 * API key-based authentication - credentials provided by user.
 * Connection ID format: twilio:{organizationId}
 */

import { twilioAutomationService } from "@/lib/services/twilio-automation";
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

const PLATFORM = "twilio";
const PREFIX = "TWILIO_";
const PATTERNS = OAUTH_PROVIDERS.twilio.secretPatterns!;

/** Mask account SID for display (show first 8 and last 4 chars) */
function maskAccountSid(sid: string): string {
  return sid.length > 12 ? `${sid.slice(0, 8)}...${sid.slice(-4)}` : sid;
}

export const twilioAdapter: ConnectionAdapter = {
  platform: PLATFORM,

  async listConnections(organizationId: string): Promise<OAuthConnection[]> {
    const platformSecrets = await fetchPlatformSecrets(organizationId, PREFIX);
    const hasAccountSid = platformSecrets.some((s) => s.name === PATTERNS.accountSid);
    const hasAuthToken = platformSecrets.some((s) => s.name === PATTERNS.authToken);

    if (!hasAccountSid || !hasAuthToken) return [];

    const phoneNumber = await getOptionalSecretValue(
      organizationId,
      PATTERNS.phoneNumber!,
      "twilio.phoneNumber",
    );
    const fullSid = await getOptionalSecretValue(
      organizationId,
      PATTERNS.accountSid!,
      "twilio.accountSid",
    );

    return [
      createSecretsConnection(PLATFORM, organizationId, getEarliestSecretDate(platformSecrets), {
        platformUserId: fullSid ? maskAccountSid(fullSid) : "unknown",
        displayName: phoneNumber ? `Twilio (${phoneNumber})` : "Twilio Account",
      }),
    ];
  },

  async getToken(organizationId: string, connectionId: string): Promise<TokenResult> {
    verifyConnectionId(PLATFORM, organizationId, connectionId);

    const [accountSid, authToken] = await Promise.all([
      getSecretValue(organizationId, PATTERNS.accountSid!),
      getSecretValue(organizationId, PATTERNS.authToken!),
    ]);

    if (!accountSid || !authToken) throw Errors.platformNotConnected(PLATFORM);

    await updateSecretAccessTime(organizationId, PATTERNS.accountSid!);

    return {
      accessToken: accountSid,
      accessTokenSecret: authToken,
      scopes: [],
      refreshed: false,
      fromCache: false,
    };
  },

  async revoke(organizationId: string, connectionId: string): Promise<void> {
    verifyConnectionId(PLATFORM, organizationId, connectionId);
    const count = await deletePlatformSecrets(organizationId, PREFIX, "oauth-service");
    twilioAutomationService.invalidateStatusCache(organizationId);
    logger.info("[TwilioAdapter] Connection revoked", {
      connectionId,
      organizationId,
      secretsDeleted: count,
    });
  },

  async ownsConnection(connectionId: string): Promise<boolean> {
    return ownsConnectionId(PLATFORM, connectionId);
  },
};
