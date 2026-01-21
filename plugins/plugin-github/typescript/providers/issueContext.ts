import type {
  Content,
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { requireProviderSpec } from "../generated/specs/spec-helpers";
import { GITHUB_SERVICE_NAME, type GitHubService } from "../service";

function extractIssueNumber(text: string): number | null {
  const patterns = [/#(\d+)/, /issue\s*#?(\d+)/i, /pr\s*#?(\d+)/i, /pull\s*request\s*#?(\d+)/i];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return Number.parseInt(match[1], 10);
    }
  }

  return null;
}

const spec = requireProviderSpec("issueContext");

export const issueContextProvider: Provider = {
  name: spec.name,
  description:
    "Provides detailed context about a specific GitHub issue or pull request when referenced",

  get: async (runtime: IAgentRuntime, message: Memory, _state: State): Promise<ProviderResult> => {
    const service = runtime.getService<GitHubService>(GITHUB_SERVICE_NAME);

    if (!service) {
      return { text: null };
    }

    const text = (message.content as Content).text ?? "";
    const issueNumber = extractIssueNumber(text);

    if (!issueNumber) {
      return { text: null };
    }

    try {
      const config = service.getConfig();

      if (!config.owner || !config.repo) {
        return { text: null };
      }

      try {
        const issue = await service.getIssue({
          owner: config.owner,
          repo: config.repo,
          issueNumber,
        });

        if (issue.isPullRequest) {
          const pr = await service.getPullRequest({
            owner: config.owner,
            repo: config.repo,
            pullNumber: issueNumber,
          });

          const labels = pr.labels.map((l) => l.name).join(", ");
          const assignees = pr.assignees.map((a) => a.login).join(", ");
          const reviewers = pr.requestedReviewers.map((r) => r.login).join(", ");

          const parts = [
            `## Pull Request #${pr.number}: ${pr.title}`,
            "",
            `**State:** ${pr.state}${pr.draft ? " (Draft)" : ""}${pr.merged ? " (Merged)" : ""}`,
            `**Author:** ${pr.user.login}`,
            `**Branch:** ${pr.head.ref} → ${pr.base.ref}`,
            `**Created:** ${pr.createdAt}`,
            `**Updated:** ${pr.updatedAt}`,
          ];

          if (labels) {
            parts.push(`**Labels:** ${labels}`);
          }
          if (assignees) {
            parts.push(`**Assignees:** ${assignees}`);
          }
          if (reviewers) {
            parts.push(`**Reviewers Requested:** ${reviewers}`);
          }

          parts.push(
            "",
            `**Changes:** +${pr.additions} / -${pr.deletions} (${pr.changedFiles} files)`,
            "",
            "### Description",
            pr.body ?? "_No description provided_",
            "",
            `**URL:** ${pr.htmlUrl}`
          );

          return { text: parts.join("\n") };
        }

        const labels = issue.labels.map((l) => l.name).join(", ");
        const assignees = issue.assignees.map((a) => a.login).join(", ");

        const parts = [
          `## Issue #${issue.number}: ${issue.title}`,
          "",
          `**State:** ${issue.state}${issue.stateReason ? ` (${issue.stateReason})` : ""}`,
          `**Author:** ${issue.user.login}`,
          `**Created:** ${issue.createdAt}`,
          `**Updated:** ${issue.updatedAt}`,
          `**Comments:** ${issue.comments}`,
        ];

        if (labels) {
          parts.push(`**Labels:** ${labels}`);
        }
        if (assignees) {
          parts.push(`**Assignees:** ${assignees}`);
        }
        if (issue.milestone) {
          parts.push(`**Milestone:** ${issue.milestone.title}`);
        }

        parts.push(
          "",
          "### Description",
          issue.body ?? "_No description provided_",
          "",
          `**URL:** ${issue.htmlUrl}`
        );

        return { text: parts.join("\n") };
      } catch {
        return {
          text: `Issue/PR #${issueNumber} not found in ${config.owner}/${config.repo}`,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return { text: `Unable to fetch issue context: ${errorMessage}` };
    }
  },
};

export default issueContextProvider;
