import type { Plugin } from "@elizaos/core";
import { type IAgentRuntime, logger } from "@elizaos/core";
import { lobsterResumeAction } from "./actions/resume";
// Actions
import { lobsterRunAction } from "./actions/run";

// Providers
import { lobsterProvider } from "./providers/lobster";

/**
 * Lobster Plugin for elizaOS
 *
 * Provides integration with the Lobster workflow runtime for executing
 * deterministic multi-step pipelines with approval checkpoints.
 *
 * Use cases:
 * - Repeatable automations (email triage, monitoring, sync)
 * - Actions requiring human approval (send, post, delete)
 * - Deterministic multi-step operations
 *
 * Actions:
 * - LOBSTER_RUN: Execute a Lobster pipeline
 * - LOBSTER_RESUME: Continue a pipeline after approval
 *
 * Provider:
 * - lobster: Exposes Lobster availability and help info
 */
export const lobsterPlugin: Plugin = {
  name: "lobster",
  description:
    "Lobster workflow runtime integration for deterministic multi-step pipelines with approval checkpoints.",

  providers: [lobsterProvider],

  actions: [lobsterRunAction, lobsterResumeAction],

  async init(_config: Record<string, string>, runtime: IAgentRuntime): Promise<void> {
    try {
      logger.info("[LobsterPlugin] Initializing...");

      // Check if lobster is available
      const { createLobsterService } = await import("./services/lobsterService");
      const service = createLobsterService(runtime);
      const isAvailable = await service.isAvailable();

      if (isAvailable) {
        logger.info("[LobsterPlugin] Lobster runtime detected and available");
      } else {
        logger.warn(
          "[LobsterPlugin] Lobster runtime not found. Install Lobster to enable pipeline workflows."
        );
      }

      logger.info("[LobsterPlugin] Initialized successfully");
    } catch (error) {
      logger.error(
        "[LobsterPlugin] Error initializing:",
        error instanceof Error ? error.message : String(error)
      );
      // Don't throw - plugin can still load even if lobster isn't available
    }
  },
};

export default lobsterPlugin;

export { lobsterResumeAction } from "./actions/resume";
// Export actions
export { lobsterRunAction } from "./actions/run";
// Export provider
export { lobsterProvider } from "./providers/lobster";
// Export service
export { createLobsterService, LobsterService } from "./services/lobsterService";
// Export types
export type {
  LobsterApprovalRequest,
  LobsterConfig,
  LobsterEnvelope,
  LobsterErrorEnvelope,
  LobsterResumeParams,
  LobsterRunParams,
  LobsterSuccessEnvelope,
} from "./types";
