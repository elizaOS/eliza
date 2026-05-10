/**
 * Generic Connection Adapter
 *
 * Handles connections for any OAuth2 provider that uses platform_credentials table.
 * Supports token refresh via the generic OAuth2 flow.
 */

import { and, eq } from "drizzle-orm";
import { dbRead, dbWrite } from "@/db/client";
import { platformCredentials } from "@/db/schemas/platform-credentials";
import { secretsService } from "@/lib/services/secrets";
import { DecryptionError } from "@/lib/services/secrets/encryption";
import { logger } from "@/lib/utils/logger";
import { incrementOAuthVersion } from "../cache-version";
import { Errors } from "../errors";
import { getProvider } from "../provider-registry";
import { refreshOAuth2Token } from "../providers";
import type { OAuthConnection, TokenResult } from "../types";
import { formatOAuthConnectionRole } from "../types";
import type { ConnectionAdapter } from "./types";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Buffer before token expiry to trigger refresh (5 minutes)
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * Create a generic adapter for a specific platform.
 * This allows the adapter to be used for any platform that stores in platform_credentials.
 */
export function createGenericAdapter(platform: string): ConnectionAdapter {
  const platformEnum = platform as (typeof platformCredentials.platform.enumValues)[number];

  async function decryptTokenSecret(
    secretId: string,
    organizationId: string,
    connectionId: string,
    tokenType: "access_token" | "refresh_token",
  ): Promise<string> {
    if (!secretId || !organizationId || !connectionId) {
      throw new Error(
        `Missing required parameters for ${platform} ${tokenType} decryption: secretId=${!!secretId}, orgId=${!!organizationId}, connId=${!!connectionId}`,
      );
    }
    try {
      return await secretsService.getDecryptedValue(secretId, organizationId);
    } catch (error) {
      if (error instanceof DecryptionError) {
        logger.error(`[GenericAdapter] Token decryption failed for ${platform}`, {
          connectionId,
          organizationId,
          secretId,
          tokenType,
          phase: error.phase,
          error: error.message,
        });

        // Mark connection as needing re-authentication
        await dbWrite
          .update(platformCredentials)
          .set({ status: "expired", updated_at: new Date() })
          .where(eq(platformCredentials.id, connectionId));

        throw new Error(
          `${platform} ${tokenType} cannot be decrypted (${error.phase === "dek_decryption" ? "encryption key mismatch" : "data corruption"}). Please disconnect and reconnect ${platform} in Settings > Connections.`,
        );
      }
      throw error;
    }
  }

  async function findCredential(organizationId: string, connectionId: string) {
    try {
      const [cred] = await dbRead
        .select()
        .from(platformCredentials)
        .where(
          and(
            eq(platformCredentials.id, connectionId),
            eq(platformCredentials.organization_id, organizationId),
            eq(platformCredentials.platform, platformEnum),
          ),
        )
        .limit(1);
      return cred;
    } catch (error) {
      // Handle case where platform enum value doesn't exist in database
      logger.warn(`[GenericAdapter] Query failed for ${platform}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  return {
    platform,

    async listConnections(organizationId: string): Promise<OAuthConnection[]> {
      try {
        const credentials = await dbRead
          .select()
          .from(platformCredentials)
          .where(
            and(
              eq(platformCredentials.organization_id, organizationId),
              eq(platformCredentials.platform, platformEnum),
            ),
          );

        return credentials.map((cred) => ({
          id: cred.id,
          userId: cred.user_id || undefined,
          connectionRole:
            cred.source_context && typeof cred.source_context === "object"
              ? formatOAuthConnectionRole(
                  (cred.source_context as Record<string, unknown>).connectionRole ??
                    (cred.source_context as Record<string, unknown>).agentGoogleSide,
                )
              : "owner",
          platform,
          platformUserId: cred.platform_user_id,
          email: cred.platform_email || undefined,
          username: cred.platform_username || undefined,
          displayName: cred.platform_display_name || undefined,
          avatarUrl: cred.platform_avatar_url || undefined,
          status: cred.status,
          scopes: (cred.scopes as string[]) || [],
          linkedAt: cred.linked_at || cred.created_at,
          lastUsedAt: cred.last_used_at || undefined,
          tokenExpired: cred.token_expires_at
            ? new Date(cred.token_expires_at) < new Date()
            : false,
          source: "platform_credentials" as const,
        }));
      } catch (error) {
        // Handle case where platform enum value doesn't exist in database
        logger.warn(`[GenericAdapter] listConnections failed for ${platform}`, {
          organizationId,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    },

    async getToken(organizationId: string, connectionId: string): Promise<TokenResult> {
      const cred = await findCredential(organizationId, connectionId);
      if (!cred) throw Errors.connectionNotFound(connectionId);
      if (cred.status === "revoked") throw Errors.connectionRevoked(platform);
      if (cred.status !== "active") throw Errors.platformNotConnected(platform);

      if (!cred.access_token_secret_id) {
        throw Errors.tokenRefreshFailed(platform, "No access token stored");
      }

      // Check if token needs refresh
      const tokenExpired =
        cred.token_expires_at &&
        new Date(cred.token_expires_at).getTime() - TOKEN_EXPIRY_BUFFER_MS < Date.now();

      let accessToken: string;
      let expiresAt: Date | undefined = cred.token_expires_at || undefined;
      let wasRefreshed = false;

      if (tokenExpired && cred.refresh_token_secret_id) {
        // Attempt to refresh the token
        const provider = getProvider(platform);
        if (!provider) {
          throw Errors.platformNotSupported(platform);
        }

        try {
          // Get the refresh token
          const refreshToken = await decryptTokenSecret(
            cred.refresh_token_secret_id,
            organizationId,
            connectionId,
            "refresh_token",
          );

          // Refresh the token using the generic flow
          const refreshResult = await refreshOAuth2Token(provider, refreshToken);

          // Store the new access token
          const audit = {
            actorType: "system" as const,
            actorId: "oauth-token-refresh",
            source: "generic-adapter",
          };

          // Rotate the access token first so we never keep using a known-expired token.
          await secretsService.rotate(
            cred.access_token_secret_id,
            organizationId,
            refreshResult.accessToken,
            audit,
          );

          // Some providers invalidate the previous refresh token immediately.
          // If persisting the replacement fails, disable the connection and surface
          // the problem instead of silently continuing with a broken refresh chain.
          if (refreshResult.newRefreshToken && cred.refresh_token_secret_id) {
            try {
              await secretsService.rotate(
                cred.refresh_token_secret_id,
                organizationId,
                refreshResult.newRefreshToken,
                audit,
              );
            } catch (refreshTokenError) {
              logger.error(`[GenericAdapter] Failed to store new refresh token for ${platform}`, {
                connectionId,
                organizationId,
                error:
                  refreshTokenError instanceof Error
                    ? refreshTokenError.message
                    : String(refreshTokenError),
              });

              await dbWrite
                .update(platformCredentials)
                .set({
                  status: "error",
                  updated_at: new Date(),
                })
                .where(eq(platformCredentials.id, connectionId));
              await incrementOAuthVersion(organizationId, platform);
              throw new Error(
                `Failed to persist rotated ${platform} refresh token. Please reconnect ${platform}.`,
              );
            }
          }

          // Update credential record
          const newExpiresAt = refreshResult.expiresIn
            ? new Date(Date.now() + refreshResult.expiresIn * 1000)
            : undefined;
          await dbWrite
            .update(platformCredentials)
            .set({
              token_expires_at: newExpiresAt,
              last_refreshed_at: new Date(),
              last_used_at: new Date(),
              updated_at: new Date(),
            })
            .where(eq(platformCredentials.id, connectionId));

          accessToken = refreshResult.accessToken;
          expiresAt = newExpiresAt;
          wasRefreshed = true;

          // Increment version so all instances pick up the new token
          await incrementOAuthVersion(organizationId, platform);

          logger.info(`[GenericAdapter] Token refreshed for ${platform}`, {
            connectionId,
            organizationId,
          });
        } catch (error) {
          logger.error(`[GenericAdapter] Token refresh failed for ${platform}`, {
            connectionId,
            organizationId,
            error: error instanceof Error ? error.message : String(error),
          });
          throw Errors.tokenRefreshFailed(
            platform,
            error instanceof Error ? error.message : "Unknown error",
          );
        }
      } else {
        accessToken = await decryptTokenSecret(
          cred.access_token_secret_id,
          organizationId,
          connectionId,
          "access_token",
        );

        // Update last used timestamp
        await dbWrite
          .update(platformCredentials)
          .set({ last_used_at: new Date(), updated_at: new Date() })
          .where(eq(platformCredentials.id, connectionId));
      }

      return {
        accessToken,
        expiresAt,
        scopes: (cred.scopes as string[]) || [],
        refreshed: wasRefreshed,
        fromCache: false,
      };
    },

    async revoke(organizationId: string, connectionId: string): Promise<void> {
      const cred = await findCredential(organizationId, connectionId);
      if (!cred) throw Errors.connectionNotFound(connectionId);

      const audit = {
        actorType: "system" as const,
        actorId: "oauth-service",
        source: "revoke-connection",
      };

      // Delete token secrets - log failures but don't block revocation
      const deleteSecret = async (id: string | null, tokenType: string) => {
        if (!id) return;
        try {
          await secretsService.delete(id, organizationId, audit);
        } catch (error) {
          logger.warn(`[GenericAdapter] Failed to delete ${tokenType} secret during revoke`, {
            secretId: id,
            platform,
            organizationId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };

      await Promise.all([
        deleteSecret(cred.access_token_secret_id, "access_token"),
        deleteSecret(cred.refresh_token_secret_id, "refresh_token"),
      ]);

      await dbWrite
        .update(platformCredentials)
        .set({
          status: "revoked",
          revoked_at: new Date(),
          updated_at: new Date(),
        })
        .where(eq(platformCredentials.id, connectionId));

      logger.info(`[GenericAdapter] Connection revoked for ${platform}`, {
        connectionId,
        organizationId,
      });
    },

    async ownsConnection(connectionId: string): Promise<boolean> {
      if (!UUID_REGEX.test(connectionId)) return false;

      try {
        const [cred] = await dbRead
          .select({ id: platformCredentials.id })
          .from(platformCredentials)
          .where(
            and(
              eq(platformCredentials.id, connectionId),
              eq(platformCredentials.platform, platformEnum),
            ),
          )
          .limit(1);

        return !!cred;
      } catch {
        return false;
      }
    },
  };
}

// Pre-created adapters for known generic providers
export const linearAdapter = createGenericAdapter("linear");
export const notionAdapter = createGenericAdapter("notion");
export const githubAdapter = createGenericAdapter("github");
export const slackAdapter = createGenericAdapter("slack");
export const microsoftAdapter = createGenericAdapter("microsoft");
