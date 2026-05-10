import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { getConnectorAccountManager, logger, promoteSubactionsToActions } from "@elizaos/core";
import { linearAction } from "./actions/linear";
import { createLinearConnectorAccountProvider } from "./connector-account-provider";
import { linearActivityProvider } from "./providers/activity";
import { linearIssuesProvider } from "./providers/issues";
import { linearProjectsProvider } from "./providers/projects";
import { linearTeamsProvider } from "./providers/teams";
import { registerLinearSearchCategory } from "./search-category";
import { LinearService } from "./services/linear";

export const linearPlugin: Plugin = {
  name: "@elizaos/plugin-linear-ts",
  description: "Plugin for integrating with Linear issue tracking system",
  services: [LinearService],
  actions: [...promoteSubactionsToActions(linearAction)],
  providers: [
    linearIssuesProvider,
    linearTeamsProvider,
    linearProjectsProvider,
    linearActivityProvider,
  ],
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    registerLinearSearchCategory(runtime);
    try {
      const manager = getConnectorAccountManager(runtime);
      manager.registerProvider(createLinearConnectorAccountProvider(runtime));
    } catch (err) {
      logger.warn(
        {
          src: "plugin:linear",
          err: err instanceof Error ? err.message : String(err),
        },
        "Failed to register Linear provider with ConnectorAccountManager"
      );
    }
  },
};

export * from "./accounts";
export { createLinearConnectorAccountProvider } from "./connector-account-provider";
export { LinearService } from "./services/linear";
