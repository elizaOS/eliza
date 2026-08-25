/**
 * Plugin entry for @elizaos/plugin-notion: re-exports every public symbol and
 * defines `notionPlugin`. The plugin registers `NotionService` (workspace
 * search/read by default, page creation and appends as explicit writes) and at
 * init attaches the Notion connector-account provider to the runtime's
 * ConnectorAccountManager so the generic connector HTTP routes can manage
 * accounts and drive the workspace-bound OAuth flow. It registers no actions
 * or providers of its own; domain plugins invoke the service directly.
 */
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { getConnectorAccountManager, logger } from "@elizaos/core";
import { createNotionConnectorAccountProvider } from "./connector-account-provider.js";
import { NotionService } from "./service.js";
import { NOTION_SERVICE_NAME } from "./types.js";

export * from "./client.js";
export * from "./connector-account-provider.js";
export * from "./credential-resolver.js";
export * from "./types.js";
export { NotionService };

export const notionPlugin: Plugin = {
  name: NOTION_SERVICE_NAME,
  description:
    "Notion integration for workspace search, page reads, page creation, and appends with workspace-bound OAuth",
  services: [NotionService],
  actions: [],
  providers: [],
  tests: [],

  init: async (_config: Record<string, string>, runtime: IAgentRuntime): Promise<void> => {
    // error-policy:J4 a runtime without a ConnectorAccountManager (minimal
    // hosts, BYO-token local mode) still gets the service; only managed OAuth
    // account CRUD is unavailable and that absence is logged.
    try {
      const manager = getConnectorAccountManager(runtime);
      manager.registerProvider(createNotionConnectorAccountProvider(runtime));
    } catch (err) {
      logger.warn(
        {
          src: "plugin:notion",
          err: err instanceof Error ? err.message : String(err),
        },
        "Failed to register Notion provider with ConnectorAccountManager"
      );
    }
  },
};

export default notionPlugin;
