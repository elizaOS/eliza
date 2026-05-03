/**
 * Shared utilities for secrets-based connection adapters.
 */

import { and, eq, like } from "drizzle-orm";
import { dbRead, dbWrite } from "@/db/client";
import { secrets } from "@/db/schemas/secrets";
import { secretsService } from "@/lib/services/secrets";
import { logger } from "@/lib/utils/logger";
import { Errors } from "../errors";
import type { OAuthConnection, OAuthConnectionSource } from "../types";

/** Generate a stable connection ID for secrets-based adapters */
export function generateConnectionId(platform: string, organizationId: string): string {
  return `${platform}:${organizationId}`;
}

/** Check if a connection ID belongs to a platform */
export function ownsConnectionId(platform: string, connectionId: string): boolean {
  return connectionId.startsWith(`${platform}:`);
}

/** Verify connection ID matches expected organization */
export function verifyConnectionId(
  platform: string,
  organizationId: string,
  connectionId: string,
): void {
  const expected = generateConnectionId(platform, organizationId);
  if (connectionId !== expected) {
    throw Errors.connectionNotFound(connectionId);
  }
}

/** Fetch all secrets matching a prefix for an organization */
export async function fetchPlatformSecrets(organizationId: string, prefix: string) {
  return dbRead
    .select()
    .from(secrets)
    .where(and(eq(secrets.organization_id, organizationId), like(secrets.name, `${prefix}%`)));
}

/** Get decrypted secret value */
export async function getSecretValue(
  organizationId: string,
  secretName: string,
): Promise<string | null> {
  return secretsService.get(organizationId, secretName);
}

/** Get optional display metadata without failing connection discovery */
export async function getOptionalSecretValue(
  organizationId: string,
  secretName: string,
  context: string,
): Promise<string | null> {
  try {
    return await getSecretValue(organizationId, secretName);
  } catch (error) {
    logger.warn("[SecretsAdapter] Optional secret read failed", {
      organizationId,
      secretName,
      context,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Update last_accessed_at on a secret */
export async function updateSecretAccessTime(
  organizationId: string,
  secretName: string,
): Promise<void> {
  const [record] = await dbRead
    .select()
    .from(secrets)
    .where(and(eq(secrets.organization_id, organizationId), eq(secrets.name, secretName)))
    .limit(1);

  if (record) {
    await dbWrite
      .update(secrets)
      .set({ last_accessed_at: new Date() })
      .where(eq(secrets.id, record.id));
  }
}

/** Delete all secrets with a prefix for an organization */
export async function deletePlatformSecrets(
  organizationId: string,
  prefix: string,
  actorId: string,
): Promise<number> {
  const platformSecrets = await fetchPlatformSecrets(organizationId, prefix);
  const audit = {
    actorType: "system" as const,
    actorId,
    source: "revoke-connection",
  };

  for (const secret of platformSecrets) {
    await secretsService.delete(secret.id, organizationId, audit).catch((e) => {
      logger.warn(`[SecretsAdapter] Failed to delete secret`, {
        secretId: secret.id,
        secretName: secret.name,
        error: e instanceof Error ? e.message : String(e),
      });
    });
  }

  return platformSecrets.length;
}

/** Get earliest creation date from a list of secrets */
export function getEarliestSecretDate(secretRecords: { created_at: Date }[]): Date {
  if (secretRecords.length === 0) return new Date();
  return secretRecords.reduce((earliest, secret) => {
    const secretDate = new Date(secret.created_at);
    return secretDate < earliest ? secretDate : earliest;
  }, new Date());
}

/** Create a base connection object for secrets-based adapters */
export function createSecretsConnection(
  platform: string,
  organizationId: string,
  linkedAt: Date,
  overrides: Omit<Partial<OAuthConnection>, "id" | "platform" | "source"> = {},
): OAuthConnection {
  // Apply overrides first, then enforce immutable fields
  // This prevents callers from overriding id, platform, or source
  return {
    platformUserId: "unknown",
    status: "active",
    scopes: [],
    linkedAt,
    tokenExpired: false,
    ...overrides,
    // Immutable fields - always generated, never from overrides
    id: generateConnectionId(platform, organizationId),
    platform,
    source: "secrets" as OAuthConnectionSource,
  };
}
