/**
 * User Context Service - system context for internal agent/runtime operations.
 */

import type { ModelPreferences } from "@/lib/eliza/model-preferences";
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
