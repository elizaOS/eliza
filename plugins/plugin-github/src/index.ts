/**
 * @module plugin-github
 * @description elizaOS plugin for GitHub integration.
 *
 * Actions:
 *   - GITHUB (PR, issue, and notification operations)
 *
 * Auth: role-tagged account records with legacy PAT fallback.
 *   - GITHUB_ACCOUNTS   — JSON account records ({accountId, role, token})
 *   - GITHUB_USER_PAT   — legacy user acting on their own behalf
 *   - GITHUB_AGENT_PAT  — legacy agent acting on its own behalf
 *   E2E fallbacks: ELIZA_E2E_GITHUB_USER_PAT / ELIZA_E2E_GITHUB_AGENT_PAT.
 *
 * Each action takes an `as: "user" | "agent"` option and may take accountId
 * to select a specific account. GITHUB_PR_OP review and
 * GITHUB_NOTIFICATION_TRIAGE default to `"user"`; the other ops default to
 * `"agent"`.
 */
import {
  getConnectorAccountManager,
  type IAgentRuntime,
  logger,
  promoteSubactionsToActions,
} from "@elizaos/core";
import type { HttpPlugin as Plugin } from "@elizaos/host/protocol";
import { githubAction } from "./actions/github.js";
import { createGitHubConnectorAccountProvider } from "./connector-account-provider.js";
import { githubRoutes } from "./routes.js";
import { registerGitHubSearchCategory } from "./search-category.js";
import { GitHubService } from "./services/github-service.js";

export * from "./accounts.js";
export { githubAction } from "./actions/github.js";
export { issueOpAction } from "./actions/issue-op.js";
export {
  notificationTriageAction,
  scoreNotification,
  type TriagedNotification,
} from "./actions/notification-triage.js";
export { prOpAction } from "./actions/pr-op.js";
export {
  createGitHubConnectorAccountProvider,
  createGitHubConnectorAccountProviderForTest,
  GitHubOAuthHttpError,
} from "./connector-account-provider.js";
export { GitHubService } from "./services/github-service.js";
export * from "./types.js";

export const githubPlugin: Plugin = {
  name: "github",
  description:
    "GitHub integration for pull requests, issues, and notification triage",
  services: [GitHubService],
  actions: [...promoteSubactionsToActions(githubAction)],
  routes: githubRoutes,
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    registerGitHubSearchCategory(runtime);
    try {
      const manager = getConnectorAccountManager(runtime);
      manager.registerProvider(createGitHubConnectorAccountProvider(runtime));
    } catch (err) {
      logger.warn(
        {
          src: "plugin:github",
          err: err instanceof Error ? err.message : String(err),
        },
        "Failed to register GitHub provider with ConnectorAccountManager",
      );
    }
  },
  async dispose(runtime: IAgentRuntime) {
    const svc = runtime.getService<GitHubService>(GitHubService.serviceType);
    await svc?.stop();
  },
};
export default githubPlugin;
