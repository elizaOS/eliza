/**
 * User Context Service - Single source of truth for user-related data
 * Handles authentication context, API keys, and user preferences
 */

import type { AnonymousSession } from "@/db/schemas";
import type { ModelPreferences } from "@/lib/eliza/model-preferences";
import { apiKeysService } from "@/lib/services/api-keys";
import { oauthService } from "@/lib/services/oauth";
import { vertexModelRegistryService } from "@/lib/services/vertex-model-registry";
import type { ApiKey, UserWithOrganization } from "@/lib/types";
import { logger } from "@/lib/utils/logger";
import { isValidUUID } from "@/lib/utils/validation";
import type { AgentMode } from "./agent-mode-types";
import type { PromptConfig } from "./prompt-presets";

export interface OAuthConnection {
  platform: string;
}

export interface UserContext {
  // Core identity
  userId: string;
  entityId: string; // Always equals userId in your system
  organizationId: string;
  stewardUserId?: string;

  // Agent configuration
  agentMode: AgentMode;

  // Runtime configuration
  apiKey: string;
  modelPreferences?: ModelPreferences;

  // Character overrides
  characterId?: string;

  // Session metadata
  isAnonymous: boolean;
  sessionToken?: string;

  // User details
  name?: string;
  email?: string;

  // App monetization context (for app billing)
  appId?: string;

  // App-specific prompt configuration
  appPromptConfig?: PromptConfig;

  // Feature flags for this request
  webSearchEnabled?: boolean;

  // Image generation preferences
  imageModel?: string;

  // OAuth connections for MCP injection
  oauthConnections?: OAuthConnection[];
}

export class UserContextService {
  private static instance: UserContextService;

  static getInstance(): UserContextService {
    if (!UserContextService.instance) {
      UserContextService.instance = new UserContextService();
    }
    return UserContextService.instance;
  }

  /**
   * Build complete user context from authentication result
   * Single point for all user-related data retrieval
   */
  async buildContext(authResult: {
    user: UserWithOrganization;
    apiKey?: ApiKey;
    isAnonymous?: boolean;
    anonymousSession?: AnonymousSession;
    agentMode: AgentMode;
    appId?: string;
    appPromptConfig?: PromptConfig;
  }): Promise<UserContext> {
    if (authResult.isAnonymous && authResult.anonymousSession) {
      return this.buildAnonymousContext(
        authResult.user,
        authResult.anonymousSession,
        authResult.agentMode,
        authResult.appId,
        authResult.appPromptConfig,
      );
    }

    // For authenticated users, entityId === userId (clear mapping)
    const entityId = authResult.user.id;

    // Authenticated users must have an organization
    if (!authResult.user.organization_id) {
      throw new Error("User does not have an organization. Please contact support.");
    }

    // Fetch API key and OAuth connections in parallel for efficiency
    const [apiKey, oauthConnections, resolvedModels] = await Promise.all([
      this.getUserApiKey(authResult.user.id, authResult.user.organization_id),
      this.getOAuthConnections(authResult.user.organization_id, authResult.user.id),
      vertexModelRegistryService.resolveModelPreferences({
        organizationId: authResult.user.organization_id,
        userId: authResult.user.id,
      }),
    ]);

    if (!apiKey) {
      logger.error(`[UserContext] No API key found for user ${authResult.user.id}`);
      throw new Error(
        "No API key found for your account. Please contact support or try logging out and back in.",
      );
    }

    logger.info(
      `[UserContext] Built context for user ${authResult.user.id} (mode: ${authResult.agentMode}): ${apiKey.substring(0, 12)}...`,
    );

    return {
      userId: authResult.user.id,
      entityId: entityId,
      organizationId: authResult.user.organization_id,
      stewardUserId: authResult.user.steward_user_id ?? undefined,
      agentMode: authResult.agentMode,
      apiKey,
      modelPreferences: resolvedModels.modelPreferences,
      isAnonymous: false,
      name: authResult.user.name ?? undefined,
      email: authResult.user.email ?? undefined,
      appId: authResult.appId,
      appPromptConfig: authResult.appPromptConfig,
      oauthConnections,
    };
  }

  /**
   * Get user's elizaOS Cloud API key from database
   * Centralized API key retrieval - no more scattered getUserElizaCloudApiKey calls
   */
  private async getUserApiKey(userId: string, orgId: string): Promise<string | null> {
    // Validate inputs
    if (!userId || userId.trim() === "") {
      logger.error("[UserContext] Invalid userId provided");
      return null;
    }

    if (!orgId || orgId.trim() === "") {
      logger.error(`[UserContext] Invalid organizationId for user ${userId}`);
      return null;
    }

    const apiKeys = await apiKeysService.listByOrganization(orgId);

    // Find user's first active API key
    const userKey = apiKeys.find((key) => key.user_id === userId && key.is_active);

    if (!userKey) {
      logger.warn(`[UserContext] No API key found for user ${userId}`);
      return null;
    }

    // Return the full key from the database
    logger.info(`[UserContext] Retrieved key for user ${userId}: ${userKey.key_prefix}***`);
    return userKey.key;
  }

  private async getOAuthConnections(orgId: string, userId: string): Promise<OAuthConnection[]> {
    try {
      const connections = await oauthService.listConnections({
        organizationId: orgId,
        userId,
      });
      return connections
        .filter((c) => c.status === "active")
        .map((c) => ({ platform: c.platform }));
    } catch (error) {
      logger.warn(
        `[UserContext] OAuth fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  /**
   * Build context for anonymous users
   * Uses a shared runtime with limited capabilities
   */
  private async buildAnonymousContext(
    user: UserWithOrganization,
    session: AnonymousSession,
    agentMode: AgentMode,
    appId?: string,
    appPromptConfig?: PromptConfig,
  ): Promise<UserContext> {
    const entityId = session.id || user.id;
    const resolvedModels = await vertexModelRegistryService.resolveModelPreferences({
      organizationId:
        typeof user.organization_id === "string" && isValidUUID(user.organization_id)
          ? user.organization_id
          : undefined,
      userId: typeof user.id === "string" && isValidUUID(user.id) ? user.id : undefined,
    });

    logger.info(
      `[UserContext] Built anonymous context for session ${session.session_token} (mode: ${agentMode})`,
    );

    return {
      userId: user.id || "anonymous",
      entityId: entityId,
      organizationId: user.organization_id || "public",
      agentMode,
      apiKey: process.env.SHARED_ELIZAOS_API_KEY || "",
      modelPreferences: resolvedModels.modelPreferences,
      isAnonymous: true,
      sessionToken: session.session_token,
      name: user.name || "Anonymous",
      email: user.email ?? undefined,
      appId,
      appPromptConfig,
    };
  }

  /**
   * Create context for system/internal operations
   * Used when the system needs to perform operations without a user
   */
  createSystemContext(agentMode: AgentMode): UserContext {
    return {
      userId: "system",
      entityId: "system",
      organizationId: "system",
      agentMode,
      apiKey: process.env.SYSTEM_ELIZAOS_API_KEY || process.env.SHARED_ELIZAOS_API_KEY || "",
      isAnonymous: false,
      name: "System",
    };
  }
}

// Export singleton instance for convenience
export const userContextService = UserContextService.getInstance();
