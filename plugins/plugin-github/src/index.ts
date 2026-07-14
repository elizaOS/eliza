/**
 * GitHub plugin composition root for agent actions, account management,
 * encrypted guided authentication routes, REST clients, and search.
 * Role-tagged accounts remain available while the guided connection supplies
 * the agent's default identity without process-global credentials.
 */

import type { IAgentRuntime, Plugin } from "@elizaos/core";
import {
  getConnectorAccountManager,
  promoteSubactionsToActions,
} from "@elizaos/core";
import { githubAction } from "./actions/github.js";
import { createGitHubConnectorAccountProvider } from "./connector-account-provider.js";
import {
  createGitHubRoutes,
  hydrateRuntimeGitHubCredential,
} from "./github-route-adapter.js";
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
export { createGitHubConnectorAccountProvider } from "./connector-account-provider.js";
export { createGitHubRoutes } from "./github-route-adapter.js";
export { GitHubService } from "./services/github-service.js";
export * from "./types.js";

export const githubPlugin: Plugin = {
  name: "github",
  description:
    "GitHub integration for pull requests, issues, and notification triage",
  services: [GitHubService],
  actions: [...promoteSubactionsToActions(githubAction)],
  routes: createGitHubRoutes(),
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    await hydrateRuntimeGitHubCredential(runtime);
    registerGitHubSearchCategory(runtime);
    const manager = getConnectorAccountManager(runtime);
    manager.registerProvider(createGitHubConnectorAccountProvider(runtime));
  },
  async dispose(runtime: IAgentRuntime) {
    const service = runtime.getService<GitHubService>(
      GitHubService.serviceType,
    );
    await service?.stop();
  },
};

export default githubPlugin;
