/**
 * Shared utilities for OAuth plugin actions.
 */

import type { Memory, State, ActionResult } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { usersRepository, type UserWithOrganization } from "@/db/repositories/users";
import { getConfiguredOAuthProviders } from "@/lib/services/oauth/provider-registry";

/** Configured OAuth platform IDs (platforms with valid credentials). */
export function getSupportedPlatforms(): string[] {
  return getConfiguredOAuthProviders().map(p => p.id);
}

/** Check if a platform is configured and available for OAuth. */
export function isSupportedPlatform(platform: string): boolean {
  return getSupportedPlatforms().includes(platform.toLowerCase());
}

export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function extractParams(message: Memory, state?: State): Record<string, unknown> {
  const content = message.content as Record<string, unknown>;
  return (content.actionParams || content.actionInput || state?.data?.actionParams || {}) as Record<string, unknown>;
}

export function extractPlatform(message: Memory, state?: State): string | undefined {
  const params = extractParams(message, state);
  return (params.platform as string)?.toLowerCase()?.trim();
}

export interface UserLookupResult {
  user: UserWithOrganization;
  organizationId: string;
}

export async function lookupUser(
  entityId: string,
  actionName: string
): Promise<UserLookupResult | ActionResult> {
  const user = await usersRepository.findWithOrganization(entityId);

  if (!user) {
    logger.error(`[${actionName}] User not found for entityId: ${entityId}`);
    return {
      text: "I couldn't find your account. Please try again or contact support.",
      success: false,
      error: "USER_NOT_FOUND",
      data: { actionName },
    };
  }

  if (!user.organization_id) {
    logger.error(`[${actionName}] User ${user.id} has no organization`);
    return {
      text: "Your account isn't set up correctly. Please contact support.",
      success: false,
      error: "NO_ORGANIZATION",
      data: { actionName },
    };
  }

  return { user, organizationId: user.organization_id };
}

export function isUserLookupError(result: UserLookupResult | ActionResult): result is ActionResult {
  return "success" in result && result.success === false;
}

export function formatConnectionIdentifier(connection: {
  email?: string;
  displayName?: string;
  username?: string;
}): string {
  return connection.email || connection.displayName || connection.username || "";
}
