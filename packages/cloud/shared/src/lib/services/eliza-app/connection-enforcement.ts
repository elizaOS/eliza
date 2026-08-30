/**
 * Connection enforcement for Eliza App messaging channels.
 *
 * WHY: Eliza needs at least one connected data source before agent workflows
 * are useful. Connection-status checks remain active, while nudge generation
 * fails closed until it is routed through the admitted generative boundary.
 */

import { ElizaError } from "@elizaos/core";
import { cache } from "../../cache/client";
import { logger } from "../../utils/logger";
import { oauthService } from "../oauth";

const REQUIRED_PLATFORMS = ["google", "microsoft", "twitter"] as const;
type RequiredPlatform = (typeof REQUIRED_PLATFORMS)[number];

type MessagingPlatform = "discord" | "telegram" | "imessage" | "web";

interface NudgeParams {
  userMessage: string;
  platform: MessagingPlatform;
  organizationId: string;
  userId: string;
}

const PROVIDER_ALIAS_ENTRIES = [
  ["google calendar", "google"],
  ["google", "google"],
  ["gmail", "google"],
  ["gcal", "google"],
  ["gdrive", "google"],
  ["microsoft", "microsoft"],
  ["outlook", "microsoft"],
  ["hotmail", "microsoft"],
  ["onedrive", "microsoft"],
  ["twitter", "twitter"],
  ["x", "twitter"],
] as Array<[string, RequiredPlatform]>;
PROVIDER_ALIAS_ENTRIES.sort((left, right) => right[0].length - left[0].length);

const NUDGE_INTERVAL = 3;
const CONNECTION_STATUS_TTL_SECONDS = 30;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileAliasRegex(alias: string): RegExp {
  return new RegExp(`(^|[^a-z0-9])${escapeRegex(alias)}(?=$|[^a-z0-9])`, "i");
}

function getConversationKey(organizationId: string, userId: string): string {
  return `connection-enforcement:conversation:${organizationId}:${userId}`;
}

function getConnectionStatusKey(organizationId: string, userId: string): string {
  return `connection-enforcement:required-connection:${organizationId}:${userId}`;
}

function detectProviderFromMessage(message: string): RequiredPlatform | null {
  const lower = message.toLowerCase();

  for (const [alias, platform] of PROVIDER_ALIAS_ENTRIES) {
    if (compileAliasRegex(alias).test(lower)) {
      return platform;
    }
  }

  return null;
}

class ConnectionEnforcementService {
  // Fail closed: a connection check that cannot complete throws. Substituting `true` on error
  // would treat every cache/oauth failure as "already connected" and silently disable the
  // enforcement gate, letting unconnected tenants through. A genuinely-negative result
  // (`hasRequired === false`) stays distinct from an internal failure (throws).
  async hasRequiredConnection(organizationId: string, userId: string): Promise<boolean> {
    const cacheKey = getConnectionStatusKey(organizationId, userId);
    const cached = await cache.get<boolean>(cacheKey);
    if (typeof cached === "boolean") {
      return cached;
    }

    const connectedPlatforms = await oauthService.getConnectedPlatforms(organizationId, userId);
    const hasRequired = connectedPlatforms.some((platform) =>
      (REQUIRED_PLATFORMS as readonly string[]).includes(platform),
    );

    await cache.set(cacheKey, hasRequired, CONNECTION_STATUS_TTL_SECONDS);
    return hasRequired;
  }

  async invalidateRequiredConnectionCache(organizationId: string, userId?: string): Promise<void> {
    try {
      if (userId) {
        await Promise.all([
          cache.del(getConnectionStatusKey(organizationId, userId)),
          cache.del(getConversationKey(organizationId, userId)),
        ]);
        return;
      }

      await Promise.all([
        cache.delPattern(`connection-enforcement:required-connection:${organizationId}:*`),
        cache.delPattern(`connection-enforcement:conversation:${organizationId}:*`),
      ]);
    } catch (error) {
      // error-policy:J6 best-effort cache invalidation — a failed del self-heals when the
      // 30s status TTL expires (worst case: a just-connected user is nudged once more). The
      // sole caller (oauth generic-callback) also wraps this in its own boundary handler.
      logger.warn("[ConnectionEnforcement] Failed to invalidate connection cache", {
        organizationId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async generateNudgeResponse(params: NudgeParams): Promise<string> {
    throw new ElizaError(
      "Connection-enforcement replies are disabled until they use the admitted generative-operation boundary",
      {
        code: "CONNECTION_ENFORCEMENT_LLM_DISABLED",
        context: {
          organizationId: params.organizationId,
          platform: params.platform,
          userId: params.userId,
        },
      },
    );
  }
}

const connectionEnforcementService = new ConnectionEnforcementService();

export {
  connectionEnforcementService,
  detectProviderFromMessage,
  type MessagingPlatform,
  NUDGE_INTERVAL,
  type NudgeParams,
  REQUIRED_PLATFORMS,
  type RequiredPlatform,
};
