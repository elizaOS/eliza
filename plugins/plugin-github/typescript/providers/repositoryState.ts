/**
 * Repository State Provider
 *
 * Provides context about the current GitHub repository state.
 */

import {
  type IAgentRuntime,
  type Memory,
  type Provider,
  type State,
} from "@elizaos/core";
import { GitHubService, GITHUB_SERVICE_NAME } from "../service";

/**
 * Repository state provider
 *
 * Provides information about the configured repository, including
 * recent issues, pull requests, and repository metadata.
 */
export const repositoryStateProvider: Provider = {
  name: "GITHUB_REPOSITORY_STATE",
  description:
    "Provides context about the current GitHub repository including recent activity",

  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<string | null> => {
    const service = runtime.getService<GitHubService>(GITHUB_SERVICE_NAME);

    if (!service) {
      return null;
    }

    try {
      const config = service.getConfig();

      if (!config.owner || !config.repo) {
        return "GitHub repository not configured. Please set GITHUB_OWNER and GITHUB_REPO.";
      }

      // Fetch repository info
      const repo = await service.getRepository({
        owner: config.owner,
        repo: config.repo,
      });

      // Fetch recent open issues (limit 5)
      const issues = await service.listIssues({
        owner: config.owner,
        repo: config.repo,
        state: "open",
        perPage: 5,
      });

      // Fetch recent open PRs (limit 5)
      const pullRequests = await service.listPullRequests({
        owner: config.owner,
        repo: config.repo,
        state: "open",
        perPage: 5,
      });

      // Build context string
      const parts: string[] = [
        `## GitHub Repository: ${repo.fullName}`,
        "",
        `**Description:** ${repo.description ?? "No description"}`,
        `**Default Branch:** ${repo.defaultBranch}`,
        `**Language:** ${repo.language ?? "Not specified"}`,
        `**Stars:** ${repo.stargazersCount} | **Forks:** ${repo.forksCount}`,
        `**Open Issues:** ${repo.openIssuesCount}`,
        "",
      ];

      if (issues.length > 0) {
        parts.push("### Recent Open Issues");
        for (const issue of issues) {
          const labels = issue.labels.map((l) => l.name).join(", ");
          parts.push(
            `- #${issue.number}: ${issue.title}${labels ? ` [${labels}]` : ""}`,
          );
        }
        parts.push("");
      }

      if (pullRequests.length > 0) {
        parts.push("### Recent Open Pull Requests");
        for (const pr of pullRequests) {
          const status = pr.draft ? "[DRAFT] " : "";
          parts.push(
            `- #${pr.number}: ${status}${pr.title} (${pr.head.ref} → ${pr.base.ref})`,
          );
        }
        parts.push("");
      }

      return parts.join("\n");
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      return `Unable to fetch GitHub repository state: ${errorMessage}`;
    }
  },
};

export default repositoryStateProvider;

