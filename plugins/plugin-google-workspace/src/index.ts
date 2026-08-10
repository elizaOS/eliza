/**
 * Plugin entry for @elizaos/plugin-google-workspace: the barrel that re-exports every
 * public symbol and defines `googlePlugin`. The plugin registers the personal
 * `GoogleWorkspaceService` (official Google Workspace MCP servers over one
 * account-scoped OAuth grant) plus the Google Chat connector services (`GoogleChatService`,
 * `GoogleChatWorkflowCredentialProvider` — service-account auth, MessageConnector
 * messaging). At init it attaches both connector-account providers to the
 * runtime's `ConnectorAccountManager` so the generic connector HTTP routes can
 * manage accounts and drive OAuth. Its static action array remains empty, while
 * the Workspace service materializes curated read and draft actions only for
 * connected accounts whose discovered MCP schemas match. Gmail delivery is
 * deliberately absent because the official Gmail MCP server creates drafts but
 * does not send them.
 * Chat messaging remains on the MessageConnector registered by
 * `GoogleChatService`.
 */
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { getConnectorAccountManager, logger } from "@elizaos/core";
import { createGoogleChatConnectorAccountProvider } from "./chat/connector-account-provider.js";
import { GoogleChatService } from "./chat/service.js";
import { GoogleChatWorkflowCredentialProvider } from "./chat/workflow-credential-provider.js";
import { createGoogleConnectorAccountProvider } from "./connector-account-provider.js";
import { GoogleWorkspaceService } from "./service.js";
import { GOOGLE_SERVICE_NAME } from "./types.js";

export * from "./auth.js";
export * from "./chat/accounts.js";
export type {
  GoogleChatAccountConfig,
  GoogleChatActionConfig,
  GoogleChatConfig,
  GoogleChatReactionNotificationMode,
  GoogleChatSpaceConfig,
} from "./chat/config.js";
export * from "./chat/connector-account-provider.js";
export * from "./chat/types.js";
export * from "./connector-account-provider.js";
export * from "./credential-resolver.js";
export * from "./mcp/access-token-provider.js";
export * from "./mcp/calendar-read-adapter.js";
export * from "./mcp/capability-host.js";
export * from "./scopes.js";
export * from "./types.js";
export { GoogleChatService, GoogleChatWorkflowCredentialProvider, GoogleWorkspaceService };

export const googlePlugin: Plugin = {
  name: GOOGLE_SERVICE_NAME,
  description:
    "Personal Google Workspace through official MCP servers and separate service-account Google Chat messaging",
  services: [GoogleWorkspaceService, GoogleChatService, GoogleChatWorkflowCredentialProvider],
  actions: [],
  providers: [],
  tests: [],

  // Self-declared auto-enable: activate when the "googlechat" connector is
  // configured under config.connectors. The Workspace (OAuth) side stays
  // opt-in — it is explicitly enabled or auto-registered by
  // plugin-personal-assistant.
  autoEnable: {
    connectorKeys: ["googlechat"],
  },

  async dispose(runtime: IAgentRuntime) {
    await runtime.getService<GoogleWorkspaceService>(GoogleWorkspaceService.serviceType)?.stop();
    await runtime.getService<GoogleChatService>(GoogleChatService.serviceType)?.stop();
    await runtime
      .getService<GoogleChatWorkflowCredentialProvider>(
        GoogleChatWorkflowCredentialProvider.serviceType
      )
      ?.stop();
  },

  init: async (config: Record<string, string>, runtime: IAgentRuntime): Promise<void> => {
    logger.info("Initializing Google Workspace plugin");
    logger.info("  - Personal Google execution: official product-specific MCP servers");
    logger.info(
      "  - Available capabilities: Gmail, Calendar, Drive, Docs, Sheets, Slides, Chat, People"
    );
    logger.info("  - Requested OAuth scopes are derived from selected capabilities");

    // Register with the ConnectorAccountManager so the generic HTTP CRUD/OAuth
    // surface can list, create, patch, delete, and start OAuth on Google
    // accounts using a single consolidated grant covering all capabilities.
    // The Chat provider is registered alongside: Chat accounts use
    // service-account credentials rather than the consolidated OAuth grant.
    try {
      const manager = getConnectorAccountManager(runtime);
      manager.registerProvider(createGoogleConnectorAccountProvider(runtime));
      manager.registerProvider(createGoogleChatConnectorAccountProvider(runtime));
    } catch (err) {
      logger.warn(
        {
          src: "plugin:google",
          err: err instanceof Error ? err.message : String(err),
        },
        "Failed to register Google providers with ConnectorAccountManager"
      );
    }

    const chatCredentials = Boolean(
      config.GOOGLE_CHAT_SERVICE_ACCOUNT ||
        process.env.GOOGLE_CHAT_SERVICE_ACCOUNT ||
        config.GOOGLE_CHAT_SERVICE_ACCOUNT_FILE ||
        process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_FILE ||
        process.env.GOOGLE_APPLICATION_CREDENTIALS
    );
    logger.info(
      `  - Chat service-account credentials configured: ${chatCredentials ? "Yes" : "No"}`
    );
  },
};

export default googlePlugin;
