import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { getConnectorAccountManager, logger } from "@elizaos/core";
import { createGoogleConnectorAccountProvider } from "./connector-account-provider.js";
import { GoogleWorkspaceService } from "./service.js";
import { GOOGLE_SERVICE_NAME } from "./types.js";

export * from "./auth.js";
export * from "./calendar.js";
export * from "./client-factory.js";
export * from "./connector-account-provider.js";
export * from "./credential-resolver.js";
export * from "./drive.js";
export * from "./gmail.js";
export * from "./meet.js";
export * from "./scopes.js";
export * from "./types.js";
export { GoogleWorkspaceService };

export const googlePlugin: Plugin = {
  name: GOOGLE_SERVICE_NAME,
  description:
    "Google Workspace integration for Gmail, Calendar, Drive, and Meet with account-scoped OAuth",
  services: [GoogleWorkspaceService],
  actions: [],
  providers: [],
  tests: [],
  init: async (config: Record<string, string>, runtime: IAgentRuntime): Promise<void> => {
    const hasClient = Boolean(config.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID);
    const hasSecret = Boolean(config.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET);

    logger.info("Initializing Google Workspace plugin");
    logger.info(`  - OAuth client configured: ${hasClient && hasSecret ? "Yes" : "No"}`);
    logger.info("  - Available capabilities: Gmail, Calendar, Drive, Meet");
    logger.info("  - Requested OAuth scopes are derived from selected capabilities");

    // Register with the ConnectorAccountManager so the generic HTTP CRUD/OAuth
    // surface can list, create, patch, delete, and start OAuth on Google
    // accounts using a single consolidated grant covering all capabilities.
    try {
      const manager = getConnectorAccountManager(runtime);
      manager.registerProvider(createGoogleConnectorAccountProvider(runtime));
    } catch (err) {
      logger.warn(
        {
          src: "plugin:google",
          err: err instanceof Error ? err.message : String(err),
        },
        "Failed to register Google provider with ConnectorAccountManager",
      );
    }
  },
};

export default googlePlugin;
