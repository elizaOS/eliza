/**
 * Plugin entry for the Instagram connector: assembles the `Plugin` object
 * (registering `InstagramService` and the workflow credential provider) and
 * re-exports the package's public surface. The `init()` hook registers the
 * connector-account provider with the runtime's `ConnectorAccountManager`,
 * warning rather than throwing when the manager is absent. DMs route through the
 * `MESSAGE` connector and comments through `POST`; no actions are registered.
 */
import { getConnectorAccountManager, logger, type Plugin } from "@elizaos/core";
import { createInstagramConnectorAccountProvider } from "./connector-account-provider";
import { INSTAGRAM_SERVICE_NAME } from "./constants";
import { InstagramService } from "./service";
import { InstagramWorkflowCredentialProvider } from "./workflow-credential-provider";

const instagramPlugin: Plugin = {
  name: INSTAGRAM_SERVICE_NAME,
  description: "Instagram client plugin for elizaOS",
  actions: [],
  providers: [],
  services: [InstagramService, InstagramWorkflowCredentialProvider],
  async init(_config, runtime) {
    try {
      const manager = getConnectorAccountManager(runtime);
      manager.registerProvider(createInstagramConnectorAccountProvider(runtime));
    } catch (err) {
      logger.warn(
        {
          src: "plugin:instagram",
          err: err instanceof Error ? err.message : String(err),
        },
        "Failed to register Instagram provider with ConnectorAccountManager"
      );
    }
  },
};

export {
  DEFAULT_INSTAGRAM_ACCOUNT_ID,
  listInstagramAccountIds,
  normalizeInstagramAccountId,
  readInstagramAccountId,
  resolveDefaultInstagramAccountId,
  resolveInstagramAccountConfig,
} from "./accounts";
export {
  createInstagramConnectorAccountProvider,
  INSTAGRAM_PROVIDER_ID,
} from "./connector-account-provider";
export * from "./constants";
export * from "./types";
export { InstagramService };
export default instagramPlugin;
