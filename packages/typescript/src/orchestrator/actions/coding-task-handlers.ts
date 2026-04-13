/**
 * Handler logic for the START_CODING_TASK action.
 *
 * handleMultiAgent() handles both multi-agent and single-agent modes.
 * A single-agent call is just a length-1 agent spec.
 *
 * @module actions/coding-task-handlers
 */

import {
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  type State,
} from "@elizaos/core";
import type { AgentCredentials, ApprovalPreset } from "coding-agent-adapters";
import type { AgentSelectionStrategy } from "../services/agent-selection.ts";
import { readConfigEnvKey } from "../services/config-env.ts";
import type { PTYService } from "../services/pty-service.ts";
import { getCoordinator } from "../services/pty-service.ts";
import { diagnoseWorkspaceBootstrapFailure } from "../services/repo-input.ts";
import {
  type CodingAgentType,
  isPiAgentType,
  normalizeAgentType,
  type SessionInfo,
  toPiCommand,
} from "../services/pty-types.ts";
import { withTrajectoryContext } from "../services/trajectory-context.ts";
import {
  formatPastExperience,
  queryPastExperience,
} from "../services/trajectory-feedback.ts";
import type { CodingWorkspaceService } from "../services/workspace-service.ts";
import {
  createScratchDir,
  generateLabel,
  registerSessionEvents,
} from "./coding-task-helpers.ts";
import { mergeTaskThreadEvalMetadata } from "./eval-metadata.ts";

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
  "pi-ai",
  "piai",
  "pi-coding-agent",
  "picodingagent",
  "shell",
  "bash",
] as const;

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
 */
async function generateSwarmContext(
  runtime: IAgentRuntime,
  subtasks: string[],
  userRequest: string,
): Promise<string> {
  const taskList = subtasks.map((t, i) => `  ${i + 1}. ${t}`).join("\n");

  const prompt =
    `You are an AI orchestrator about to launch ${subtasks.length} parallel agents. ` +
    `Before they start, produce a brief shared context document so all agents stay aligned.\n\n` +
    `User's request: "${userRequest}"\n\n` +
    `Subtasks being assigned:\n${taskList}\n\n` +
    `Generate a concise shared context brief (3-10 bullet points) covering:\n` +
    `- Project intent and overall goal\n` +
    `- Key constraints or preferences from the user's request\n` +
    `- Conventions all agents should follow (naming, style, patterns, tone)\n` +
    `- How subtasks relate to each other (dependencies, shared interfaces, etc.)\n` +
    `- Any decisions that should be consistent across all agents\n\n` +
    `CRITICAL — Concrete Decisions:\n` +
    `If any subtask involves creative choices (naming a feature, choosing an approach, ` +
    `designing an API, picking a concept), YOU must make those decisions NOW in this brief. ` +
    `Do NOT leave creative choices to individual agents — they run in parallel and will ` +
    `each make different choices, causing inconsistency.\n` +
    `For example: if one agent builds a feature and another writes tests for it, ` +
    `decide the feature name, file paths, function signatures, and key design choices here ` +
    `so both agents use the same names and structure.\n\n` +
    `Only include what's relevant — skip categories that don't apply. ` +
    `Be specific and actionable, not generic. Be as detailed as the task requires — ` +
    `a trivial task needs a few bullets, a complex task deserves a thorough roadmap.\n\n` +
    `Output ONLY the bullet points, no preamble.`;

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
  const agentSpecs = agentsParam
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);

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
  // result. Emitting "Launching N agents..." here duplicates the ack and
  // spams discord. See eliza nubs/full-working-state clean Discord UX fix.

  // Planning phase: generate shared context brief for multi-agent coordination.
  // Strip agent-type prefixes from specs to get clean subtask descriptions.
  const cleanSubtasks = agentSpecs.map(stripAgentPrefix);
  const userRequest =
    (message.content as { text?: string })?.text ?? agentsParam;
  const swarmContext =
    agentSpecs.length > 1
      ? await generateSwarmContext(runtime, cleanSubtasks, userRequest)
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
        ownerUserId:
          ((message as unknown as Record<string, unknown>).userId as
            | string
            | undefined) ?? message.entityId,
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
  const plannedAgents = await Promise.all(agentSpecs.map(async (spec, i) => {
    let specAgentType = defaultAgentType;
    let specPiRequested = isPiAgentType(rawAgentType);
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
      specAgentType = normalizeAgentType(specRequestedType);
    }

    return {
      specAgentType,
      specPiRequested,
      specRequestedType,
      specTask,
      specLabel,
    };
  }));

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
      if (specAgentType !== "shell" && specAgentType !== "pi") {
        const [preflight] = await ptyService.checkAvailableAgents([
          specAgentType as Exclude<CodingAgentType, "shell" | "pi">,
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

      // Check if coordinator is active — route blocking prompts through it
      // Spawn the agent — prepend shared context brief if available
      const taskWithContext = swarmContext
        ? `${specTask}\n\n--- Shared Context (from project planning) ---\n${swarmContext}\n--- End Shared Context ---`
        : specTask;
      const initialTask = specPiRequested
        ? toPiCommand(taskWithContext)
        : taskWithContext;
      const displayType = specPiRequested ? "pi" : specAgentType;

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
        ...(coordinatorManagedSession ? { skipAdapterAutoResponse: true } : {}),
        metadata: {
          threadId: taskThread?.id,
          taskNodeId,
          requestedType: specRequestedType,
          messageId: message.id,
          userId: (message as unknown as Record<string, unknown>).userId,
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
      );
      if (coordinator && specTask) {
        failureStage = "register";
        await coordinator.registerTask(session.id, {
          threadId: taskThread?.id ?? session.id,
          taskNodeId,
          agentType: specAgentType,
          label: specLabel,
          originalTask: specTask,
          workdir,
          repo,
          metadata:
            session.metadata &&
            typeof session.metadata === "object" &&
            !Array.isArray(session.metadata)
              ? (session.metadata as Record<string, unknown>)
              : undefined,
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
      const errorMessage = repo && failureStage === "workspace"
        ? `${rawErrorMessage}. ${diagnoseWorkspaceBootstrapFailure(
            repo,
            rawErrorMessage,
          )}`
        : rawErrorMessage;
      logger.error(
        `[START_CODING_TASK] Failed to spawn agent ${i + 1}:`,
        errorMessage,
      );
      if (callback) {
        await callback({
          text:
            `[${i + 1}/${agentSpecs.length}] Failed to launch "${specLabel}". ` +
            errorMessage,
        });
      }
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

  const succeeded = results.filter((r) => r.sessionId);
  const failed = results.filter((r) => !r.sessionId);
  const summary = [
    `Launched ${succeeded.length}/${agentSpecs.length} agents${repo ? ` on ${repo}` : ""}:`,
    ...succeeded.map(
      (r) => `  - "${r.label}" (${r.agentType}) [session: ${r.sessionId}]`,
    ),
    ...(failed.length > 0
      ? [`Failed: ${failed.map((r) => `"${r.label}": ${r.error}`).join(", ")}`]
      : []),
  ].join("\n");

  // The final summary is suppressed from chat in favor of the
  // task-progress-streamer, which delivers the actual subagent answer.
  // We still include `summary` in the ActionResult.text so programmatic
  // consumers (tests, logs) see the full detail.
  if (callback && failed.length > 0) {
    await callback({ text: summary });
  }

  return {
    success: failed.length === 0,
    text: summary,
    data: { agents: results },
  };
}
