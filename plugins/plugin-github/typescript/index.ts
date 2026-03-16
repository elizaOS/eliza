import { type IAgentRuntime, logger, type Plugin } from "@elizaos/core";
import { allActions } from "./actions";
import { allProviders } from "./providers";
import { GitHubService } from "./service";

const githubPlugin: Plugin = {
  name: "github",
  description:
    "GitHub integration for repository management, issues, pull requests, and code reviews",
  services: [GitHubService],
  actions: allActions,
  providers: allProviders,

  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    const token = runtime.getSetting("GITHUB_API_TOKEN");
    const owner = runtime.getSetting("GITHUB_OWNER");
    const repo = runtime.getSetting("GITHUB_REPO");
    const branch = runtime.getSetting("GITHUB_BRANCH") ?? "main";

    logger.info(
      `GitHub Plugin - Token: ${token ? "configured" : "not configured"}, Owner: ${owner ?? "not set"}, Repo: ${repo ?? "not set"}, Branch: ${branch}`
    );

    if (!token) {
      logger.warn("GitHub API Token not provided - plugin will not be functional");
    }
  },
};

export default githubPlugin;
