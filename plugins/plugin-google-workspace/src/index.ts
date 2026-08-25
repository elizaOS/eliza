/**
 * Plugin entry for @elizaos/plugin-google-workspace: the barrel that re-exports every
 * public symbol and defines `googlePlugin`. The plugin registers
 * `GoogleWorkspaceService` (Gmail/Calendar/Drive/Meet over one account-scoped
 * OAuth grant) plus the Google Chat connector service (`GoogleChatService` —
 * service-account auth, MessageConnector messaging). At init it attaches both
 * connector-account providers to the
 * runtime's `ConnectorAccountManager` so the generic connector HTTP routes can
 * manage accounts and drive OAuth; registering the Google provider also mounts
 * the Gmail send MessageConnector (`source: "gmail"`, aliases email/mail) so
 * MESSAGE op=send can compose and send email. It registers no actions or
 * providers of its own; callers invoke the services directly, and Chat
 * messaging routes through the MessageConnector that `GoogleChatService`
 * registers.
 */
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { getConnectorAccountManager, logger } from "@elizaos/core";
import { createGoogleChatConnectorAccountProvider } from "./chat/connector-account-provider.js";
import { GoogleChatService } from "./chat/service.js";
import { createGoogleConnectorAccountProvider } from "./connector-account-provider.js";
import { GoogleWorkspaceService } from "./service.js";
import { GOOGLE_SERVICE_NAME } from "./types.js";

export * from "./auth.js";
export * from "./calendar.js";
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
export * from "./client-factory.js";
export * from "./connector-account-provider.js";
export * from "./credential-resolver.js";
export * from "./drive.js";
export * from "./gmail.js";
export * from "./gmail-message-connector.js";
export * from "./google-oauth-callback.js";
export { GoogleGmailAdapter } from "./lifeops-message-adapter.js";
export * from "./meet.js";
export * from "./people.js";
export * from "./scopes.js";
export * from "./types.js";
export { GoogleChatService, GoogleWorkspaceService };

export const googlePlugin: Plugin = {
  name: GOOGLE_SERVICE_NAME,
  description:
    "Google Workspace integration for Gmail, Calendar, Drive, Meet, and Chat with account-scoped OAuth (Chat uses service-account auth)",
  services: [GoogleWorkspaceService, GoogleChatService],
  // Google Chat is passive human ingress: the connector-source registry entry
  // is the trust anchor that lets its inbound messages mint user notifications
  // (core's agent-event-bridge fails closed for unregistered sources).
  connectorSources: [
    {
      source: "google-chat",
      aliases: ["google-chat", "googlechat"],
      sourceKind: "passive",
      isPassive: true,
    },
  ],
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
    await runtime.getService<GoogleChatService>(GoogleChatService.serviceType)?.stop();
  },

  init: async (config: Record<string, string>, runtime: IAgentRuntime): Promise<void> => {
    const hasClient = Boolean(config.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID);
    const hasSecret = Boolean(config.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET);

    logger.info("Initializing Google Workspace plugin");
    logger.info(`  - OAuth client configured: ${hasClient && hasSecret ? "Yes" : "No"}`);
    logger.info("  - Available capabilities: Gmail, Calendar, Drive, Meet, Chat");
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
