/**
 * START_CODING_TASK action to set up and launch task agents.
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
} from "../services/agent-credentials.js";
import type { CustomValidatorSpec } from "../services/custom-validator-runner.js";
import type { PTYService } from "../services/pty-service.js";
import { getCoordinator } from "../services/pty-service.js";
import { normalizeAgentType } from "../services/pty-types.js";
import { normalizeRepositoryInput } from "../services/repo-input.js";
import { looksLikeTaskAgentRequest } from "../services/task-agent-frameworks.js";
import { requireTaskAgentAccess } from "../services/task-policy.js";
import type { CodingWorkspaceService } from "../services/workspace-service.js";
import {
  type CodingTaskContext,
  handleMultiAgent,
  splitAgentSpecsParam,
} from "./coding-task-handlers.js";

/**
 * Caller-supplied retry policy for the custom validator path. Stored on
 * the task's session metadata under `validator` / `maxRetries` /
 * `onVerificationFail` so the decision loop can read it after completion.
 */
export type OnVerificationFail = "retry" | "escalate";

function normalizeValidatorSpec(value: unknown): CustomValidatorSpec | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.service !== "string" || v.service.trim().length === 0) {
    return null;
  }
  if (typeof v.method !== "string" || v.method.trim().length === 0) {
    return null;
  }
  const params =
    v.params && typeof v.params === "object" && !Array.isArray(v.params)
      ? (v.params as Record<string, unknown>)
      : {};
  return {
    service: v.service,
    method: v.method,
    params,
  };
}

function normalizeOnVerificationFail(
  value: unknown,
): OnVerificationFail | null {
  return value === "retry" || value === "escalate" ? value : null;
}

function normalizeMaxRetries(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

/**
 * Loose validator for an `originRoomId` string. Accepts any non-empty string
 * (UUIDs, agent IDs, channel slugs) and rejects empty/whitespace/non-string
 * values. The dispatcher controls this value (sourced from `message.roomId`),
 * so no further validation runs in the bridge — the trust chain is
 * dispatcher → orchestrator → bridge with no attacker-controlled hop.
 */
function normalizeOriginRoomId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function hasExplicitTaskPayload(message: Memory): boolean {
  const content =
    message.content && typeof message.content === "object"
      ? (message.content as Record<string, unknown>)
      : null;
  if (!content) {
    return false;
  }

  return (
    typeof content.task === "string" ||
    typeof content.repo === "string" ||
    typeof content.workdir === "string" ||
    typeof content.agents === "string" ||
    typeof content.agentType === "string"
  );
}

function getMessageText(message: Memory): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  return typeof message.content?.text === "string" ? message.content.text : "";
}

/**
 * Detect prompts that belong to LifeOps (LIFE action), not the coding
 * orchestrator. Mirror of `looksLikeCodingTaskRequest` in app-lifeops, so
 * START_CODING_TASK can decline when LIFE should win.
 *
 * Why: LIFE and START_CODING_TASK share a lot of verb surface ("add a task ...",
 * "create a reminder ..."). The action-selector LLM can pick START_CODING_TASK when
 * a coding keyword appears anywhere in the prompt (e.g. "add a todo to fix
 * that PR"), spawning a subagent for something LIFE should handle as a simple
 * todo insert.
 *
 * Pattern: imperative LIFE verb at the start followed by a LIFE noun within
 * the first few words. Keeps false positives rare: "build a todo app" has
 * verb=build (not in list) so it still routes to START_CODING_TASK as intended.
 */
function looksLikeLifeOpsRequest(text: string | undefined | null): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return false;
  return /^(?:@\S+\s+)?(?:add|set|schedule|remind|track|log)\b[^.!?]{0,40}\b(todo|habit|reminder|goal|routine|alarm|chore|tasks?\s+for\s+(?:today|tomorrow|this\s+week))\b/i.test(
    normalized,
  );
}

/**
 * Detect natural-language prose vs. a bare shell command.
 *
 * Why: the action-planner LLM occasionally fills agentType with "shell"/"pi"
 * for short prompts even though the task text is full natural language. Piping
 * prose into /bin/bash produces "command not found" spam; the subagent then
 * fails its first turn and the SwarmCoordinator assessor is left trying to
 * unstick it. Shell agents are only sane when initialTask is already a bare
 * command (e.g. `df -h`, `git status`).
 *
 * Heuristic:
 *   - short strings with no whitespace that look like a single token → command
 *   - anything containing a natural-language article ("a/an/the"), multiple
 *     clause words, or > 5 whitespace-separated words → prose
 *
 * Tuned to be conservative: short commands like "df -h" or "git status -s"
 * stay shell; "check disk usage on this vps" or "add a todo" route to a
 * reasoning agent.
 */
function looksLikeProseTask(text: string | undefined | null): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  const words = trimmed.split(/\s+/);
  if (words.length > 5) return true;
  if (/\b(a|an|the|this|that|please|my|your|our)\b/i.test(trimmed)) {
    return true;
  }
  if (/[?!]/.test(trimmed)) return true;
  if (/\w\.(?:\s|$)/.test(trimmed)) return true;
  return false;
}

/**
 * When the action-selector LLM trims a multi-clause user prompt down to a
 * single imperative `task`, the rest of the user text is dropped — e.g.
 * "read /etc/timezone, then also tell me X" gets reduced to "read
 * /etc/timezone" and the secondary clause never reaches the subagent.
 * Reconstruct a brief that preserves the full user intent while still
 * letting the planner-extracted task lead.
 *
 * Returns `extractedTask` unchanged when:
 *   - userText is empty (programmatic spawn, no user message)
 *   - userText is shorter or equal to extractedTask (the planner just
 *     cleaned up casing/grammar — no information is lost)
 *   - extractedTask is a substring of userText (the "extraction" was a
 *     noop and userText alone carries everything)
 *
 * Otherwise returns a two-section brief: the planner-extracted task as the
 * imperative header, and the full user message preserved for context the
 * planner trimmed.
 */
export function preserveUserPromptInTask(
  extractedTask: string,
  userText: string,
): string {
  const task = (extractedTask ?? "").trim();
  const raw = (userText ?? "").trim();
  if (!raw) return task;
  if (raw.length <= task.length) return task;
  if (raw.toLowerCase().includes(task.toLowerCase())) return raw;
  return `${task}\n\n# Full user message (preserved — may contain context the action-selector trimmed)\n\n${raw}`;
}

/**
 * Split a multi-intent task description into one segment per distinct ask.
 * Matches numbered lists (`1. ...`, `2) ...`) and bullets (`- ...`, `* ...`).
 * Returns the original text as a single-element array when no multi-intent
 * structure is detected, so the call site can always pipe-join unconditionally.
 *
 * Rationale: the action-selector LLM consistently puts multi-ask user prompts
 * into the `task` field instead of `agents`. The result is a subagent that
 * cherry-picks one item and silently drops the rest. Auto-splitting here
 * guarantees every distinct ask gets its own subagent regardless of which
 * field the LLM populated.
 */
export function splitMultiIntentTask(text: string): string[] {
  if (!text) return [text];
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const numbered: string[] = [];
  for (const line of lines) {
    const match = line.match(/^(\d+)[.):]\s+(.+)$/);
    if (match) {
      numbered.push(match[2]);
    } else if (numbered.length > 0 && !/^\d+[.):]/.test(line)) {
      numbered[numbered.length - 1] =
        `${numbered[numbered.length - 1]} ${line}`;
    }
  }
  if (numbered.length >= 2) return numbered;

  const bulleted = lines
    .filter((l) => /^[-*•]\s+/.test(l))
    .map((l) => l.replace(/^[-*•]\s+/, ""));
  if (bulleted.length >= 2) return bulleted;

  return [text];
}

/**
 * Reject a shell/pi/bash agentType hint when the task text is prose, so both
 * START_CODING_TASK and SPAWN_AGENT upgrade to a reasoning framework via
 * `resolveAgentType`. Returns the sanitized hint (original value or `undefined`
 * if it was rejected). `callerTag` is the [PREFIX] string used when warning
 * so the log line points at the actual callsite.
 */
export function coerceShellAgentTypeForProse(
  explicitRawType: string | undefined,
  taskText: string | undefined | null,
  callerTag: string,
): string | undefined {
  if (
    explicitRawType &&
    /^(shell|pi|bash)$/i.test(explicitRawType.trim()) &&
    looksLikeProseTask(taskText)
  ) {
    logger.warn(
      `${callerTag} ignoring agentType="${explicitRawType}": task text is prose, upgrading to default reasoning framework`,
    );
    return undefined;
  }
  return explicitRawType;
}

type BackgroundAction = Action & {
  suppressPostActionContinuation?: boolean;
};

const START_CODING_TASK_ACTION_NAME = "START_CODING_TASK";

export const startCodingTaskAction: BackgroundAction = {
  name: START_CODING_TASK_ACTION_NAME,
  contexts: ["code", "files", "tasks", "automation"],
  contextGate: { anyOf: ["code", "files", "tasks", "automation"] },
  roleGate: { minRole: "USER" },

  similes: [
    "CREATE_TASK",
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
    "before calling this action. Do not default to a scratch directory for real project work.",
  descriptionCompressed:
    "Spawn async task agents for multi-step jobs: code, debug, research, write, analyze. Auto-provisions workspace from repo URL.",

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
          action: START_CODING_TASK_ACTION_NAME,
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
          action: START_CODING_TASK_ACTION_NAME,
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Can you implement a quicksort algorithm? Can you also analyze this CSV and generate some charts? And can you draft a one-page doc summarizing both for me?",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "on it",
          action: START_CODING_TASK_ACTION_NAME,
          agents:
            "implement a quicksort algorithm in typescript with tests | analyze the user's CSV and generate charts (matplotlib or similar) | draft a one-page doc summarizing the quicksort implementation and the CSV findings",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "ok answers:\n1. quicksort: typescript with a unit test\n2. notes: pull from /tmp/notes.md, summarize back to me\n3. revenue chart: bar chart of the csv I sent earlier\n4. market research: focus on companies + funding\n\ndo all 4 in parallel",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "spawning 4",
          action: START_CODING_TASK_ACTION_NAME,
          agents:
            "implement quicksort in typescript with a small unit test | summarize the markdown file at /tmp/notes.md and report the summary | take the previously provided csv and generate a bar chart of revenue by day | research the market: list companies and their funding/revenue",
        },
      },
    ],
  ],

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const ptyService = runtime.getService("PTY_SERVICE") as unknown as
      | PTYService
      | undefined;
    if (!ptyService) {
      return false;
    }

    if (hasExplicitTaskPayload(message)) {
      return true;
    }

    const text = getMessageText(message).trim();
    if (text.length === 0) {
      return true;
    }

    // LifeOps prompts ("add a todo to fix that PR I made yesterday") share
    // verb surface with START_CODING_TASK similes. Decline so LIFE wins.
    if (looksLikeLifeOpsRequest(text)) {
      return false;
    }

    return looksLikeTaskAgentRequest(text);
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

    // Shell/pi/bash agents pipe initialTask straight to /bin/bash. When the
    // LLM picks them for a prose prompt the subagent dies on turn 1 with
    // "command not found" spam. Reject the hint and let resolveAgentType
    // pick a reasoning framework instead. (Shared with SPAWN_AGENT.)
    const explicitRawType = coerceShellAgentTypeForProse(
      (params?.agentType as string | undefined) ??
        (content.agentType as string | undefined),
      (params?.task as string) ??
        (content.task as string) ??
        (content.text as string),
      "[START_CODING_TASK]",
    );
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
        subtaskCount:
          typeof (params?.agents as string) === "string" ||
          typeof (content.agents as string) === "string"
            ? ((params?.agents as string) ?? (content.agents as string))
                .split("|")
                .map((value) => value.trim())
                .filter(Boolean).length || 1
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

    // Optional caller-supplied verification policy. Specialized creators
    // (APP.create, PLUGIN.create, etc.) pass a `validator` spec so the
    // orchestrator defers to their disk-aware verifier instead of running
    // the generic LLM `validateTaskCompletion` pass. `maxRetries` and
    // `onVerificationFail` shape the retry-with-feedback loop. All three
    // are forwarded verbatim into the task's session metadata so the
    // swarm decision loop can read them after the child claims `done`.
    const validator =
      normalizeValidatorSpec(params?.validator) ??
      normalizeValidatorSpec(content.validator);
    const maxRetries =
      normalizeMaxRetries(params?.maxRetries) ??
      normalizeMaxRetries(content.maxRetries);
    const onVerificationFail =
      normalizeOnVerificationFail(params?.onVerificationFail) ??
      normalizeOnVerificationFail(content.onVerificationFail);
    // Optional roomId where the verification verdict should be posted back.
    // Specialized creators carry it under `parameters.metadata.originRoomId`
    // (planner-friendly nested shape) or directly on the message content.
    // Persisted onto session metadata so plugin-app-control's
    // verification-room-bridge can find it when filtering broadcast events.
    const paramsMetadata =
      params?.metadata &&
      typeof params.metadata === "object" &&
      !Array.isArray(params.metadata)
        ? (params.metadata as Record<string, unknown>)
        : null;
    const contentMetadata =
      content.metadata &&
      typeof content.metadata === "object" &&
      !Array.isArray(content.metadata)
        ? (content.metadata as Record<string, unknown>)
        : null;
    const originRoomId =
      normalizeOriginRoomId(paramsMetadata?.originRoomId) ??
      normalizeOriginRoomId(contentMetadata?.originRoomId);

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
      ...(validator ? { validator } : {}),
      ...(maxRetries !== null ? { maxRetries } : {}),
      ...(onVerificationFail ? { onVerificationFail } : {}),
      ...(originRoomId ? { originRoomId } : {}),
    };

    // Dispatch: build a pipe-delimited agents string for handleMultiAgent.
    // Always run the multi-intent splitter against the raw user text, then
    // use the LARGER of (LLM-supplied `agents`, user-text split). The
    // action-selector LLM both (a) rewrites multi-ask prompts into a
    // single-item `task` and (b) populates `agents` with fewer segments
    // than the user enumerated, dropping items it judged less actionable.
    // Trusting either field as-is silently loses the dropped asks; the
    // user text is the source of truth for how many distinct items there
    // are.
    const task = (params?.task as string) ?? (content.task as string);
    const userText = (content.text as string)?.trim() || "";
    const agentsParam =
      (params?.agents as string) ?? (content.agents as string);

    const llmSegments = agentsParam ? splitAgentSpecsParam(agentsParam) : [];
    const userSegments = splitMultiIntentTask(userText);

    if (userSegments.length > llmSegments.length && userSegments.length > 1) {
      logger.info(
        `[START_CODING_TASK] auto-split multi-intent user prompt into ${userSegments.length} parallel agents (LLM proposed ${llmSegments.length})`,
      );
      return handleMultiAgent(ctx, userSegments.join(" | "));
    }
    if (agentsParam) {
      return handleMultiAgent(ctx, agentsParam);
    }
    return handleMultiAgent(
      ctx,
      preserveUserPromptInTask(task, userText) || userText,
    );
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
        "Specific reasoning task-agent framework to use. Options: claude, codex, gemini, aider. " +
        "If omitted, the orchestrator picks the current preferred framework automatically. " +
        "Do NOT select 'shell' or 'pi' here: those are non-reasoning raw bash sessions " +
        "that cannot interpret natural-language tasks; leave this unset and the orchestrator " +
        "routes to the preferred reasoning framework.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "task",
      description:
        "The open-ended task or prompt to send once the task agent is ready. Used for single-agent " +
        "mode ONLY. If the user message contains more than one distinct ask (numbered list, bulleted " +
        "list, 'and also', 'in parallel', or any phrasing that enumerates several things to do), do " +
        "NOT use `task` — use `agents` with one pipe-separated segment per distinct ask. Putting " +
        "multi-intent content in `task` causes the subagent to cherry-pick one item and silently " +
        "drop the rest.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "agents",
      description:
        "Pipe-delimited list of task-agent assignments for multi-agent mode. Each segment is a task description. " +
        "Optionally prefix with an agent type: 'claude:Fix auth | gemini:Write tests | codex:Update docs'. " +
        "Each task agent gets its own workspace clone. If provided, the 'task' parameter is ignored. " +
        "USE THIS when the user message contains multiple distinct asks in one prompt — bullets, " +
        "numbered list, or 'can you... can you also...' phrasing. Map every distinct ask to one " +
        "pipe-separated segment so each request gets its own subagent. Never silently drop any of " +
        "the asks in favor of just one.",
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
    {
      name: "validator",
      description:
        "Optional custom verification spec: { service, method, params }. " +
        "When set, the orchestrator calls runtime.getService(service)[method](params) " +
        "after the child claims `done` instead of running the generic LLM validator. " +
        "The service must return { verdict: 'pass' | 'fail', retryablePromptForChild }.",
      required: false,
      schema: { type: "object" as const },
    },
    {
      name: "maxRetries",
      description:
        "Optional override for ELIZA_APP_VERIFICATION_MAX_RETRIES (default 3). " +
        "Caps how many times the orchestrator will replay the failure prompt to the child " +
        "before escalating to the user.",
      required: false,
      schema: { type: "integer" as const, minimum: 0 },
    },
    {
      name: "onVerificationFail",
      description:
        "Optional behavior for a failed custom validator verdict: 'retry' (default) " +
        "replays the validator's retryablePromptForChild up to maxRetries times, " +
        "'escalate' surfaces the failure to the user immediately.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["retry", "escalate"],
      },
    },
    {
      name: "metadata",
      description:
        "Optional caller-supplied metadata persisted onto the task's session record. " +
        "Currently recognized keys: `originRoomId` — the roomId where the verification " +
        "result should be posted back when this task completes; used by plugin-app-control's " +
        "verification-room-bridge.",
      required: false,
      schema: { type: "object" as const },
    },
  ],
};

export const createTaskAction = startCodingTaskAction;
