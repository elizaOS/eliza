/**
 * @elizaos/plugin-github
 *
 * GitHub integration for elizaOS agents.
 *
 * Provides comprehensive GitHub API access including:
 * - Repository management
 * - Issue tracking
 * - Pull request workflows
 * - Code reviews
 * - Branch management
 * - File operations
 * - Commit creation
 */

import { type IAgentRuntime, logger, type Plugin } from "@elizaos/core";
import { allActions } from "./actions";
import { allProviders } from "./providers";
import { GitHubService, GITHUB_SERVICE_NAME } from "./service";

// Re-export all types
export * from "./types";

// Re-export errors
export * from "./error";

// Re-export config
export { GitHubPluginConfig, validateGitHubConfig } from "./config";

// Re-export service
export { GitHubService, GITHUB_SERVICE_NAME } from "./service";

// Re-export actions
export * from "./actions";

// Re-export providers
export * from "./providers";

/**
 * GitHub Plugin
 *
 * Integrates GitHub functionality into elizaOS agents, allowing them to:
 * - Create and manage issues
 * - Create and review pull requests
 * - Push code changes
 * - Manage branches
 * - Comment on issues and PRs
 */
const githubPlugin: Plugin = {
  name: "github",
  description:
    "GitHub integration for repository management, issues, pull requests, and code reviews",
  services: [GitHubService],
  actions: allActions,
  providers: allProviders,

  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    // Get settings for banner display
    const token = runtime.getSetting("GITHUB_API_TOKEN");
    const owner = runtime.getSetting("GITHUB_OWNER");
    const repo = runtime.getSetting("GITHUB_REPO");
    const branch = runtime.getSetting("GITHUB_BRANCH") ?? "main";

    // Log initialization status
    logger.info("╔══════════════════════════════════════════════════════════╗");
    logger.info("║                    GitHub Plugin                         ║");
    logger.info("╠══════════════════════════════════════════════════════════╣");
    logger.info(`║  Token:    ${token ? "✓ Configured" : "✗ Not configured"}                             ║`);
    logger.info(`║  Owner:    ${owner ?? "Not set"}`.padEnd(62) + "║");
    logger.info(`║  Repo:     ${repo ?? "Not set"}`.padEnd(62) + "║");
    logger.info(`║  Branch:   ${branch}`.padEnd(62) + "║");
    logger.info("╚══════════════════════════════════════════════════════════╝");

    if (!token) {
      logger.warn(
        "GitHub API Token not provided - GitHub plugin is loaded but will not be functional",
      );
      logger.warn(
        "To enable GitHub functionality, please provide GITHUB_API_TOKEN in your environment",
      );
    }
  },
};

export default githubPlugin;


