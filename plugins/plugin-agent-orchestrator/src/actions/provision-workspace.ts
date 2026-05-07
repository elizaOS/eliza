/**
 * PROVISION_WORKSPACE action - Create a git workspace for coding tasks
 *
 * Clones a repository or creates a worktree for isolated development.
 * Useful for setting up a clean environment before spawning a coding agent.
 *
 * @module actions/provision-workspace
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { requireTaskAgentAccess } from "../services/task-policy.js";
import type {
  CodingWorkspaceService,
  WorkspaceResult,
} from "../services/workspace-service.js";

const PROVISION_WORKSPACE_TIMEOUT_MS = 60_000;
const WORKSPACE_PATH_MAX_CHARS = 500;

export const provisionWorkspaceAction: Action = {
  name: "PROVISION_WORKSPACE",
  contexts: ["code", "files", "tasks", "automation"],
  contextGate: { anyOf: ["code", "files", "tasks", "automation"] },
  roleGate: { minRole: "USER" },

  similes: [
    "CREATE_WORKSPACE",
    "CLONE_REPO",
    "SETUP_WORKSPACE",
    "PREPARE_WORKSPACE",
  ],

  description:
    "Create a git workspace for coding tasks. " +
    "Can clone a repository or create a git worktree for isolated development.",
  descriptionCompressed:
    "create git workspace cod task clone repository create git worktree isolat development",

  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Clone the repo and create a workspace for the feature",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll set up a workspace for you.",
          action: "PROVISION_WORKSPACE",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Create a worktree for the bug fix" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Creating an isolated worktree for the bug fix.",
          action: "PROVISION_WORKSPACE",
        },
      },
    ],
  ],

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
  ): Promise<boolean> => {
    const workspaceService = runtime.getService(
      "CODING_WORKSPACE_SERVICE",
    ) as unknown as CodingWorkspaceService | undefined;
    return workspaceService != null;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const access = await requireTaskAgentAccess(runtime, message, "create");
    if (!access.allowed) {
      if (callback) {
        await callback({
          text: access.reason,
        });
      }
      return { success: false, error: "FORBIDDEN", text: access.reason };
    }

    const workspaceService = runtime.getService(
      "CODING_WORKSPACE_SERVICE",
    ) as unknown as CodingWorkspaceService | undefined;
    if (!workspaceService) {
      if (callback) {
        await callback({
          text: "Workspace Service is not available.",
        });
      }
      return { success: false, error: "SERVICE_UNAVAILABLE" };
    }

    const content = message.content as {
      text?: string;
      repo?: string;
      baseBranch?: string;
      useWorktree?: boolean;
      parentWorkspaceId?: string;
    };

    // Try to extract repo URL from text if not provided explicitly
    let repo = content.repo;
    if (!repo && content.text) {
      // Match GitHub/GitLab/Bitbucket URLs
      const urlMatch = content.text.match(
        /https?:\/\/(?:github\.com|gitlab\.com|bitbucket\.org)\/[\w.-]+\/[\w.-]+(?:\.git)?/i,
      );
      if (urlMatch) {
        repo = urlMatch[0];
      }
    }

    if (!repo && !content.useWorktree) {
      if (callback) {
        await callback({
          text: "Please specify a repository URL or use worktree mode with a parent workspace.",
        });
      }
      return { success: false, error: "MISSING_REPO" };
    }

    // Validate repo URL against allowed domains
    if (repo) {
      const ALLOWED_DOMAINS =
        /^https?:\/\/(github\.com|gitlab\.com|bitbucket\.org)\//i;
      if (!ALLOWED_DOMAINS.test(repo)) {
        if (callback) {
          await callback({
            text: "Repository URL must be from github.com, gitlab.com, or bitbucket.org.",
          });
        }
        return { success: false, error: "INVALID_REPO_DOMAIN" };
      }
    }

    // For worktree mode, need parent
    let parentWorkspaceId = content.parentWorkspaceId;
    if (content.useWorktree && !parentWorkspaceId) {
      // Try to use the current workspace from state
      if (state?.codingWorkspace) {
        parentWorkspaceId = (state.codingWorkspace as { id: string }).id;
      } else {
        if (callback) {
          await callback({
            text: "Worktree mode requires a parent workspace. Clone a repo first or specify parentWorkspaceId.",
          });
        }
        return { success: false, error: "MISSING_PARENT" };
      }
    }

    try {
      const workspace: WorkspaceResult = await Promise.race([
        workspaceService.provisionWorkspace({
          repo: repo ?? "",
          baseBranch: content.baseBranch,
          useWorktree: content.useWorktree,
          parentWorkspaceId,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Workspace provisioning timeout")), PROVISION_WORKSPACE_TIMEOUT_MS),
        ),
      ]);

      // Store workspace in state
      if (state) {
        state.codingWorkspace = {
          id: workspace.id,
          path: workspace.path.slice(0, WORKSPACE_PATH_MAX_CHARS),
          branch: workspace.branch,
          isWorktree: workspace.isWorktree,
        };
      }

      if (callback) {
        await callback({
          text:
            `Created workspace at ${workspace.path.slice(0, WORKSPACE_PATH_MAX_CHARS)}\n` +
            `Branch: ${workspace.branch}\n` +
            `Type: ${workspace.isWorktree ? "worktree" : "clone"}`,
        });
      }

      return {
        success: true,
        text: `Created workspace ${workspace.id}`,
        data: {
          workspaceId: workspace.id,
          path: workspace.path.slice(0, WORKSPACE_PATH_MAX_CHARS),
          branch: workspace.branch,
          isWorktree: workspace.isWorktree,
        },
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (callback) {
        await callback({
          text: `Failed to provision workspace: ${errorMessage}`,
        });
      }
      return { success: false, error: errorMessage };
    }
  },

  parameters: [
    {
      name: "repo",
      description: "Git repository URL to clone.",
      descriptionCompressed: "Create git workspace for coding tasks.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "baseBranch",
      description: "Base branch to create feature branch from (default: main).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "useWorktree",
      description: "Create a git worktree instead of a full clone.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "parentWorkspaceId",
      description: "Parent workspace ID for worktree creation.",
      required: false,
      schema: { type: "string" as const },
    },
  ],
};
