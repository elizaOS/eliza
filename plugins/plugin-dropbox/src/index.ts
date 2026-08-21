/**
 * Plugin entry for @elizaos/plugin-dropbox: re-exports every public symbol and
 * defines `dropboxPlugin`. The plugin registers `DropboxService` (folder
 * listing, search, and text reads by default; uploads as explicit writes) and
 * at init attaches the Dropbox connector-account provider to the runtime's
 * ConnectorAccountManager so the generic connector HTTP routes can manage
 * accounts and drive the PKCE offline OAuth flow. It registers no actions or
 * providers of its own; domain plugins invoke the service directly.
 */
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { getConnectorAccountManager, logger } from "@elizaos/core";
import { createDropboxConnectorAccountProvider } from "./connector-account-provider.js";
import { DropboxService } from "./service.js";
import { DROPBOX_SERVICE_NAME } from "./types.js";

export * from "./client.js";
export * from "./connector-account-provider.js";
export * from "./credential-resolver.js";
export * from "./types.js";
export { DropboxService };

export const dropboxPlugin: Plugin = {
  name: DROPBOX_SERVICE_NAME,
  description:
    "Dropbox integration for file listing, search, text reads, uploads, and deep links with PKCE offline OAuth",
  services: [DropboxService],
  actions: [],
  providers: [],
  tests: [],

  init: async (_config: Record<string, string>, runtime: IAgentRuntime): Promise<void> => {
    // error-policy:J4 a runtime without a ConnectorAccountManager (minimal
    // hosts, BYO-token local mode) still gets the service; only managed OAuth
    // account CRUD is unavailable and that absence is logged.
    try {
      const manager = getConnectorAccountManager(runtime);
      manager.registerProvider(createDropboxConnectorAccountProvider(runtime));
    } catch (err) {
      logger.warn(
        {
          src: "plugin:dropbox",
          err: err instanceof Error ? err.message : String(err),
        },
        "Failed to register Dropbox provider with ConnectorAccountManager"
      );
    }
  },
};

export default dropboxPlugin;
