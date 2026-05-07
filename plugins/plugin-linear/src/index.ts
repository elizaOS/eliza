import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { linearAction } from "./actions/linear";
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
  actions: [linearAction],
  providers: [
    linearIssuesProvider,
    linearTeamsProvider,
    linearProjectsProvider,
    linearActivityProvider,
  ],
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    registerLinearSearchCategory(runtime);
  },
};

export { LinearService } from "./services/linear";
