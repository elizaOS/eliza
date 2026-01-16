import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import { requireProviderSpec } from "../generated/specs/spec-helpers";
import { GITHUB_SERVICE_NAME, type GitHubService } from "../service";

const spec = requireProviderSpec("repositoryState");

export const repositoryStateProvider: Provider = {
  name: spec.name,
  description: "Provides context about the current GitHub repository including recent activity",

  get: async (runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> => {
    const service = runtime.getService<GitHubService>(GITHUB_SERVICE_NAME);

    if (!service) {
      return { text: null };
    }

    try {
      const config = service.getConfig();

      if (!config.owner || !config.repo) {
        return {
          text: "GitHub repository not configured. Please set GITHUB_OWNER and GITHUB_REPO.",
        };
      }

      const repo = await service.getRepository({
        owner: config.owner,
        repo: config.repo,
      });

      const issues = await service.listIssues({
        owner: config.owner,
        repo: config.repo,
        state: "open",
        perPage: 5,
      });

      const pullRequests = await service.listPullRequests({
        owner: config.owner,
        repo: config.repo,
        state: "open",
        perPage: 5,
      });

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
          parts.push(`- #${issue.number}: ${issue.title}${labels ? ` [${labels}]` : ""}`);
        }
        parts.push("");
      }

      if (pullRequests.length > 0) {
        parts.push("### Recent Open Pull Requests");
        for (const pr of pullRequests) {
          const status = pr.draft ? "[DRAFT] " : "";
          parts.push(`- #${pr.number}: ${status}${pr.title} (${pr.head.ref} → ${pr.base.ref})`);
        }
        parts.push("");
      }

      return { text: parts.join("\n") };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return {
        text: `Unable to fetch GitHub repository state: ${errorMessage}`,
      };
    }
  },
};

export default repositoryStateProvider;
