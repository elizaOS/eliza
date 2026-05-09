/**
 * Handler logic for the START_CODING_TASK action.
 *
 * handleMultiAgent() handles both multi-agent and single-agent modes.
 * A single-agent call is just a length-1 agent spec.
 *
 * @module actions/coding-task-handlers
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type ActionResult,
  getTrajectoryContext,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  type State,
  type UUID,
} from "@elizaos/core";
import type { AgentCredentials, ApprovalPreset } from "coding-agent-adapters";
import { buildOpencodeSpawnConfig } from "../services/agent-credentials.js";
import type { AgentSelectionStrategy } from "../services/agent-selection.js";
import { readConfigEnvKey } from "../services/config-env.js";
import type { PTYService } from "../services/pty-service.js";
import { getCoordinator } from "../services/pty-service.js";
import {
  type CodingAgentType,
  isOpencodeAgentType,
  isPiAgentType,
  normalizeAgentType,
  type SessionInfo,
  toOpencodeCommand,
  toPiCommand,
} from "../services/pty-types.js";
import { diagnoseWorkspaceBootstrapFailure } from "../services/repo-input.js";
import {
  createSkillSessionAllowList,
  ensureSkillCallbackBridge,
  type SkillSessionAllowList,
} from "../services/skill-callback-bridge.js";
import {
  LIFEOPS_CONTEXT_BROKER_MANIFEST_ENTRY,
  LIFEOPS_CONTEXT_BROKER_SLUG,
  withLifeOpsContextBrokerRecommendation,
} from "../services/skill-lifeops-context-broker.js";
import {
  buildSkillsManifest,
  type SkillsManifestResult,
} from "../services/skill-manifest.js";
import {
  type RecommendedSkill,
  recommendSkillsForTask,
} from "../services/skill-recommender.js";
import { withTrajectoryContext } from "../services/trajectory-context.js";
import {
  formatPastExperience,
  queryPastExperience,
} from "../services/trajectory-feedback.js";
import type { CodingWorkspaceService } from "../services/workspace-service.js";
import {
  createScratchDir,
  generateLabel,
  registerSessionEvents,
} from "./coding-task-helpers.js";
import { mergeTaskThreadEvalMetadata } from "./eval-metadata.js";

/** Maximum number of agents that can be spawned in a single multi-agent call */
const MAX_CONCURRENT_AGENTS = 8;

/** Known agent type prefixes used in "agentType:task" spec format. */
const KNOWN_AGENT_PREFIXES = [
  "claude",
  "claude-code",
  "claudecode",
  "codex",
  "openai",
  "gemini",
  "google",
  "aider",
  "pi",
  "pi-coding-agent",
  "picodingagent",
  "opencode",
  "open-code",
  "opencodeagent",
  "shell",
  "bash",
] as const;

const SHELL_COMMAND_RE =
  /(?:^|[:\s])(?:awk|bun|cat|curl|cut|echo|find|gh|git|grep|head|jq|node|npm|sed|tail|tee|tr|xargs|yarn)\b\s+(?:[-./~"'({[<>&|]|https?:\/\/|\w+=|\w+\.(?:cjs|css|html|js|json|md|mjs|ts|tsx|yaml|yml)\b|\b(?:add|build|commit|diff|exec|fetch|install|log|pull|push|rebase|run|show|status|test)\b)/;

function getMessageUserId(message: Memory): string | undefined {
  const value = (message as Memory & { userId?: unknown }).userId;
  return typeof value === "string" ? value : undefined;
}

function isShellPipelineBoundary(
  left: string,
  right: string,
  line: string,
): boolean {
  const trimmedLine = line.trim();
  if (/^\|.*\|$/.test(trimmedLine)) return true;

  const leftTrimmed = left.trim();
  const rightTrimmed = right.trim();
  if (!leftTrimmed || !rightTrimmed) return false;

  const leftLooksShell =
    SHELL_COMMAND_RE.test(leftTrimmed) ||
    /[`$;]|\$\(|\b[A-Z][A-Z0-9_]*=/.test(leftTrimmed);
  const rightStartsShell =
    /^(?:awk|bun|cat|curl|cut|echo|find|gh|git|grep|head|jq|node|npm|sed|tail|tee|tr|xargs|yarn)\b/.test(
      rightTrimmed,
    );
  return leftLooksShell && rightStartsShell;
}

/**
 * Split the planner's optional multi-agent string without treating shell
 * pipelines in a single task recipe as agent delimiters.
 */
export function splitAgentSpecsParam(input: string): string[] {
  const specs: string[] = [];
  let segmentStart = 0;
  let lineStart = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;

  const push = (end: number) => {
    const segment = input.slice(segmentStart, end).trim();
    if (segment) specs.push(segment);
  };

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const prev = i > 0 ? input[i - 1] : "";

    if (char === "\n") {
      lineStart = i + 1;
      continue;
    }

    if (
      char === "'" &&
      !inDouble &&
      !inBacktick &&
      !(/[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(input[i + 1] ?? ""))
    ) {
      inSingle = !inSingle;
      continue;
    }
    if (char === '"' && !inSingle && !inBacktick && prev !== "\\") {
      inDouble = !inDouble;
      continue;
    }
    if (char === "`" && !inSingle && !inDouble && prev !== "\\") {
      inBacktick = !inBacktick;
      continue;
    }

    if (char !== "|" || inSingle || inDouble || inBacktick) {
      continue;
    }

    const lineEnd = input.indexOf("\n", i);
    const line = input.slice(
      lineStart,
      lineEnd === -1 ? input.length : lineEnd,
    );
    if (
      isShellPipelineBoundary(
        input.slice(segmentStart, i),
        input.slice(i + 1, lineEnd === -1 ? input.length : lineEnd),
        line,
      )
    ) {
      continue;
    }

    push(i);
    segmentStart = i + 1;
  }

  push(input.length);
  return specs;
}

/** Filename written into each spawned agent's workspace listing parent skills. */
const SKILLS_MANIFEST_FILENAME = "SKILLS.md";

/**
 * Shared registry that maps spawned PTY session IDs to the recommended-skills
 * allow-list for that spawn. Created once at module load; the skill-callback
 * bridge reads from it when a child emits a USE_SKILL directive, and the
 * multi-agent spawn loop registers entries after `recommendSkillsForTask`.
 *
 * Entries must be cleared explicitly on session teardown to avoid leaks;
 * `registerSessionEvents` owns that responsibility.
 */
const sessionSkillAllowList: SkillSessionAllowList =
  createSkillSessionAllowList();

export function getSkillSessionAllowList(): SkillSessionAllowList {
  return sessionSkillAllowList;
}

interface PreparedSkillAwareness {
  manifestPath: string;
  recommendations: RecommendedSkill[];
  manifest: SkillsManifestResult;
}

interface LaunchFailureReport {
  label: string;
  agentType: string;
  error?: string;
}

const LAUNCH_FAILURE_CONTEXT_CHARS = 3000;
const LAUNCH_FAILURE_ACTION_HISTORY_CHARS = 2500;
const LAUNCH_FAILURE_ERRORS_CHARS = 2000;

function truncateForPrompt(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 15).trimEnd()}\n...[truncated]`;
}

function indent(value: string, prefix: string): string {
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function formatUnknownForPrompt(value: unknown, indent = 0): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const formatted = formatUnknownForPrompt(item, indent + 2);
        return `${pad}- ${formatted.replace(/\n/g, `\n${pad}  `)}`;
      })
      .join("\n");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => {
        const formatted = formatUnknownForPrompt(entry, indent + 2);
        return formatted.includes("\n")
          ? `${pad}${key}:\n${formatted}`
          : `${pad}${key}: ${formatted}`;
      })
      .join("\n");
  }
  return String(value);
}

function stringifyPromptValue(value: unknown, maxChars: number): string {
  if (typeof value === "string") {
    return truncateForPrompt(value.trim(), maxChars);
  }
  if (value === undefined || value === null) {
    return "";
  }
  return truncateForPrompt(formatUnknownForPrompt(value), maxChars);
}

function formatCharacterBio(bio: unknown): string {
  if (Array.isArray(bio)) {
    return bio
      .map((line) => (typeof line === "string" ? line.trim() : ""))
      .filter(Boolean)
      .join("\n");
  }
  return typeof bio === "string" ? bio.trim() : "";
}

function getActionHistoryForFailure(state: State | undefined): string {
  const promptedActionResults = stringifyPromptValue(
    state?.values?.actionResults,
    LAUNCH_FAILURE_ACTION_HISTORY_CHARS,
  );
  if (promptedActionResults) return promptedActionResults;

  const recentActionResults = stringifyPromptValue(
    state?.values?.recentActionResults,
    LAUNCH_FAILURE_ACTION_HISTORY_CHARS,
  );
  if (recentActionResults) return recentActionResults;

  const actionResults = state?.data?.actionResults;
  if (!Array.isArray(actionResults) || actionResults.length === 0) {
    return "No action history available.";
  }

  const lines = actionResults.slice(-5).map((result, index) => {
    const actionName =
      typeof result?.data?.actionName === "string"
        ? result.data.actionName
        : `action ${index + 1}`;
    const status = result.success === false ? "failed" : "succeeded";
    const output =
      typeof result.text === "string" && result.text.trim().length > 0
        ? ` Output: ${result.text.trim()}`
        : "";
    const error =
      result.error instanceof Error
        ? ` Error: ${result.error.message}`
        : typeof result.error === "string" && result.error.trim().length > 0
          ? ` Error: ${result.error.trim()}`
          : "";
    return `${actionName} - ${status}.${output}${error}`;
  });

  return truncateForPrompt(
    lines.join("\n"),
    LAUNCH_FAILURE_ACTION_HISTORY_CHARS,
  );
}

async function getRecentConversationForFailure(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
): Promise<string> {
  const promptedRecentMessages = stringifyPromptValue(
    state?.values?.recentMessages,
    LAUNCH_FAILURE_CONTEXT_CHARS,
  );
  if (promptedRecentMessages) return promptedRecentMessages;

  try {
    const memories = await runtime.getMemories({
      roomId: message.roomId,
      limit: 8,
      tableName: "messages",
    });
    const lines = [...memories]
      .reverse()
      .map((memory) => {
        const content =
          memory.content && typeof memory.content === "object"
            ? (memory.content as { text?: string; type?: string })
            : null;
        if (!content?.text || content.type === "action_result") return "";
        const speaker =
          memory.entityId === runtime.agentId
            ? (runtime.character.name ?? "agent")
            : "user";
        return `${speaker}: ${content.text}`;
      })
      .filter(Boolean);
    if (lines.length > 0) {
      return truncateForPrompt(lines.join("\n"), LAUNCH_FAILURE_CONTEXT_CHARS);
    }
  } catch (err) {
    logger.warn(
      `[START_CODING_TASK] Failed to load recent conversation for launch failure message: ${err}`,
    );
  }

  const messageText =
    typeof message.content?.text === "string"
      ? message.content.text.trim()
      : "";
  return messageText
    ? `user: ${truncateForPrompt(messageText, LAUNCH_FAILURE_CONTEXT_CHARS)}`
    : "No recent conversation available.";
}

function buildDeterministicLaunchFailureMessage(
  runtime: IAgentRuntime,
  failures: LaunchFailureReport[],
  totalAgents: number,
): string {
  const characterName = runtime.character.name?.trim() || "I";
  const firstError = failures[0]?.error?.trim() || "the launcher failed";
  const target =
    failures.length === 1
      ? `"${failures[0]?.label ?? "the agent"}"`
      : `${failures.length}/${totalAgents} agents`;
  return `${characterName}: I could not launch ${target} because ${firstError}.`;
}

async function generateLaunchFailureUserMessage(
  ctx: CodingTaskContext,
  failures: LaunchFailureReport[],
  totalAgents: number,
): Promise<string> {
  const { runtime, message, state } = ctx;
  const characterName = runtime.character.name?.trim() || "Agent";
  const characterBio = formatCharacterBio(runtime.character.bio);
  const recentConversation = await getRecentConversationForFailure(
    runtime,
    message,
    state,
  );
  const actionHistory = getActionHistoryForFailure(state);
  const errors = truncateForPrompt(
    failures
      .map((failure, index) => {
        const error = failure.error?.trim() || "unknown launch error";
        return `${index + 1}. ${failure.label} (${failure.agentType}): ${error}`;
      })
      .join("\n"),
    LAUNCH_FAILURE_ERRORS_CHARS,
  );

  const prompt = [
    "task: launch_failure_user_message",
    `characterName: ${characterName}`,
    "inputs:",
    `  characterBio: ${characterBio || "none"}`,
    "  recentConversation: |",
    indent(recentConversation, "    "),
    "  actionHistory: |",
    indent(actionHistory, "    "),
    "  launchErrors: |",
    indent(errors, "    "),
    "rules:",
    "  voice: use character voice and conversation context",
    "  explain: plain language without stack trace",
    "  preserveBlocker: keep concrete blocker such as missing CLI intact",
    "  length: 1-3 short sentences",
    "  disallow: internal failed-to-launch wording; claims task ran or completed",
    "output: user-facing message only",
  ].join("\n");

  try {
    const result = await withTrajectoryContext(
      runtime,
      { source: "orchestrator", decisionType: "launch-failure-message" },
      () =>
        runtime.useModel(ModelType.TEXT_SMALL, {
          prompt,
          temperature: 0.4,
          stream: false,
        }),
    );
    const text = result?.trim();
    if (text) return text;
  } catch (err) {
    logger.warn(
      `[START_CODING_TASK] Failed to generate launch failure user message: ${err}`,
    );
  }

  return buildDeterministicLaunchFailureMessage(runtime, failures, totalAgents);
}

/**
 * Compute per-task skill recommendations, render SKILLS.md into the workspace,
 * and return the absolute manifest path so the spawned agent can find it via
 * ELIZA_SKILLS_MANIFEST.
 *
 * Returns null only when no installed or task-scoped skills are available —
 * a legitimate state that should not block task spawn.
 */
async function prepareSkillAwareness(
  runtime: IAgentRuntime,
  workdir: string,
  taskText: string,
  taskKind: string | undefined,
  repo: string | undefined,
): Promise<PreparedSkillAwareness | null> {
  const recommendations = await recommendSkillsForTask(runtime, {
    taskText,
    taskKind,
    repoContext: repo ? { framework: repo } : undefined,
    max: 5,
  });
  const taskRecommendations = withLifeOpsContextBrokerRecommendation(
    taskText,
    recommendations,
  );
  const recommendedSlugs = taskRecommendations.map((rec) => rec.slug);
  const includeLifeOpsBroker = recommendedSlugs.includes(
    LIFEOPS_CONTEXT_BROKER_SLUG,
  );
  const manifest = await buildSkillsManifest(runtime, {
    onlyEligible: true,
    recommendedSlugs,
    virtualSkills: includeLifeOpsBroker
      ? [LIFEOPS_CONTEXT_BROKER_MANIFEST_ENTRY]
      : undefined,
  });

  if (manifest.slugs.length === 0 && taskRecommendations.length === 0) {
    return null;
  }

  const manifestPath = path.join(workdir, SKILLS_MANIFEST_FILENAME);
  await fs.writeFile(manifestPath, manifest.markdown, "utf8");
  return { manifestPath, recommendations: taskRecommendations, manifest };
}

/**
 * Append a recommended-skills hint to the task description that the spawned
 * agent receives. The agent already gets the full SKILLS.md via path, but
 * surfacing slugs in the prompt makes the suggestion impossible to miss.
 */
function decorateTaskWithSkillHint(
  taskBody: string,
  awareness: PreparedSkillAwareness | null,
  manifestPath: string | null,
): string {
  if (!awareness || awareness.recommendations.length === 0) {
    return taskBody;
  }
  const slugList = awareness.recommendations
    .map((rec) => `\`${rec.slug}\``)
    .join(", ");
  const lines = [
    taskBody,
    "",
    "--- Skills available in the parent agent ---",
    `Recommended for this task: ${slugList}.`,
  ];
  if (manifestPath) {
    lines.push(
      `See ${SKILLS_MANIFEST_FILENAME} in the workspace root (also at \`${manifestPath}\`) for the full list and invocation protocol.`,
    );
  }
  if (
    awareness.recommendations.some(
      (rec) => rec.slug === LIFEOPS_CONTEXT_BROKER_SLUG,
    )
  ) {
    lines.push(
      `For LifeOps context, ask the parent with \`USE_SKILL lifeops-context {"category":"email|calendar|inbox|priority|contacts|documents|search|context","query":"...","limit":5}\`.`,
    );
  }
  lines.push("--- End skills ---");
  return lines.join("\n");
}

/**
 * Trajectory logger surface we depend on. We resolve it via getService rather
 * than importing the @elizaos/core annotateActiveTrajectoryStep helper —
 * not every pinned core version in the elizaOS-plugins matrix exposes that
 * helper, while annotateStep on the trajectory service has been stable.
 */
interface TrajectoryAnnotator {
  annotateStep?: (params: {
    stepId: string;
    usedSkills?: string[];
  }) => Promise<void> | void;
}

/**
 * Annotate the active trajectory step with the skill slugs that were
 * recommended for this spawn. No-op when there is no active trajectory or
 * when the trajectory logger does not implement annotateStep.
 */
async function recordSkillRecommendationOnTrajectory(
  runtime: IAgentRuntime,
  awareness: PreparedSkillAwareness | null,
): Promise<void> {
  if (!awareness || awareness.recommendations.length === 0) return;

  const stepId = getTrajectoryContext()?.trajectoryStepId;
  if (typeof stepId !== "string" || stepId.trim() === "") {
    return;
  }

  const annotator = runtime.getService("trajectories") as
    | TrajectoryAnnotator
    | null
    | undefined;
  if (!annotator || typeof annotator.annotateStep !== "function") {
    return;
  }

  await annotator.annotateStep({
    stepId,
    usedSkills: awareness.recommendations.map((rec) => rec.slug),
  });
}

/**
 * Strip an agent-type prefix from a spec string (e.g. "claude:Fix the bug" → "Fix the bug").
 * Returns the original string if no known prefix is found.
 */
function stripAgentPrefix(spec: string): string {
  const colonIdx = spec.indexOf(":");
  if (colonIdx <= 0 || colonIdx >= 20) return spec;
  const prefix = spec.slice(0, colonIdx).trim().toLowerCase();
  if ((KNOWN_AGENT_PREFIXES as readonly string[]).includes(prefix)) {
    return spec.slice(colonIdx + 1).trim();
  }
  return spec;
}

/**
 * Build CLAUDE.md instructions that tell a swarm agent how to coordinate.
 * Each agent gets awareness of its role within the swarm and instructions
 * to surface design decisions explicitly so the orchestrator can share them.
 */
function buildSwarmMemoryInstructions(
  agentLabel: string,
  agentTask: string,
  allSubtasks: string[],
  agentIndex: number,
): string {
  const siblingTasks = allSubtasks
    .filter((_, i) => i !== agentIndex)
    .map((t, i) => `  ${i + 1}. ${t}`)
    .join("\n");

  return (
    `# Swarm Coordination\n\n` +
    `You are agent "${agentLabel}" in a multi-agent swarm of ${allSubtasks.length} agents.\n` +
    `Your task: ${agentTask}\n\n` +
    `Other agents are working on:\n${siblingTasks}\n\n` +
    `## Coordination Rules\n\n` +
    `- **Follow the Shared Context exactly.** The planning brief above contains ` +
    `concrete decisions (names, file paths, APIs, conventions). Use them as-is.\n` +
    `- **Surface design decisions.** If you need to make a creative or architectural ` +
    `choice not covered by the Shared Context (naming something, choosing a library, ` +
    `designing an interface, picking an approach), state your decision clearly in your ` +
    `output so the orchestrator can share it with sibling agents. Write it as:\n` +
    `  "DECISION: [brief description of what you decided and why]"\n` +
    `- **Don't contradict sibling work.** If the orchestrator tells you about decisions ` +
    `other agents have made, align with them.\n` +
    `- **Ask when uncertain.** If your task depends on another agent's output and you ` +
    `don't have enough context, ask rather than guessing.\n`
  );
}

/**
 * Generate a shared context brief for a swarm of agents.
 * The LLM produces shared guidance (style, conventions, constraints) from
 * the user's request and subtask list. Task-type agnostic — works for coding,
 * research, writing, or any multi-agent workflow.
 *
 * `roomId` (optional) injects the last few room messages so the planner can
 * resolve pronouns and references back to earlier turns. Without it, a prompt
 * like "make a shrine for her" gets the planner guessing the antecedent and
 * defaulting to the bot's brand identity instead of the actual referent from
 * the prior turn.
 */
async function generateSwarmContext(
  runtime: IAgentRuntime,
  subtasks: string[],
  userRequest: string,
  roomId?: UUID,
): Promise<string> {
  let recentConversation = "";
  if (roomId) {
    try {
      const memories = await runtime.getMemories({
        roomId,
        limit: 10,
        tableName: "messages",
      });
      const ordered = [...memories].reverse();
      const lines = ordered
        .map((m) => {
          const text = (m.content as { text?: string }).text;
          if (!text) return "";
          const speaker = m.entityId === runtime.agentId ? "agent" : "user";
          const trimmed = text.length > 400 ? `${text.slice(0, 400)}...` : text;
          return `${speaker}: ${trimmed}`;
        })
        .filter(Boolean);
      if (lines.length > 0) {
        recentConversation = `\n\nRecent conversation in this room (oldest first), use it to resolve pronouns and references in the user's request:\n${lines.join("\n")}\n`;
      }
    } catch (err) {
      logger.warn(`Swarm context: recent-messages fetch failed: ${err}`);
    }
  }

  const prompt = [
    "task: swarm_shared_context",
    `agentCount: ${subtasks.length}`,
    "userRequest: |",
    indent(userRequest, "  "),
    recentConversation
      ? ["recentConversation: |", indent(recentConversation.trim(), "  ")].join(
          "\n",
        )
      : "recentConversation: none",
    `subtasks[${subtasks.length}]:`,
    ...subtasks.map((subtask, index) => `  ${index + 1}: ${subtask}`),
    "briefRequirements:",
    "  length: 3-10 bullet points",
    "  include: project intent, constraints, conventions, dependencies, shared decisions",
    "  specificity: actionable, not generic",
    "creativeDecisionRule: make naming, API, file path, function signature, and approach decisions now when needed",
    "parallelismRule: do not leave consistency-critical choices to individual parallel agents",
    "output: bullet points only, no preamble",
  ].join("\n");

  try {
    // Disable streaming so planning output doesn't pipe to the user's chat.
    // The action handler runs inside a streaming context; without stream:false,
    // the planning LLM response would be forwarded as chat text.
    const result = await withTrajectoryContext(
      runtime,
      { source: "orchestrator", decisionType: "swarm-context-generation" },
      () =>
        runtime.useModel(ModelType.TEXT_SMALL, {
          prompt,
          temperature: 0.3,
          stream: false,
        }),
    );
    return result?.trim() || "";
  } catch (err) {
    logger.warn(`Swarm context generation failed: ${err}`);
    return "";
  }
}

/** Shared context passed to both multi-agent and single-agent handlers */
export interface CodingTaskContext {
  runtime: IAgentRuntime;
  ptyService: PTYService;
  wsService: CodingWorkspaceService | undefined;
  credentials: AgentCredentials;
  customCredentials: Record<string, string> | undefined;
  callback: HandlerCallback | undefined;
  message: Memory;
  state: State | undefined;
  repo: string | undefined;
  defaultAgentType: CodingAgentType;
  rawAgentType: string;
  agentTypeExplicit: boolean;
  agentSelectionStrategy: AgentSelectionStrategy;
  memoryContent: string | undefined;
  approvalPreset: string | undefined;
  explicitLabel: string | undefined;
  /**
   * Optional caller-supplied custom validator spec. Forwarded verbatim into
   * the task's session metadata so the swarm decision loop can resolve and
   * invoke it after the child claims `done`. Shape matches
   * `CustomValidatorSpec` in `services/custom-validator-runner.ts`.
   */
  validator?: {
    service: string;
    method: string;
    params: Record<string, unknown>;
  };
  /** Optional override for ELIZA_APP_VERIFICATION_MAX_RETRIES. */
  maxRetries?: number;
  /** Optional verdict-fail behavior. Defaults to "retry". */
  onVerificationFail?: "retry" | "escalate";
  /**
   * Optional originating roomId — when set, persisted onto session metadata
   * so the verification-room-bridge can post the verdict back to the right
   * chat room. Set by APP.create / PLUGIN.create dispatchers.
   */
  originRoomId?: string;
}

/**
 * Multi-agent mode handler.
 *
 * Parses pipe-delimited agent specs and spawns each agent in its own
 * workspace clone (or scratch directory).
 */
export async function handleMultiAgent(
  ctx: CodingTaskContext,
  agentsParam: string,
): Promise<ActionResult | undefined> {
  const {
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
    agentTypeExplicit,
    memoryContent,
    approvalPreset,
    explicitLabel,
  } = ctx;

  // Parse pipe-delimited agent specs: "task1 | task2 | agentType:task3"
  // A single empty string means "spawn one agent with no initial task".
  const agentSpecs = splitAgentSpecsParam(agentsParam);

  // If nothing parsed (e.g. empty string), treat as one agent with no task
  if (agentSpecs.length === 0) {
    agentSpecs.push("");
  }

  // Cap multi-agent count to the concurrency limit
  if (agentSpecs.length > MAX_CONCURRENT_AGENTS) {
    if (callback) {
      await callback({
        text: `Too many agents requested (${agentSpecs.length}). Maximum is ${MAX_CONCURRENT_AGENTS}.`,
      });
    }
    return { success: false, error: "TOO_MANY_AGENTS" };
  }

  if (repo && !wsService) {
    if (callback) {
      await callback({
        text: "Workspace Service is not available. Cannot clone repository.",
      });
    }
    return { success: false, error: "WORKSPACE_SERVICE_UNAVAILABLE" };
  }

  // Skip the spawn callback — the LLM REPLY already says "on it" (character
  // prompt ack rule) and the task-progress-streamer delivers the final
  // result. Emitting "Launching N agents..." here duplicates the ack.

  // Install the child→parent USE_SKILL bridge once per runtime. Idempotent —
  // subsequent task spawns are no-ops. Pass the module-level session allow-
  // list so the bridge can reject directives for non-recommended slugs.
  ensureSkillCallbackBridge({
    runtime,
    ptyService,
    sessionAllowList: sessionSkillAllowList,
  });

  // Planning phase: generate shared context brief for multi-agent coordination.
  // Strip agent-type prefixes from specs to get clean subtask descriptions.
  const cleanSubtasks = agentSpecs.map(stripAgentPrefix);
  const userRequest =
    (message.content as { text?: string })?.text ?? agentsParam;
  const swarmContext =
    agentSpecs.length > 1
      ? await generateSwarmContext(
          runtime,
          cleanSubtasks,
          userRequest,
          message.roomId,
        )
      : "";

  // Store swarm context on coordinator for use in decision prompts
  if (swarmContext) {
    const coordinator = getCoordinator(runtime);
    coordinator?.setSwarmContext(swarmContext);
  }

  // Query past orchestrator experience for trajectory feedback injection.
  // This feeds lessons from previous agent sessions back into new agents,
  // preventing repeated mistakes and maintaining consistency with past decisions.
  const pastExperience = await queryPastExperience(runtime, {
    taskDescription: userRequest,
    lookbackHours: 48,
    maxEntries: 8,
    repo,
  });
  const pastExperienceBlock = formatPastExperience(pastExperience);

  const results: Array<{
    sessionId: string;
    agentType: string;
    workdir: string;
    workspaceId?: string;
    branch?: string;
    label: string;
    status: string;
    error?: string;
  }> = [];

  // Read LLM provider once before the spawn loop to avoid repeated sync I/O
  // and ensure consistent provider selection across all agents in this swarm.
  const llmProvider =
    readConfigEnvKey("PARALLAX_LLM_PROVIDER") || "subscription";

  const coordinator = getCoordinator(runtime);
  const threadTitle = explicitLabel || generateLabel(repo, userRequest);
  const evalMetadata = mergeTaskThreadEvalMetadata(message, {
    repo: repo ?? null,
    messageId: message.id,
    requestedAgents: agentSpecs.length,
  });
  const taskThread = coordinator
    ? await coordinator.createTaskThread({
        title: threadTitle,
        originalRequest: userRequest,
        roomId: message.roomId,
        worldId: message.worldId,
        ownerUserId: getMessageUserId(message) ?? message.entityId,
        scenarioId: evalMetadata.scenarioId,
        batchId: evalMetadata.batchId,
        currentPlan:
          swarmContext && cleanSubtasks.length > 1
            ? {
                sharedContext: swarmContext,
                subtasks: cleanSubtasks,
              }
            : { subtasks: cleanSubtasks },
        metadata: evalMetadata.metadata,
      })
    : null;
  const plannedAgents = await Promise.all(
    agentSpecs.map(async (spec, i) => {
      let specAgentType = defaultAgentType;
      let specPiRequested = isPiAgentType(rawAgentType);
      let specOpencodeRequested = isOpencodeAgentType(rawAgentType);
      let specRequestedType = rawAgentType;
      let specTask = spec;
      let hasExplicitPrefix = false;
      const colonIdx = spec.indexOf(":");
      if (
        ctx.agentSelectionStrategy !== "fixed" &&
        colonIdx > 0 &&
        colonIdx < 20
      ) {
        const prefix = spec.slice(0, colonIdx).trim().toLowerCase();
        if ((KNOWN_AGENT_PREFIXES as readonly string[]).includes(prefix)) {
          hasExplicitPrefix = true;
          specRequestedType = prefix;
          specPiRequested = isPiAgentType(prefix);
          specOpencodeRequested = isOpencodeAgentType(prefix);
          specAgentType = normalizeAgentType(prefix);
          specTask = spec.slice(colonIdx + 1).trim();
        }
      } else if (
        ctx.agentSelectionStrategy === "fixed" &&
        colonIdx > 0 &&
        colonIdx < 20
      ) {
        specTask = stripAgentPrefix(spec);
      }

      const specLabel = explicitLabel
        ? `${explicitLabel}-${i + 1}`
        : generateLabel(repo, specTask);

      if (!agentTypeExplicit && !hasExplicitPrefix) {
        specRequestedType = await ptyService.resolveAgentType({
          task: specTask,
          repo,
          subtaskCount: agentSpecs.length,
        });
        specPiRequested = isPiAgentType(specRequestedType);
        specOpencodeRequested = isOpencodeAgentType(specRequestedType);
        specAgentType = normalizeAgentType(specRequestedType);
      }

      return {
        specAgentType,
        specPiRequested,
        specOpencodeRequested,
        specRequestedType,
        specTask,
        specLabel,
      };
    }),
  );

  const graphPlan =
    coordinator && taskThread
      ? await coordinator.planTaskThreadGraph({
          threadId: taskThread.id,
          title: threadTitle,
          originalRequest: userRequest,
          sharedContext: swarmContext || undefined,
          subtasks: plannedAgents.map((agent) => ({
            label: agent.specLabel,
            originalTask: agent.specTask,
            agentType: agent.specAgentType,
            repo,
          })),
        })
      : null;

  for (const [i, plannedAgent] of plannedAgents.entries()) {
    const {
      specAgentType,
      specPiRequested,
      specOpencodeRequested,
      specRequestedType,
      specTask,
      specLabel,
    } = plannedAgent;
    const taskNodeId = graphPlan?.workerNodes[i]?.id;
    let failureStage: "workspace" | "preflight" | "spawn" | "register" =
      "workspace";

    try {
      // Provision workspace (each agent gets its own clone or scratch dir)
      let workdir: string;
      let workspaceId: string | undefined;
      let branch: string | undefined;

      if (repo && wsService) {
        const workspace = await wsService.provisionWorkspace({ repo });
        workdir = workspace.path;
        workspaceId = workspace.id;
        branch = workspace.branch;
        wsService.setLabel(workspace.id, specLabel);
      } else {
        workdir = createScratchDir(runtime, specLabel);
      }

      // Preflight check
      failureStage = "preflight";
      if (
        specAgentType !== "shell" &&
        !specPiRequested &&
        !specOpencodeRequested
      ) {
        const [preflight] = await ptyService.checkAvailableAgents([
          specAgentType as Exclude<
            CodingAgentType,
            "shell" | "pi" | "opencode"
          >,
        ]);
        if (preflight && !preflight.installed) {
          results.push({
            sessionId: "",
            agentType: specAgentType,
            workdir,
            label: specLabel,
            status: "failed",
            error: `${preflight.adapter} CLI is not installed`,
          });
          continue;
        }
      }

      // Skill awareness: render SKILLS.md, recommend top skills for this
      // spec, and surface them in both the workspace and the prompt.
      const skillAwareness = await prepareSkillAwareness(
        runtime,
        workdir,
        specTask || userRequest,
        undefined,
        repo,
      );
      await recordSkillRecommendationOnTrajectory(runtime, skillAwareness);

      // Check if coordinator is active — route blocking prompts through it
      // Spawn the agent — prepend shared context brief if available
      const taskWithContext = swarmContext
        ? `${specTask}\n\n--- Shared Context (from project planning) ---\n${swarmContext}\n--- End Shared Context ---`
        : specTask;
      const taskWithSkills = decorateTaskWithSkillHint(
        taskWithContext,
        skillAwareness,
        skillAwareness?.manifestPath ?? null,
      );
      const initialTask = specPiRequested
        ? toPiCommand(taskWithSkills)
        : specOpencodeRequested
          ? toOpencodeCommand(taskWithSkills)
          : taskWithSkills;
      const displayType = specPiRequested
        ? "pi"
        : specOpencodeRequested
          ? "opencode"
          : specAgentType;

      // Append swarm coordination instructions to agent memory so the agent
      // knows to surface design decisions explicitly for the orchestrator.
      const swarmMemory =
        agentSpecs.length > 1 && swarmContext
          ? buildSwarmMemoryInstructions(specLabel, specTask, cleanSubtasks, i)
          : undefined;
      const agentMemory =
        [memoryContent, swarmMemory, pastExperienceBlock]
          .filter(Boolean)
          .join("\n\n") || undefined;
      const coordinatorManagedSession =
        !!coordinator && llmProvider === "subscription";
      const useDirectCallbackResponses = Boolean(callback);

      failureStage = "spawn";
      const skillEnv: Record<string, string> = skillAwareness
        ? { ELIZA_SKILLS_MANIFEST: skillAwareness.manifestPath }
        : {};
      if (specOpencodeRequested) {
        const opencodeSpawnConfig = buildOpencodeSpawnConfig(runtime);
        if (!opencodeSpawnConfig) {
          results.push({
            sessionId: "",
            agentType: displayType,
            workdir,
            label: specLabel,
            status: "failed",
            error:
              "OpenCode is selected but no model provider is configured. " +
              "Set PARALLAX_LLM_PROVIDER=cloud and pair an Eliza Cloud key, " +
              "or set PARALLAX_OPENCODE_LOCAL=1 to use a local OpenAI-compatible model server.",
          });
          continue;
        }
        skillEnv.OPENCODE_CONFIG_CONTENT = opencodeSpawnConfig.configContent;
        skillEnv.OPENCODE_DISABLE_AUTOUPDATE = "1";
        skillEnv.OPENCODE_DISABLE_TERMINAL_TITLE = "1";
        logger.info(
          `[start-coding-task] OpenCode provider: ${opencodeSpawnConfig.providerLabel} (model=${opencodeSpawnConfig.model})`,
        );
      }
      const finalSkillEnv =
        Object.keys(skillEnv).length > 0 ? skillEnv : undefined;
      const session: SessionInfo = await ptyService.spawnSession({
        name: `coding-${Date.now()}-${i}`,
        agentType: specAgentType,
        workdir,
        initialTask,
        memoryContent: agentMemory,
        credentials,
        approvalPreset:
          (approvalPreset as ApprovalPreset | undefined) ??
          ptyService.defaultApprovalPreset,
        customCredentials,
        ...(finalSkillEnv ? { env: finalSkillEnv } : {}),
        ...(coordinatorManagedSession ? { skipAdapterAutoResponse: true } : {}),
        metadata: {
          threadId: taskThread?.id,
          taskNodeId,
          requestedType: specRequestedType,
          messageId: message.id,
          userId: getMessageUserId(message),
          workspaceId,
          label: specLabel,
          multiAgentIndex: i,
          // Carry the originating message routing context so deployments can
          // post async session updates back to the originating channel.
          roomId: message.roomId,
          worldId: message.worldId,
          source: (message.content as { source?: string } | undefined)?.source,
        },
      });

      // Register this session's recommended-skills allow-list so the skill
      // callback bridge can reject out-of-scope USE_SKILL directives.
      if (skillAwareness && skillAwareness.recommendations.length > 0) {
        sessionSkillAllowList.register(
          session.id,
          skillAwareness.recommendations.map((rec) => rec.slug),
        );
      }

      // Register event handler
      const isScratch = !repo;
      const scratchDir = isScratch ? workdir : null;
      // Pass coordinatorActive=false so the session event handler uses the
      // DIRECT callback path for chat responses. The coordinator still monitors
      // lifecycle via its own subscriptions — this only affects who sends the
      // "done" message to discord. When coordinatorActive=true, the coordinator
      // generates the reply from originalTask (the user's text), producing the
      // "done — <echo of user message>" bug. When false, registerSessionEvents
      // pulls data.response (the subagent's ACTUAL output) and sends that.
      registerSessionEvents(
        ptyService,
        runtime,
        session.id,
        specLabel,
        scratchDir,
        callback,
        coordinatorManagedSession && !useDirectCallbackResponses,
        sessionSkillAllowList,
      );
      if (coordinator && specTask) {
        failureStage = "register";
        const baseMetadata =
          session.metadata &&
          typeof session.metadata === "object" &&
          !Array.isArray(session.metadata)
            ? (session.metadata as Record<string, unknown>)
            : {};
        // Merge caller-supplied verification policy onto the task's session
        // metadata so the swarm decision loop can read it after the child
        // claims `done`. Backward-compatible: when none are set we pass the
        // original metadata object through unchanged (or `undefined`) and
        // the existing LLM `validateTaskCompletion` flow runs as before.
        const verificationMeta: Record<string, unknown> = {};
        if (ctx.validator) verificationMeta.validator = ctx.validator;
        if (typeof ctx.maxRetries === "number") {
          verificationMeta.maxRetries = ctx.maxRetries;
        }
        if (ctx.onVerificationFail) {
          verificationMeta.onVerificationFail = ctx.onVerificationFail;
        }
        if (ctx.originRoomId) {
          verificationMeta.originRoomId = ctx.originRoomId;
        }
        const mergedMetadata =
          Object.keys(verificationMeta).length > 0
            ? { ...baseMetadata, ...verificationMeta }
            : Object.keys(baseMetadata).length > 0
              ? baseMetadata
              : undefined;
        await coordinator.registerTask(session.id, {
          threadId: taskThread?.id ?? session.id,
          taskNodeId,
          agentType: specAgentType,
          label: specLabel,
          originalTask: specTask,
          workdir,
          repo,
          metadata: mergedMetadata,
        });
      }

      results.push({
        sessionId: session.id,
        agentType: displayType,
        workdir,
        workspaceId,
        branch,
        label: specLabel,
        status: session.status,
      });

      // Per-agent spawn chatter removed. The streamer reports the final
      // result; the intermediate "[1/N] Spawned ..." messages are noise.
    } catch (error) {
      const rawErrorMessage =
        error instanceof Error ? error.message : String(error);
      const errorMessage =
        repo && failureStage === "workspace"
          ? `${rawErrorMessage}. ${diagnoseWorkspaceBootstrapFailure(
              repo,
              rawErrorMessage,
            )}`
          : rawErrorMessage;
      logger.error(
        `[START_CODING_TASK] Failed to spawn agent ${i + 1}:`,
        errorMessage,
      );
      results.push({
        sessionId: "",
        agentType: specAgentType,
        workdir: "",
        label: specLabel,
        status: "failed",
        error: errorMessage,
      });
    }
  }

  // Store all sessions in state
  if (state) {
    state.codingSessions = results.filter((r) => r.sessionId);
  }

  const failed = results.filter((r) => !r.sessionId);

  // Only surface spawn outcomes in chat on failure — the synthesis
  // callback delivers the actual subagent answer when the task finishes.
  // ActionResult.text must stay empty on success because the bootstrap
  // runtime auto-forwards a non-empty `text` to the user's channel when
  // the handler didn't emit its own callback (see
  // packages/core/src/services/message.ts action-result routing).
  if (failed.length > 0) {
    const failureMessage = await generateLaunchFailureUserMessage(
      ctx,
      failed,
      agentSpecs.length,
    );
    if (callback) {
      await callback({ text: failureMessage });
    }
    return {
      success: false,
      text: failureMessage,
      data: { agents: results, suppressActionResultClipboard: true },
    };
  }

  return {
    success: true,
    text: "",
    data: { agents: results, suppressActionResultClipboard: true },
  };
}
