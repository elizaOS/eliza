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
