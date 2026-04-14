/**
 * CREATE_TASK action - Unified action to set up and launch task agents.
 *
 * Combines workspace provisioning and agent spawning into a single atomic action.
 * - If a repo URL is provided, clones it into a fresh workspace
 * - If no repo, creates a scratch sandbox directory
 * - Spawns the specified task agent(s) in that workspace with the given task
 * - Supports multi-agent mode via pipe-delimited `agents` param
 *
 * This eliminates the need for multi-action chaining (PROVISION_WORKSPACE -> SPAWN_AGENT)
 * and ensures agents always run in an isolated directory.
 *
 * @module actions/start-coding-task
 */

import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import type { AgentCredentials } from "coding-agent-adapters";
import {
  buildAgentCredentials,
  isAnthropicOAuthToken,
  sanitizeCustomCredentials,
} from "../services/agent-credentials.ts";
import type { PTYService } from "../services/pty-service.ts";
import { getCoordinator } from "../services/pty-service.ts";
import { normalizeAgentType } from "../services/pty-types.ts";
import { normalizeRepositoryInput } from "../services/repo-input.ts";
import { requireTaskAgentAccess } from "../services/task-policy.ts";
import type { CodingWorkspaceService } from "../services/workspace-service.ts";
import {
  type CodingTaskContext,
  handleMultiAgent,
} from "./coding-task-handlers.ts";

type BackgroundAction = Action & {
  suppressPostActionContinuation?: boolean;
};

export const startCodingTaskAction: BackgroundAction = {
  name: "CREATE_TASK",

  similes: [
    "START_CODING_TASK",
    "LAUNCH_CODING_TASK",
    "RUN_CODING_TASK",
    "START_AGENT_TASK",
    "SPAWN_AND_PROVISION",
    "CODE_THIS",
    "LAUNCH_TASK",
    "CREATE_SUBTASK",
  ],

  description:
    "Create one or more asynchronous task agents for any open-ended multi-step job. " +
    "These task agents can code, debug, research, write, analyze, plan, document, and automate while the main agent stays free to keep talking with the user. " +
    "If a repo URL is provided, a workspace is provisioned automatically; if no repo is provided, the task agent runs in a safe scratch directory. " +
    "Use this whenever the work is more involved than a simple direct reply. " +
    "IMPORTANT: If the user references a repository from conversation history (e.g. 'in the same repo', " +
    "'on that project', 'add a feature to it'), you MUST include the repo URL in the `repo` parameter. " +
    "If the task involves code changes to a real project but you don't know the repo URL, ASK the user for it " +
    "before calling this action — do not default to a scratch directory for real project work.",

  suppressPostActionContinuation: true,

  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Take a deep pass on https://github.com/acme/my-app: debug the auth failure, fix it, run the tests, and summarize what changed.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll create a background task agent for that repo and keep track of its progress.",
          action: "CREATE_TASK",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Spin up a couple of sub-agents to research current browser automation frameworks, compare them, and draft a recommendation.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll coordinate parallel task agents for that and keep the results organized.",
          action: "CREATE_TASK",
        },
      },
    ],
  ],

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
  ): Promise<boolean> => {
    const ptyService = runtime.getService("PTY_SERVICE") as unknown as
      | PTYService
      | undefined;
    return ptyService != null;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions,
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

    const ptyService = runtime.getService("PTY_SERVICE") as unknown as
      | PTYService
      | undefined;
    if (!ptyService) {
      if (callback) {
        await callback({
          text: "PTY Service is not available. Cannot create the task.",
        });
      }
      return { success: false, error: "SERVICE_UNAVAILABLE" };
    }

    const wsService = runtime.getService(
      "CODING_WORKSPACE_SERVICE",
    ) as unknown as CodingWorkspaceService | undefined;

    // Extract parameters
    const params = options?.parameters;
    const content = message.content as Record<string, unknown>;

    const explicitRawType =
      (params?.agentType as string) ?? (content.agentType as string);
    const memoryContent =
      (params?.memoryContent as string) ?? (content.memoryContent as string);
    const approvalPreset =
      (params?.approvalPreset as string) ?? (content.approvalPreset as string);

    // Repo is optional -- extract from params, content, or text
    let repo = (params?.repo as string) ?? (content.repo as string);
    if (!repo && content.text) {
      const urlMatch = (content.text as string).match(
        /https?:\/\/(?:github\.com|gitlab\.com|bitbucket\.org)\/[\w.-]+\/[\w.-]+(?:\.git)?/i,
      );
      if (urlMatch) {
        repo = urlMatch[0];
      }
    }

    // Fallback chain: coordinator memory → disk history → workspace service.
    // Only use these fallbacks when the request implies working on an existing
    // project (e.g. "in the same repo", "continue", "fix this") rather than a
    // fresh scratch task. The reuseRepo flag or same-project language triggers it.
    const reuseRepo =
      (params?.reuseRepo as boolean) ??
      (content.reuseRepo as boolean) ??
      // Implicit intent: task text references an existing context
      /\b(same\s+repo|same\s+project|continue|that\s+repo|the\s+repo|this\s+repo|in\s+the\s+repo)\b/i.test(
        (content.text as string) ?? "",
      );

    if (!repo && reuseRepo) {
      const coordinator = getCoordinator(runtime);
      const lastRepo = await coordinator?.getLastUsedRepoAsync();
      if (lastRepo) {
        repo = lastRepo;
      }
    }
    if (!repo && reuseRepo) {
      const wsService = runtime.getService(
        "CODING_WORKSPACE_SERVICE",
      ) as unknown as CodingWorkspaceService | undefined;
      if (wsService && typeof wsService.listWorkspaces === "function") {
        const withRepo = wsService.listWorkspaces().find((ws) => ws.repo);
        if (withRepo) {
          repo = withRepo.repo;
        }
      }
    }

    if (repo) {
      repo = normalizeRepositoryInput(repo);
    }

    const selectionTask =
      (params?.task as string) ??
      (content.task as string) ??
      (content.text as string);
    const rawAgentType =
      explicitRawType ??
      (await ptyService.resolveAgentType({
        task: selectionTask,
        repo,
        subtaskCount: typeof (params?.agents as string) === "string" ||
          typeof (content.agents as string) === "string"
          ? (((params?.agents as string) ?? (content.agents as string))
              .split("|")
              .map((value) => value.trim())
              .filter(Boolean).length || 1)
          : 1,
      }));
    const defaultAgentType = normalizeAgentType(rawAgentType);

    // Build credentials (shared across all agents)
    const customCredentialKeys = runtime.getSetting("CUSTOM_CREDENTIAL_KEYS") as
      | string
      | undefined;
    let customCredentials: Record<string, string> | undefined;
    if (customCredentialKeys) {
      customCredentials = {};
      for (const key of customCredentialKeys.split(",").map((k) => k.trim())) {
        const val = runtime.getSetting(key) as string | undefined;
        if (val) customCredentials[key] = val;
      }
    }
    const rawAnthropicKey = runtime.getSetting("ANTHROPIC_API_KEY") as
      | string
      | undefined;
    customCredentials = sanitizeCustomCredentials(
      customCredentials,
      isAnthropicOAuthToken(rawAnthropicKey) ? [rawAnthropicKey] : [],
    );

    let credentials: AgentCredentials;
    try {
      credentials = buildAgentCredentials(runtime);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to build credentials";
      logger.error(`[start-coding-task] ${msg}`);
      if (callback) {
        await callback({ text: msg });
      }
      return { success: false, error: "INVALID_CREDENTIALS" };
    }

    const explicitLabel =
      (params?.label as string) ?? (content.label as string);

    // Build shared context for handlers
    const ctx: CodingTaskContext = {
      runtime,
      ptyService,
      wsService,
      credentials,
      customCredentials,
      callback,
      message,
      state,
      repo,
      defaultAgentType,
      rawAgentType,
      agentTypeExplicit: Boolean(explicitRawType),
      agentSelectionStrategy: ptyService.agentSelectionStrategy,
      memoryContent,
      approvalPreset,
      explicitLabel,
    };

    // --- Dispatch: build a pipe-delimited agents string for handleMultiAgent ---
    const agentsParam =
      (params?.agents as string) ?? (content.agents as string);

    if (agentsParam) {
      return handleMultiAgent(ctx, agentsParam);
    }

    // Single-agent mode: build a single-element agents string so we can
    // reuse handleMultiAgent (which handles length-1 specs fine).
    // Fall back to the user's message text when params extraction fails —
    // the user's request IS the task (e.g. "build me a todo app").
    const task = (params?.task as string) ?? (content.task as string);
    const userText = (content.text as string)?.trim() || "";
    const singleAgentSpec = task || userText;
    return handleMultiAgent(ctx, singleAgentSpec);
  },

  parameters: [
    {
      name: "repo",
      description:
        "Git repository to clone (e.g. https://github.com/owner/repo or owner/repo). " +
        "ALWAYS provide this when the user is working on a real project or references a repo from context. " +
        "Only omit for pure research/scratch tasks with no target repository. " +
        "If unsure which repo, ask the user before spawning.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "agentType",
      description:
        "Specific task-agent framework to use. Options: claude, codex, gemini, aider, pi, shell. " +
        "If omitted, the orchestrator picks the current preferred framework automatically.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "task",
      description:
        "The open-ended task or prompt to send once the task agent is ready. Used for single-agent mode.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "agents",
      description:
        "Pipe-delimited list of task-agent assignments for multi-agent mode. Each segment is a task description. " +
        "Optionally prefix with an agent type: 'claude:Fix auth | gemini:Write tests | codex:Update docs'. " +
        "Each task agent gets its own workspace clone. If provided, the 'task' parameter is ignored.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "memoryContent",
      description:
        "Instructions or shared context to write to each task agent's memory file before spawning.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "label",
      description:
        "Short semantic label for this workspace. In multi-agent mode, each agent gets '{label}-1', '{label}-2', etc. " +
        "Auto-generated from repo/task if not provided.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "approvalPreset",
      description:
        "Permission level for all task agents: readonly, standard, permissive, autonomous.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["readonly", "standard", "permissive", "autonomous"],
      },
    },
  ],
};

export const createTaskAction = startCodingTaskAction;
