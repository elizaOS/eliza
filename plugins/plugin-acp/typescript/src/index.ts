/**
 * @elizaos/plugin-acp
 *
 * Agent Client Protocol (ACP) plugin for elizaOS
 * Enables IDE integration and gateway bridging via the ACP protocol
 *
 * Based on https://github.com/anthropics/agent-protocol
 */

import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";

// Service
import {
  ACP_SERVICE_TYPE,
  ACPService,
  serveAcpGateway,
  type ServeAcpGatewayOptions,
} from "./service.js";

// Client utilities
export { createAcpClient, runAcpClientInteractive } from "./client.js";
// Commands
export { getAvailableCommands } from "./commands.js";
// Event mapper utilities
export {
  extractAttachmentsFromPrompt,
  extractTextFromPrompt,
  formatToolTitle,
  inferToolKind,
} from "./event-mapper.js";
export type { GatewayClientOptions } from "./gateway-client.js";
// Gateway client
export { createGatewayClient, GatewayClient } from "./gateway-client.js";

// Meta utilities
export { readBool, readNumber, readString } from "./meta.js";
export type { AcpSessionStore, PersistentSessionStoreOptions } from "./session.js";
// Session management
export {
  createInMemorySessionStore,
  createPersistentSessionStore,
  defaultAcpSessionStore,
  // Re-exported from @elizaos/core for convenience
  type SessionEntry,
  upsertSessionEntry,
  getSessionEntry,
  loadSessionStore,
  listSessionKeys,
  resolveDefaultSessionStorePath,
  createSessionEntry,
} from "./session.js";
// Session mapper utilities
export {
  parseSessionMeta,
  resetSessionIfNeeded,
  resolveSessionKey,
} from "./session-mapper.js";

// Translator (AcpGatewayAgent)
export { AcpGatewayAgent } from "./translator.js";
// Types
export * from "./types.js";

// Service exports
export { ACPService, ACP_SERVICE_TYPE, serveAcpGateway };
export type { ServeAcpGatewayOptions };

// CLI self-registration - importing this module triggers CLI command registration
import "./cli/index.js";

/**
 * ACP Plugin for elizaOS
 *
 * Provides Agent Client Protocol (ACP) capabilities for IDE integration.
 *
 * Services:
 * - ACPService: Main service for ACP server and gateway bridging
 *
 * Configuration (environment variables):
 * - ACP_GATEWAY_URL: Gateway WebSocket URL
 * - ACP_GATEWAY_TOKEN: Gateway authentication token
 * - ACP_GATEWAY_PASSWORD: Gateway password
 * - ACP_DEFAULT_SESSION_KEY: Default session key
 * - ACP_DEFAULT_SESSION_LABEL: Default session label
 * - ACP_REQUIRE_EXISTING: Require existing sessions (true/false)
 * - ACP_RESET_SESSION: Reset sessions on first use (true/false)
 * - ACP_PREFIX_CWD: Prefix prompts with working directory (true/false)
 * - ACP_VERBOSE: Enable verbose logging (true/false)
 *
 * @example
 * ```typescript
 * import { acpPlugin, ACPService, ACP_SERVICE_TYPE } from '@elizaos/plugin-acp';
 *
 * // Register plugin
 * runtime.registerPlugin(acpPlugin);
 *
 * // Get service
 * const service = runtime.getService<ACPService>(ACP_SERVICE_TYPE);
 *
 * // Start ACP server
 * service?.startServer({ gatewayUrl: 'ws://localhost:18789' });
 * ```
 */
export const acpPlugin: Plugin = {
  name: "acp",
  description:
    "Agent Client Protocol (ACP) plugin - enables IDE integration and gateway bridging via the ACP protocol",

  providers: [],
  actions: [],
  services: [ACPService],
  routes: [],

  async init(
    _config: Record<string, string>,
    _runtime: IAgentRuntime,
  ): Promise<void> {
    try {
      const gatewayUrl = process.env.ACP_GATEWAY_URL;

      if (gatewayUrl) {
        logger.info("[ACPPlugin] Gateway URL configured:", gatewayUrl);
      } else {
        logger.debug(
          "[ACPPlugin] No gateway URL configured - service will use defaults when started",
        );
      }

      logger.info("[ACPPlugin] Plugin initialized");
    } catch (error) {
      logger.error(
        "[ACPPlugin] Error initializing:",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  },
};

export default acpPlugin;

/**
 * Helper function to get the ACPService from runtime
 */
export function getACPService(runtime: IAgentRuntime): ACPService | null {
  return runtime.getService<ACPService>(ACP_SERVICE_TYPE);
}

/**
 * Helper function to start the ACP server via the service
 */
export function startAcpServer(
  runtime: IAgentRuntime,
  opts: {
    gatewayUrl?: string;
    gatewayToken?: string;
    gatewayPassword?: string;
    defaultSessionKey?: string;
    defaultSessionLabel?: string;
    requireExistingSession?: boolean;
    resetSession?: boolean;
    prefixCwd?: boolean;
    verbose?: boolean;
  } = {},
): boolean {
  const service = getACPService(runtime);
  if (!service) {
    logger.error("[ACP] Service not available");
    return false;
  }

  service.startServer(opts);
  return true;
}
